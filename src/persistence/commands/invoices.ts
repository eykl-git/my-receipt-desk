/**
 * Received invoices (design §6.4, §10.3, REQ-17): My files only. An invoice is
 * added as an unpaid payable and never counts as a paid expense. "Link card
 * payment" re-checks the payment predicate inside the write and creates one
 * match and exactly one ledger entry (or extends the statement-only entry for
 * that card transaction), so the invoice is never counted twice.
 */
import { StaleProposalError, ValidationError } from '../../domain/errors';
import { ledgerId, matchId, payableId } from '../../domain/ids';
import { policyFromRules } from '../../domain/knowledge/resolve';
import { isPaymentCandidate, validatePayableInput, type PayableErrors, type PayableInput } from '../../domain/ledger/invoice';
import { LIMITS } from '../../domain/limits';
import { displayRef } from '../../domain/matching/helpers';
import { canonicalMerchantId } from '../../domain/normalize';
import { ENGINE_VERSION, type ConfirmedMatch, type LedgerEntry, type Payable } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand } from './context';
import type { ReceiptUpload } from './capture';
import { newSourceDocument } from './statements';

export const INVOICE_MESSAGES = Object.freeze({
  personalOnly: 'Invoices can only be added in My files.',
  reasonLength: `Reason must be ${LIMITS.reasonMinChars}–${LIMITS.reasonMaxChars} characters.`,
  notUnpaid: 'This invoice is already paid.',
  notCandidate: 'That card transaction can’t pay this invoice: it needs the same amount and currency, posted on or after the invoice date, and not linked to anything else.',
});

export class PayableValidationError extends ValidationError {
  readonly fieldErrors: PayableErrors;
  constructor(fieldErrors: PayableErrors) {
    super('FIELDS_INVALID', 'Check the highlighted fields. Nothing was saved.');
    this.fieldErrors = fieldErrors;
  }
}

export interface AddPayableResult {
  payableId: string | null;
  duplicateOf: string | null;
}

/** "Invoice (not yet paid)" in "Add receipts" (§10.3). The file checks and hashing ran before. */
export function addPayable(repo: Repository, upload: ReceiptUpload, input: PayableInput): Promise<AddPayableResult> {
  if (repo.workspaceId !== 'personal') return Promise.reject(new ValidationError('PERSONAL_ONLY', INVOICE_MESSAGES.personalOnly));
  const v = validatePayableInput(input);
  if (!v.ok) return Promise.reject(new PayableValidationError(v.errors));
  return runCommand(repo, (c) => {
    const known = c.state.sourceDocuments.find((d) => d.sha256 === upload.sha256);
    if (known) {
      const matched = c.state.receipts.find((r) => r.sourceDocumentId === known.id)?.id ?? c.state.payables.find((p) => p.sourceDocumentId === known.id)?.id ?? known.id;
      c.audit({
        action: 'capture.duplicate_upload_rejected',
        affected: [{ kind: matched.startsWith('INV-') ? 'payable' : 'receipt', id: matched }],
        after: { matchedId: matched, fileName: upload.fileName },
      });
      return { payableId: null, duplicateOf: matched };
    }
    const doc = newSourceDocument(c, upload, 'invoice_upload');
    const id = payableId(c.next('payable'));
    const payable: Payable = {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id,
      sourceDocumentId: doc.id,
      supplierName: v.values.supplierName,
      canonicalMerchantId: canonicalMerchantId(v.values.supplierName),
      invoiceNumber: v.values.invoiceNumber,
      invoiceDate: v.values.invoiceDate,
      amountMinor: v.values.amountMinor,
      currency: v.values.currency,
      state: 'unpaid',
      paidByMatchId: null,
    };
    c.put('payables', payable);
    c.audit({
      action: 'capture.payable_added',
      affected: [{ kind: 'payable', id }, { kind: 'source_document', id: doc.id }],
      evidenceRefs: [{ kind: 'source_document', ref: doc.id }],
      after: { fileName: upload.fileName, supplierName: payable.supplierName, amountMinor: payable.amountMinor, currency: payable.currency, invoiceDate: payable.invoiceDate },
    });
    return { payableId: id, duplicateOf: null };
  });
}

