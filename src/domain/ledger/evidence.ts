/**
 * Broken evidence references (design §11.5): a ledger entry whose receipt,
 * card transaction or source document is no longer in the workspace. Nothing
 * is repaired automatically; the entry shows "Evidence missing: …" and exports
 * mark it `evidence_status=missing` after a confirmation. (Missing file bytes
 * need a storage read and are checked by the export gate.)
 */
import type { LedgerEntry, Receipt, SourceDocument, StatementTransaction } from '../schemas';

export function missingEvidence(
  ledger: readonly LedgerEntry[],
  s: { receipts: readonly Receipt[]; transactions: readonly StatementTransaction[]; sourceDocuments: readonly SourceDocument[] },
): Map<string, string[]> {
  const receipts = new Set(s.receipts.map((r) => r.id));
  const txns = new Set(s.transactions.map((t) => t.id));
  const docs = new Set(s.sourceDocuments.map((d) => d.id));
  const out = new Map<string, string[]>();
  for (const e of ledger) {
    const missing = [
      ...e.evidence.receiptIds.filter((id) => !receipts.has(id)),
      ...e.evidence.transactionIds.filter((id) => !txns.has(id)),
      ...e.evidence.sourceDocumentIds.filter((id) => !docs.has(id)),
    ];
    if (missing.length > 0) out.set(e.id, missing);
  }
  return out;
}
