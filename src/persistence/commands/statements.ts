/** Statement intake shared by `importStatement` and `loadDemoBatch` (design §12.1 step 6). */
import { documentId } from '../../domain/ids';
import { flagIncomingDuplicates } from '../../domain/imports/rows';
import type { ParsedStatement } from '../../domain/imports/parse';
import type { SourceDocument, StatementTransaction } from '../../domain/schemas';
import type { CommandContext } from './context';

export interface StatementFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
}

export const PENDING_DOCUMENT_ID = 'DOC-PENDING';

export function newSourceDocument(
  c: CommandContext,
  file: StatementFile,
  sourceType: SourceDocument['sourceType'],
): SourceDocument {
  const id = documentId(c.next('doc'));
  const doc: SourceDocument = {
    schemaVersion: 1,
    workspaceId: c.workspaceId,
    id,
    sha256: file.sha256,
    fileName: file.fileName,
    mimeType: file.mimeType,
    sizeBytes: file.bytes.length,
    sourceType,
    importedAt: c.at,
    fileKey: id,
  };
  c.put('source_documents', doc);
  c.put('files', { key: id, blob: new Blob([new Uint8Array(file.bytes)], { type: file.mimeType }) });
  return doc;
}

/** Writes the document, file, rows and the commit audit event. Rows carry PENDING_DOCUMENT_ID until here. */
export function writeStatement(
  c: CommandContext,
  file: StatementFile,
  parsed: ParsedStatement,
  sourceType: 'statement_csv' | 'demo_statement_csv',
): { document: SourceDocument; transactions: StatementTransaction[] } {
  const document = newSourceDocument(c, file, sourceType);
  const incoming = parsed.rows.map((r) => ({ ...r, sourceDocumentId: document.id }));
  const transactions = flagIncomingDuplicates(incoming, c.state.transactions);
  for (const t of transactions) c.put('transactions', t);
  c.audit({
    action: 'import.statement_committed',
    affected: [{ kind: 'source_document', id: document.id }, ...transactions.map((t) => ({ kind: 'transaction', id: t.id }))],
    evidenceRefs: [{ kind: 'source_document', ref: document.id }],
    after: {
      fileName: file.fileName,
      rows: parsed.preview.totalRows,
      imported: transactions.length,
      quarantined: parsed.preview.quarantinedRows.length,
      credits: parsed.preview.creditRows.length,
      possibleDuplicates: transactions.filter((t) => t.duplicateSuspected).length,
      excludedRows: parsed.errorLines,
    },
  });
  return { document, transactions };
}
