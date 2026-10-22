/**
 * Export gate (design §12.2, REQ-10.5): before any export every record is
 * re-validated with its schema (a failure stops the export and names the
 * record), and ledger entries whose evidence is missing (receipt, card
 * transaction, source document or original file) are listed so the user can
 * confirm before they are exported with `evidence_status=missing`.
 */
import { missingEvidence } from '../domain/ledger/evidence';
import type { Repository, WorkspaceSnapshot } from './repository';
import { SCHEMAS } from './records';

export type GateResult = { ok: false; message: string } | { ok: true; missingEvidence: Set<string> };

export async function exportGate(repo: Repository, s: WorkspaceSnapshot): Promise<GateResult> {
  const checks: Array<[keyof typeof SCHEMAS, readonly unknown[], (r: never) => string]> = [
    ['source_documents', s.sourceDocuments, (r: { id: string }) => r.id],
    ['receipts', s.receipts, (r: { id: string }) => r.id],
    ['transactions', s.transactions, (r: { id: string }) => r.id],
    ['payables', s.payables, (r: { id: string }) => r.id],
    ['matches', s.matches, (r: { id: string }) => r.id],
    ['ledger', s.ledger, (r: { id: string }) => r.id],
    ['rule_heads', s.ruleHeads, (r: { ruleId: string }) => r.ruleId],
    ['rule_versions', s.ruleVersions, (r: { ruleId: string; version: number }) => `${r.ruleId} v${r.version}`],
    ['decisions', s.decisions, (r: { id: string }) => r.id],
    ['audit', s.audit, (r: { id: string }) => r.id],
  ];
  for (const [store, records, idOf] of checks) {
    const schema = SCHEMAS[store]!;
    for (const r of records) if (!schema.safeParse(r).success) return { ok: false, message: `Export stopped: ${idOf(r as never)} failed a check.` };
  }
  const docs = new Map(s.sourceDocuments.map((d) => [d.id, d]));
  const missing = new Set<string>(missingEvidence(s.ledger, s).keys());
  for (const e of s.ledger) {
    for (const docId of e.evidence.sourceDocumentIds) {
      const doc = docs.get(docId);
      if (!doc || (await repo.getFile(doc.fileKey)) === null) missing.add(e.id);
    }
  }
  return { ok: true, missingEvidence: missing };
}
