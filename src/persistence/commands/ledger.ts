/**
 * Ledger corrections and statement-only recording (design §6.5, §6.7, §6.8,
 * REQ-7.4, REQ-7.6, REQ-7.7). Each is one unit of work; every change is an
 * explicit, audited operation. Nothing here deletes a record: a voided entry
 * and a released match stay readable as history.
 */
import { isCategoryId, type CategoryId } from '../../domain/categories';
import { ValidationError } from '../../domain/errors';
import { ledgerId } from '../../domain/ids';
import { deriveCategory } from '../../domain/knowledge/resolve';
import { LIMITS } from '../../domain/limits';
import { isHeldForDuplicateReview, sortRefs } from '../../domain/matching/helpers';
import type { RuleRef } from '../../domain/primitives';
import type { ConfirmedMatch, LedgerEntry, Payable } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand, type CommandContext } from './context';

export const LEDGER_MESSAGES = Object.freeze({
  reasonLength: `Reason must be ${LIMITS.reasonMinChars}–${LIMITS.reasonMaxChars} characters.`,
  notRecorded: 'This entry is not recorded (it may already be voided).',
  useUnlink: 'This receipt was added to a card-statement entry. Use “Unlink this receipt” to keep the card expense recorded.',
  notStatementOnly: 'Only a receipt added to a card-statement entry can be unlinked.',
  receiptNotOnEntry: 'This receipt is not part of that entry.',
  notFree: 'This card transaction can’t be recorded on its own: it is linked, already recorded, held for duplicate review, or not a supported charge.',
  receiptUnavailable: 'This receipt is not available.',
});

function checkReason(reason: string): string {
  const text = reason.trim();
  if (text.length < LIMITS.reasonMinChars || text.length > LIMITS.reasonMaxChars) throw new ValidationError('REASON_LENGTH', LEDGER_MESSAGES.reasonLength);
  return text;
}

function recordedEntry(c: CommandContext, id: string): LedgerEntry {
  const e = c.state.ledger.find((x) => x.id === id);
  if (!e || e.status !== 'recorded') throw new ValidationError('NOT_RECORDED', LEDGER_MESSAGES.notRecorded);
  return e;
}

function release(c: CommandContext, m: ConfirmedMatch, reason: string): ConfirmedMatch {
  const next: ConfirmedMatch = { ...m, status: 'released', releasedAt: c.at, releaseReason: reason };
  delete next.activeTxnKey;
  delete next.activeSubjectKey;
  c.put('matches', next);
  return next;
}

/**
 * Void the whole entry (shared by `voidEntry` and `recheckVoid`): the entry
 * stays as `voided`, every active match it holds is released and an invoice
 * it paid is unpaid again. Receipts are not modified; they re-evaluate as
 * pending.
 */
export function voidInContext(c: CommandContext, entry: LedgerEntry, reason: string): void {
  const voided: LedgerEntry = { ...entry, status: 'voided', voidedAt: c.at, voidReason: reason, updatedAt: c.at };
  delete voided.activeIdentityKey;
  c.put('ledger', voided);
  const evidenceRefs = [
    ...entry.evidence.receiptIds.map((ref) => ({ kind: 'receipt' as const, ref })),
    ...entry.evidence.transactionIds.map((ref) => ({ kind: 'transaction' as const, ref })),
  ];
  c.audit({
    action: 'ledger.voided',
    affected: [{ kind: 'ledger', id: entry.id }, ...entry.evidence.receiptIds.map((id) => ({ kind: 'receipt', id })), ...entry.evidence.payableIds.map((id) => ({ kind: 'payable', id }))],
    evidenceRefs,
    ruleRefs: entry.ruleRefs,
    reason,
    before: { status: 'recorded' },
    after: { status: 'voided' },
  });
  for (const m of c.state.matches) {
    if (m.status !== 'active' || !entry.evidence.matchIds.includes(m.id)) continue;
    release(c, m, reason);
    c.audit({
      action: 'match.released',
      affected: [{ kind: 'match', id: m.id }, { kind: m.subject.kind, id: m.subject.id }, { kind: 'transaction', id: m.transactionId }],
      evidenceRefs: [{ kind: 'match', ref: m.id }, { kind: 'ledger', ref: entry.id }],
      ruleRefs: m.proposalSnapshot.ruleRefs,
      reason,
      before: { status: 'active' },
      after: { status: 'released' },
    });
  }
  for (const pid of entry.evidence.payableIds) {
    const p = c.state.payables.find((x) => x.id === pid);
    if (!p || p.state !== 'paid') continue;
    const next: Payable = { ...p, state: 'unpaid', paidByMatchId: null };
    c.put('payables', next);
    c.audit({
      action: 'payable.reopened',
      affected: [{ kind: 'payable', id: p.id }, { kind: 'ledger', id: entry.id }],
      evidenceRefs: [{ kind: 'ledger', ref: entry.id }],
      reason,
      before: { state: 'paid', paidByMatchId: p.paidByMatchId },
      after: { state: 'unpaid' },
    });
  }
}

