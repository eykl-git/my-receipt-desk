/**
 * Resolving possible duplicates (design §10.2, review-3 amendment M1).
 *
 * Receipts: "These are different purchases" writes a `distinct` ReviewDecision
 * for each flagged pair, which clears the flag; "Set this one aside as a
 * duplicate" sets the receipt's disposition so it leaves the three groups and
 * the metrics. Card rows: "Keep both" marks only the flagged row as kept;
 * "Set aside this row" sets its intake so it is never a candidate. Every
 * choice is refused on a linked or recorded record, and nothing is discarded
 * automatically.
 */
import { detectDuplicatePurchases, linkedReceiptIds } from '../../domain/capture/duplicates';
import { ValidationError } from '../../domain/errors';
import { decisionId } from '../../domain/ids';
import { isHeldForDuplicateReview } from '../../domain/matching/helpers';
import type { EvidenceRef } from '../../domain/primitives';
import type { ReviewDecision } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand, type CommandContext } from './context';

export const DUPLICATE_MESSAGES = Object.freeze({
  recorded: 'This one is recorded. Void its entry first.',
  receiptNotFlagged: 'This receipt is no longer flagged as a possible duplicate.',
  rowNotFlagged: 'This card transaction is no longer waiting for a duplicate decision.',
});

export type ReceiptDuplicateChoice = 'distinct' | 'set_aside';
export type StatementDuplicateChoice = 'keep' | 'set_aside';

function newDecision(c: CommandContext, subjectIds: string[], choice: ReviewDecision['choice']): ReviewDecision {
  const d: ReviewDecision = {
    schemaVersion: 1,
    workspaceId: c.workspaceId,
    id: decisionId(c.next('decision')),
    kind: 'duplicate_resolution',
    subjectIds,
    choice,
    reason: null,
    at: c.at,
  };
  c.put('decisions', d);
  return d;
}

/** "These are different purchases" / "Set this one aside as a duplicate". */
export function resolveDuplicate(repo: Repository, receiptId: string, choice: ReceiptDuplicateChoice): Promise<{ decisionIds: string[] }> {
  return runCommand(repo, (c) => {
    const receipt = c.state.receipts.find((r) => r.id === receiptId);
    if (!receipt || receipt.disposition !== 'active') throw new ValidationError('NOT_FOUND', 'This receipt is not available.');
    if (linkedReceiptIds(c.state.matches, c.state.ledger).has(receiptId)) throw new ValidationError('RECORDED', DUPLICATE_MESSAGES.recorded);
    const others = detectDuplicatePurchases(c.state.receipts, c.state.matches, c.state.ledger, c.state.decisions).get(receiptId) ?? [];
    if (others.length === 0) throw new ValidationError('NOT_DUPLICATE', DUPLICATE_MESSAGES.receiptNotFlagged);

    const decisions =
      choice === 'distinct'
        ? others.map((other) => newDecision(c, [receiptId, other], 'distinct'))
        : [newDecision(c, [receiptId, ...others], 'set_aside')];
    if (choice === 'set_aside') c.put('receipts', { ...receipt, disposition: 'set_aside_duplicate', updatedAt: c.at });

    const evidenceRefs: EvidenceRef[] = [
      { kind: 'receipt', ref: receiptId },
      ...others.map((id) => ({ kind: 'receipt' as const, ref: id })),
      { kind: 'source_document', ref: receipt.sourceDocumentId },
    ];
    c.audit({
      action: 'capture.duplicate_resolved',
      affected: [{ kind: 'receipt', id: receiptId }, ...others.map((id) => ({ kind: 'receipt', id }))],
      evidenceRefs,
      before: { disposition: receipt.disposition, possibleDuplicateOf: others },
      after: {
        choice,
        decisionIds: decisions.map((d) => d.id),
        disposition: choice === 'set_aside' ? 'set_aside_duplicate' : receipt.disposition,
      },
    });
    return { decisionIds: decisions.map((d) => d.id) };
  });
}

/** "Keep both" (only the flagged row is marked kept, M1) / "Set aside this row". */
export function resolveStatementDuplicate(repo: Repository, transactionId: string, choice: StatementDuplicateChoice): Promise<void> {
  return runCommand(repo, (c) => {
    const t = c.state.transactions.find((x) => x.id === transactionId);
    if (!t) throw new ValidationError('NOT_FOUND', 'That card transaction does not exist.');
    const linked =
      c.state.matches.some((m) => m.status === 'active' && m.transactionId === t.id) ||
      c.state.ledger.some((e) => e.status === 'recorded' && e.identityKey === t.id);
    if (linked) throw new ValidationError('RECORDED', DUPLICATE_MESSAGES.recorded);
    if (t.intake !== 'available' || !isHeldForDuplicateReview(t)) throw new ValidationError('NOT_DUPLICATE', DUPLICATE_MESSAGES.rowNotFlagged);

    const updated = choice === 'keep' ? { ...t, duplicateResolution: 'kept' as const } : { ...t, intake: 'set_aside_duplicate' as const };
    c.put('transactions', updated);
    const evidenceRefs: EvidenceRef[] = [
      { kind: 'transaction', ref: t.id },
      ...(t.duplicateOf ? [{ kind: 'transaction' as const, ref: t.duplicateOf }] : []),
      { kind: 'source_document', ref: t.sourceDocumentId },
    ];
    c.audit({
      action: choice === 'keep' ? 'import.rows_kept' : 'import.row_set_aside',
      affected: [{ kind: 'transaction', id: t.id }],
      evidenceRefs,
      before: { intake: t.intake, duplicateResolution: t.duplicateResolution, duplicateOf: t.duplicateOf },
      after: { intake: updated.intake, duplicateResolution: updated.duplicateResolution },
    });
  });
}
