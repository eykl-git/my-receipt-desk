/**
 * "Show batch" filters lists only (design §9.3, A35): counters, coach text and
 * evaluation always cover the whole workspace.
 */
import { batchOfFixture, demoBatch } from '../demo/batches';
import type { CaseView } from '../domain/matching/caseView';
import type { Receipt, StatementTransaction } from '../domain/schemas';
import type { WorkspaceSnapshot } from '../persistence/repository';

export interface BatchFilter {
  receipt: (r: Receipt, c: CaseView | undefined) => boolean;
  transaction: (t: StatementTransaction) => boolean;
}

export function batchFilter(value: string, s: WorkspaceSnapshot): BatchFilter {
  if (value.startsWith('batch:')) {
    const n = Number(value.slice(6));
    const csv = demoBatch(n)?.csvFileName;
    const docIds = new Set(s.sourceDocuments.filter((d) => d.fileName === csv && d.sourceType === 'demo_statement_csv').map((d) => d.id));
    return { receipt: (r) => batchOfFixture(r.fixtureId) === n, transaction: (t) => docIds.has(t.sourceDocumentId) };
  }
  if (value.startsWith('doc:')) {
    const docId = value.slice(4);
    const txIds = new Set(s.transactions.filter((t) => t.sourceDocumentId === docId).map((t) => t.id));
    const linked = new Set(s.matches.filter((m) => m.status === 'active' && txIds.has(m.transactionId)).map((m) => m.subject.id));
    return {
      receipt: (r, c) =>
        linked.has(r.id) || [...(c?.proposal?.candidateIds ?? []), ...(c?.proposal?.nearCandidateIds ?? []), ...(c?.proposal?.heldIds ?? [])].some((id) => txIds.has(id)),
      transaction: (t) => txIds.has(t.id),
    };
  }
  return { receipt: () => true, transaction: () => true };
}