/** True when the receipt drawer must offer "Unlink this receipt" instead of "Void entry" (§6.8). */
export function isUnlinkCase(entry: LedgerEntry): boolean {
  return entry.origin === 'statement_only' && entry.evidence.receiptIds.length > 0;
}

/** "Void entry" (§6.8): an explicit audited correction; history is kept. */
export function voidEntry(repo: Repository, ledgerEntryId: string, reason: string): Promise<void> {
  let text: string;
  try {
    text = checkReason(reason);
  } catch (e) {
    return Promise.reject(e);
  }
  return runCommand(repo, (c) => {
    voidInContext(c, recordedEntry(c, ledgerEntryId), text);
  });
}

/**
 * "Unlink this receipt" (§6.8): only for a statement-only entry that gained
 * receipt evidence. Releases that receipt's match and removes the receipt from
 * the entry; the card expense stays recorded.
 */
export function unlinkReceipt(repo: Repository, ledgerEntryId: string, receiptId: string, reason: string): Promise<void> {
  let text: string;
  try {
    text = checkReason(reason);
  } catch (e) {
    return Promise.reject(e);
  }
  return runCommand(repo, (c) => {
    const entry = recordedEntry(c, ledgerEntryId);
    if (entry.origin !== 'statement_only') throw new ValidationError('NOT_STATEMENT_ONLY', LEDGER_MESSAGES.notStatementOnly);
    if (!entry.evidence.receiptIds.includes(receiptId)) throw new ValidationError('NOT_ON_ENTRY', LEDGER_MESSAGES.receiptNotOnEntry);
    const receipt = c.state.receipts.find((r) => r.id === receiptId);
    const matches = c.state.matches.filter(
      (m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === receiptId && entry.evidence.matchIds.includes(m.id),
    );
    for (const m of matches) {
      release(c, m, text);
      c.audit({
        action: 'match.released',
        affected: [{ kind: 'match', id: m.id }, { kind: 'receipt', id: receiptId }, { kind: 'transaction', id: m.transactionId }],
        evidenceRefs: [{ kind: 'match', ref: m.id }, { kind: 'ledger', ref: entry.id }],
        ruleRefs: m.proposalSnapshot.ruleRefs,
        reason: text,
        before: { status: 'active' },
        after: { status: 'released' },
      });
    }
    const released = new Set(matches.map((m) => m.id));
    const keptMatches = c.state.matches.filter((m) => m.status === 'active' && entry.evidence.matchIds.includes(m.id) && !released.has(m.id));
    const docId = receipt?.sourceDocumentId;
    const next: LedgerEntry = {
      ...entry,
      evidence: {
        ...entry.evidence,
        receiptIds: entry.evidence.receiptIds.filter((id) => id !== receiptId),
        sourceDocumentIds: docId ? entry.evidence.sourceDocumentIds.filter((id) => id !== docId) : entry.evidence.sourceDocumentIds,
        matchIds: entry.evidence.matchIds.filter((id) => !released.has(id)),
      },
      // Rule refs came from the receipt match; keep only those of links that remain.
      ruleRefs: sortRefs(keptMatches.flatMap((m) => m.proposalSnapshot.ruleRefs)),
      updatedAt: c.at,
    };
    c.put('ledger', next);
    c.audit({
      action: 'ledger.evidence_detached',
      affected: [{ kind: 'ledger', id: entry.id }, { kind: 'receipt', id: receiptId }],
      evidenceRefs: [{ kind: 'receipt', ref: receiptId }, ...matches.map((m) => ({ kind: 'match' as const, ref: m.id }))],
      ruleRefs: entry.ruleRefs,
      reason: text,
      before: { receiptIds: entry.evidence.receiptIds, matchIds: entry.evidence.matchIds },
      after: { receiptIds: next.evidence.receiptIds, matchIds: next.evidence.matchIds },
    });
  });
}

/**
 * "Record from statement (no receipt yet)" (§6.5): one entry whose identity is
 * the card transaction. A later receipt match extends this same entry.
 */
export function recordStatementOnly(repo: Repository, transactionId: string): Promise<{ ledgerEntryId: string }> {
  return runCommand(repo, (c) => {
    const t = c.state.transactions.find((x) => x.id === transactionId);
    const free =
      t !== undefined &&
      t.intake === 'available' &&
      t.direction === 'debit' &&
      t.currency === c.state.currency &&
      !isHeldForDuplicateReview(t) &&
      !c.state.matches.some((m) => m.status === 'active' && m.transactionId === t.id) &&
      !c.state.ledger.some((e) => e.status === 'recorded' && e.identityKey === t.id);
    if (!t || !free) throw new ValidationError('NOT_FREE', LEDGER_MESSAGES.notFree);
    const id = ledgerId(c.next('ledger'));
    const entry: LedgerEntry = {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id,
      origin: 'statement_only',
      identityKey: t.id,
      activeIdentityKey: t.id,
      status: 'recorded',
      expenseDate: t.transactionDate ?? t.postingDate,
      merchantName: t.rawLabel.trim() === '' ? t.id : t.rawLabel,
      canonicalMerchantId: null,
      amountMinor: t.amountMinor,
      currency: t.currency,
      category: { categoryId: null, status: 'unassigned' },
      evidence: { receiptIds: [], transactionIds: [t.id], payableIds: [], sourceDocumentIds: [t.sourceDocumentId], matchIds: [] },
      ruleRefs: [],
      recordedAt: c.at,
      updatedAt: c.at,
    };
    c.put('ledger', entry);
    c.audit({
      action: 'ledger.recorded',
      affected: [{ kind: 'ledger', id }, { kind: 'transaction', id: t.id }],
      evidenceRefs: [
        { kind: 'transaction', ref: t.id },
        { kind: 'source_document', ref: t.sourceDocumentId },
      ],
      after: { ledgerEntryId: id, origin: 'statement_only', amountMinor: t.amountMinor, currency: t.currency },
    });
    return { ledgerEntryId: id };
  });
}

/**
 * "Confirm category" (§6.7): updates the receipt, and on a recorded receipt
 * its ledger entry too, in one unit of work. Matches, reconciliation and
 * proposals are not read or written.
 */
export function confirmCategory(repo: Repository, receiptId: string, categoryId: CategoryId): Promise<{ changed: boolean }> {
  return runCommand(repo, (c) => {
    const receipt = c.state.receipts.find((r) => r.id === receiptId);
    if (!receipt || receipt.disposition !== 'active') throw new ValidationError('NOT_FOUND', LEDGER_MESSAGES.receiptUnavailable);
    if (!isCategoryId(categoryId)) throw new ValidationError('INVALID_CATEGORY', 'Choose a category from the list.');
    const derived = deriveCategory(receipt, c.activeRules());
    const ruleRef: RuleRef | undefined = derived.status === 'suggested' && derived.categoryId === categoryId && derived.ruleRef ? derived.ruleRef : undefined;
    const entry = c.state.ledger.find((e) => e.status === 'recorded' && e.evidence.receiptIds.includes(receiptId));
    const alreadyReceipt = receipt.category.status === 'confirmed' && receipt.category.categoryId === categoryId;
    const alreadyEntry = !entry || (entry.category.status === 'confirmed' && entry.category.categoryId === categoryId);
    if (alreadyReceipt && alreadyEntry) {
      c.markNoop();
      return { changed: false };
    }
    const category = { categoryId, status: 'confirmed' as const, ...(ruleRef ? { ruleRef } : {}), confirmedAt: c.at };
    c.put('receipts', { ...receipt, category, updatedAt: c.at });
    c.audit({
      action: 'category.confirmed',
      affected: [{ kind: 'receipt', id: receiptId }],
      evidenceRefs: [{ kind: 'receipt', ref: receiptId }],
      ruleRefs: ruleRef ? [ruleRef] : [],
      before: receipt.category,
      after: category,
    });
    if (entry) {
      const nextCategory = { categoryId, status: 'confirmed' as const, ...(ruleRef ? { ruleRef } : {}) };
      const ruleRefs = sortRefs([...entry.ruleRefs.filter((r) => !r.ruleId.startsWith('K-CAT-')), ...(ruleRef ? [ruleRef] : [])]);
      c.put('ledger', { ...entry, category: nextCategory, ruleRefs, updatedAt: c.at });
      c.audit({
        action: 'ledger.category_changed',
        affected: [{ kind: 'ledger', id: entry.id }, { kind: 'receipt', id: receiptId }],
        evidenceRefs: [{ kind: 'receipt', ref: receiptId }, { kind: 'ledger', ref: entry.id }],
        ruleRefs,
        before: entry.category,
        after: nextCategory,
      });
    }
    return { changed: true };
  });
}