/** "Link card payment" (§6.4): payment evidence for an unpaid invoice. */
export function attachPayment(repo: Repository, payableIdValue: string, transactionId: string, reason: string): Promise<{ matchId: string; ledgerEntryId: string; extended: boolean }> {
  const text = reason.trim();
  if (text.length < LIMITS.reasonMinChars || text.length > LIMITS.reasonMaxChars) {
    return Promise.reject(new ValidationError('REASON_LENGTH', INVOICE_MESSAGES.reasonLength));
  }
  return runCommand(repo, (c) => {
    const payable = c.state.payables.find((p) => p.id === payableIdValue);
    if (!payable) throw new ValidationError('NOT_FOUND', 'This invoice no longer exists.');
    if (payable.state !== 'unpaid') throw new ValidationError('NOT_UNPAID', INVOICE_MESSAGES.notUnpaid);
    const t = c.state.transactions.find((x) => x.id === transactionId);
    if (!t) throw new ValidationError('TRANSACTION_UNKNOWN', 'That card transaction does not exist.');
    const state = { matches: c.state.matches, ledger: c.state.ledger, currency: c.state.currency };
    if (!isPaymentCandidate(payable, t, state)) {
      const taken =
        c.state.matches.some((m) => m.status === 'active' && m.transactionId === t.id) ||
        c.state.ledger.some((e) => e.status === 'recorded' && e.identityKey === t.id && (e.evidence.receiptIds.length > 0 || e.evidence.payableIds.length > 0));
      if (taken) throw new StaleProposalError('transaction_taken');
      throw new ValidationError('NOT_A_CANDIDATE', INVOICE_MESSAGES.notCandidate);
    }
    const policy = policyFromRules(c.activeRules());
    const mId = matchId(c.next('match'));
    const existing = c.state.ledger.find(
      (e) => e.status === 'recorded' && e.identityKey === t.id && e.evidence.receiptIds.length === 0 && e.evidence.payableIds.length === 0,
    );
    const lId = existing ? existing.id : ledgerId(c.next('ledger'));
    const tEv = { kind: 'transaction' as const, ref: t.id };
    const match: ConfirmedMatch = {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id: mId,
      subject: { kind: 'payable', id: payable.id },
      transactionId: t.id,
      activeTxnKey: t.id,
      activeSubjectKey: `payable:${payable.id}`,
      status: 'active',
      method: 'manual_resolution',
      reason: text,
      proposalSnapshot: {
        candidateIds: [t.id],
        ruleRefs: [],
        policyRef: policy.ref,
        engineVersion: ENGINE_VERSION,
        trace: [{ check: 'manual', result: 'info', message: `Payment of ${payable.id} confirmed by you: ${displayRef(t)}. Reason: ${text}`, evidence: [tEv] }],
      },
      ledgerEntryId: lId,
      confirmedAt: c.at,
      confirmedBy: 'local-owner',
    };
    c.put('matches', match);
    const entry: LedgerEntry = existing
      ? {
          ...existing,
          evidence: {
            ...existing.evidence,
            payableIds: [...existing.evidence.payableIds, payable.id],
            sourceDocumentIds: [...existing.evidence.sourceDocumentIds, payable.sourceDocumentId],
            matchIds: [...existing.evidence.matchIds, mId],
          },
          updatedAt: c.at,
        }
      : {
          schemaVersion: 1,
          workspaceId: c.workspaceId,
          id: lId,
          origin: 'invoice_payment',
          identityKey: t.id,
          activeIdentityKey: t.id,
          status: 'recorded',
          expenseDate: payable.invoiceDate,
          merchantName: payable.supplierName,
          canonicalMerchantId: payable.canonicalMerchantId,
          amountMinor: t.amountMinor,
          currency: t.currency,
          category: { categoryId: null, status: 'unassigned' },
          evidence: { receiptIds: [], transactionIds: [t.id], payableIds: [payable.id], sourceDocumentIds: [payable.sourceDocumentId], matchIds: [mId] },
          ruleRefs: [],
          recordedAt: c.at,
          updatedAt: c.at,
        };
    c.put('ledger', entry);
    c.put('payables', { ...payable, state: 'paid', paidByMatchId: mId });
    const evidenceRefs = [tEv, { kind: 'source_document' as const, ref: payable.sourceDocumentId }];
    c.audit({
      action: 'match.confirmed',
      affected: [{ kind: 'match', id: mId }, { kind: 'payable', id: payable.id }, { kind: 'transaction', id: t.id }],
      evidenceRefs,
      reason: text,
      after: { matchId: mId, transactionId: t.id, method: 'manual_resolution', policyRef: policy.ref },
    });
    c.audit({
      action: existing ? 'ledger.evidence_attached' : 'ledger.recorded',
      affected: [{ kind: 'ledger', id: lId }, { kind: 'payable', id: payable.id }],
      evidenceRefs: [...evidenceRefs, { kind: 'match', ref: mId }],
      after: { ledgerEntryId: lId, amountMinor: entry.amountMinor, currency: entry.currency },
    });
    c.audit({
      action: 'payable.paid',
      affected: [{ kind: 'payable', id: payable.id }, { kind: 'ledger', id: lId }],
      evidenceRefs: [{ kind: 'match', ref: mId }],
      before: { state: 'unpaid' },
      after: { state: 'paid', paidByMatchId: mId },
    });
    return { matchId: mId, ledgerEntryId: lId, extended: existing !== undefined };
  });
}
