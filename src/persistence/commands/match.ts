/**
 * Recording commands (design §6.1–6.3, §11.3). Both revalidate inside the unit
 * of work against the state actually being written, and write the match, the
 * ledger entry (new, or extending a statement-only entry) and the audit events
 * together. Neither creates a rule.
 */
import { effectiveFields } from '../../domain/capture/fields';
import { AlreadyLinkedError, StaleProposalError, ValidationError } from '../../domain/errors';
import { ledgerId, matchId } from '../../domain/ids';
import { deriveCategory } from '../../domain/knowledge/resolve';
import { evaluateWorkspace } from '../../domain/matching/evaluate';
import { sortRefs } from '../../domain/matching/helpers';
import { checkManualResolution } from '../../domain/matching/manual';
import { revalidate } from '../../domain/matching/revalidate';
import type { MatchProposal } from '../../domain/matching/types';
import type { RuleRef } from '../../domain/primitives';
import type { ConfirmedMatch, LedgerEntry, Receipt, StatementTransaction, TraceStep } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand, type CommandContext } from './context';

export interface RecordResult {
  matchId: string;
  ledgerEntryId: string;
  extended: boolean;
}

function commitMatch(
  c: CommandContext,
  o: {
    receipt: Receipt;
    transaction: StatementTransaction;
    method: ConfirmedMatch['method'];
    reason: string | null;
    candidateIds: string[];
    identityRefs: RuleRef[];
    trace: TraceStep[];
  },
): RecordResult {
  const { receipt, transaction } = o;
  if (c.state.matches.some((m) => m.status === 'active' && m.transactionId === transaction.id)) {
    const other = c.state.matches.find((m) => m.status === 'active' && m.transactionId === transaction.id)!;
    throw new AlreadyLinkedError(transaction.id, other.subject.id);
  }
  const rules = c.activeRules();
  const policy = evaluateWorkspace(c.evaluationInput(rules)).policy;
  const category = deriveCategory(receipt, rules);
  const categoryRef = category.status === 'suggested' ? category.ruleRef : null;
  const policyRefs: RuleRef[] = policy.ref.ruleId === 'P-BASE' ? [] : [{ ruleId: policy.ref.ruleId, version: policy.ref.version }];
  const ruleRefs = sortRefs([...o.identityRefs, ...(categoryRef ? [categoryRef] : []), ...policyRefs]);

  const mId = matchId(c.next('match'));
  const existing = c.state.ledger.find(
    (e) => e.status === 'recorded' && e.identityKey === transaction.id && e.evidence.receiptIds.length === 0 && e.evidence.payableIds.length === 0,
  );
  const lId = existing ? existing.id : ledgerId(c.next('ledger'));
  const f = effectiveFields(receipt);

  const match: ConfirmedMatch = {
    schemaVersion: 1,
    workspaceId: c.workspaceId,
    id: mId,
    subject: { kind: 'receipt', id: receipt.id },
    transactionId: transaction.id,
    activeTxnKey: transaction.id,
    activeSubjectKey: `receipt:${receipt.id}`,
    status: 'active',
    method: o.method,
    reason: o.reason,
    proposalSnapshot: { candidateIds: o.candidateIds, ruleRefs, policyRef: policy.ref, engineVersion: 'match-engine/1', trace: o.trace },
    ledgerEntryId: lId,
    confirmedAt: c.at,
    confirmedBy: 'local-owner',
  };
  c.put('matches', match);

  const evidenceRefs = [
    { kind: 'receipt' as const, ref: receipt.id },
    { kind: 'transaction' as const, ref: transaction.id },
    { kind: 'source_document' as const, ref: receipt.sourceDocumentId },
  ];
  let entry: LedgerEntry;
  if (existing) {
    entry = {
      ...existing,
      evidence: {
        ...existing.evidence,
        receiptIds: [...existing.evidence.receiptIds, receipt.id],
        sourceDocumentIds: [...existing.evidence.sourceDocumentIds, receipt.sourceDocumentId],
        matchIds: [...existing.evidence.matchIds, mId],
      },
      ruleRefs: sortRefs([...existing.ruleRefs, ...ruleRefs]),
      updatedAt: c.at,
    };
  } else {
    entry = {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id: lId,
      origin: 'receipt_match',
      identityKey: transaction.id,
      activeIdentityKey: transaction.id,
      status: 'recorded',
      expenseDate: f.date ?? transaction.postingDate,
      merchantName: f.merchant ?? transaction.rawLabel,
      canonicalMerchantId: receipt.canonicalMerchantId,
      amountMinor: transaction.amountMinor,
      currency: transaction.currency,
      category: { categoryId: category.categoryId, status: category.status, ...(category.ruleRef ? { ruleRef: category.ruleRef } : {}) },
      evidence: {
        receiptIds: [receipt.id],
        transactionIds: [transaction.id],
        payableIds: [],
        sourceDocumentIds: [receipt.sourceDocumentId],
        matchIds: [mId],
      },
      ruleRefs,
      recordedAt: c.at,
      updatedAt: c.at,
    };
  }
  c.put('ledger', entry);

  c.audit({
    action: 'match.confirmed',
    affected: [
      { kind: 'match', id: mId },
      { kind: 'receipt', id: receipt.id },
      { kind: 'transaction', id: transaction.id },
    ],
    evidenceRefs,
    ruleRefs,
    reason: o.reason,
    after: { matchId: mId, transactionId: transaction.id, method: o.method, policyRef: policy.ref },
  });
  c.audit({
    action: existing ? 'ledger.evidence_attached' : 'ledger.recorded',
    affected: [
      { kind: 'ledger', id: lId },
      { kind: 'receipt', id: receipt.id },
    ],
    evidenceRefs: [...evidenceRefs, { kind: 'match', ref: mId }],
    ruleRefs,
    after: { ledgerEntryId: lId, amountMinor: entry.amountMinor, currency: entry.currency, category: entry.category },
  });
  return { matchId: mId, ledgerEntryId: lId, extended: existing !== undefined };
}

/** Revalidate a shown proposal against the state being written, then commit it. */
export function commitShownProposal(c: CommandContext, shown: MatchProposal): RecordResult {
  const check = revalidate(c.evaluationInput(), shown);
  if (!check.ok) throw new StaleProposalError(check.reason);
  const p = check.proposal;
  const receipt = c.state.receipts.find((r) => r.id === p.subject.id)!;
  const transaction = c.state.transactions.find((t) => t.id === p.transactionId)!;
  return commitMatch(c, {
    receipt,
    transaction,
    method: 'confirmed_proposal',
    reason: null,
    candidateIds: p.candidateIds,
    identityRefs: p.ruleRefs.filter((r) => r.ruleId.startsWith('K-ALIAS-')),
    trace: p.trace,
  });
}

/** "Record": confirm a ready proposal after revalidating it inside the write (§6.1, §6.3). */
export function recordProposal(repo: Repository, shown: MatchProposal): Promise<RecordResult> {
  return runCommand(repo, (c) => commitShownProposal(c, shown));
}

export interface ConfirmCaseOnlyRequest {
  receiptId: string;
  transactionId: string;
  reason: string;
}

/** "Confirm this case only": manual resolution with a reason; no rule is created (§6.2). */
export function confirmCaseOnly(repo: Repository, req: ConfirmCaseOnlyRequest): Promise<RecordResult> {
  return runCommand(repo, (c) => {
    const input = c.evaluationInput();
    const check = checkManualResolution(input, req);
    if (!check.ok) throw check.error;
    const receipt = c.state.receipts.find((r) => r.id === req.receiptId);
    const transaction = c.state.transactions.find((t) => t.id === req.transactionId);
    if (!receipt || !transaction) throw new ValidationError('NOT_FOUND', 'This case is no longer available.');
    const proposal = evaluateWorkspace(input).proposals.get(receipt.id);
    const identityRefs: RuleRef[] = [];
    if (check.value.identity === 'alias') {
      const step = proposal?.trace.find((s) => s.check === 'merchant_identity' && s.evidence.some((e) => e.ref === transaction.id) && s.ruleRef);
      if (step?.ruleRef && step.ruleRef.ruleId.startsWith('K-ALIAS-')) identityRefs.push({ ruleId: step.ruleRef.ruleId, version: step.ruleRef.version });
    }
    const candidateIds = proposal && proposal.candidateIds.length > 0 ? proposal.candidateIds : [transaction.id];
    return commitMatch(c, {
      receipt,
      transaction,
      method: 'manual_resolution',
      reason: check.value.reason,
      candidateIds,
      identityRefs,
      trace: [...(proposal?.trace ?? []), ...check.value.trace],
    });
  });
}
