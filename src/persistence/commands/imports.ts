/**
 * Card CSV import (design §12.1). The whole file is validated before this
 * runs; the commit is one unit of work and is refused while errors exist
 * unless the user explicitly chose "valid rows only". Re-importing a file with
 * the same SHA-256 adds nothing (idempotent).
 */
import { ValidationError } from '../../domain/errors';
import type { ParsedStatement, StatementAccount } from '../../domain/imports/parse';
import { resolveAccount } from '../../domain/imports/rows';
import { LIMITS } from '../../domain/limits';
import type { Repository } from '../repository';
import { runCommand } from './context';
import { writeStatement, type StatementFile } from './statements';

export function alreadyImportedMessage(date: string): string {
  return `This file was already imported on ${date.slice(0, 10)}. Nothing was added.`;
}

export type ImportResult =
  | { kind: 'imported'; documentId: string; transactionIds: string[] }
  | { kind: 'duplicate_file'; documentId: string; importedAt: string };

/** Write-only-audit unit of work for an identical file (§4.1). */
export function rejectDuplicateImport(repo: Repository, file: Pick<StatementFile, 'fileName' | 'sha256'>): Promise<ImportResult | null> {
  return runCommand(repo, (c) => {
    const doc = c.state.sourceDocuments.find((d) => d.sha256 === file.sha256);
    if (!doc) {
      c.markNoop();
      return null;
    }
    c.audit({
      action: 'import.duplicate_file_rejected',
      affected: [{ kind: 'source_document', id: doc.id }],
      evidenceRefs: [{ kind: 'source_document', ref: doc.id }],
      after: { fileName: file.fileName },
    });
    return { kind: 'duplicate_file', documentId: doc.id, importedAt: doc.importedAt };
  });
}

export async function importStatement(
  repo: Repository,
  file: StatementFile,
  parsed: ParsedStatement,
  account: StatementAccount,
  mode: 'all_rows' | 'valid_rows_only',
): Promise<ImportResult> {
  const before = await repo.loadSnapshot();
  if (before.sourceDocuments.some((d) => d.sha256 === file.sha256)) {
    const dup = await rejectDuplicateImport(repo, file);
    if (dup) return dup;
  }
  return runCommand(repo, (c) => {
    if (c.state.sourceDocuments.some((d) => d.sha256 === file.sha256)) throw new ValidationError('DUPLICATE_FILE', 'This file was already imported. Nothing was added.');
    if (parsed.fileErrors.length > 0) throw new ValidationError('IMPORT_BLOCKED', parsed.fileErrors.join(' '));
    if (parsed.errors.length > 0 && mode !== 'valid_rows_only') {
      throw new ValidationError('IMPORT_HAS_ERRORS', 'Some rows have errors. Fix the file or choose to import only the valid rows.');
    }
    if (parsed.rows.length === 0) throw new ValidationError('IMPORT_EMPTY', 'There are no valid rows to import.');
    if (parsed.preview.currency !== c.state.currency) {
      throw new ValidationError('CURRENCY_CHANGED', 'The workspace currency changed. Preview the import again.');
    }
    const acct = resolveAccount(account.accountLabel, c.state.transactions);
    if (!acct.ok) throw new ValidationError('ACCOUNT', acct.message);
    if (acct.accountId !== account.accountId || parsed.rows.some((r) => r.accountId !== acct.accountId)) {
      throw new ValidationError('ACCOUNT', 'The card account changed. Preview the import again.');
    }
    if (c.state.transactions.length + parsed.rows.length > LIMITS.workspaceMaxTransactions) {
      throw new ValidationError('LIMIT', `A workspace can hold at most ${LIMITS.workspaceMaxTransactions} card transactions. Nothing was imported.`);
    }
    const { document, transactions } = writeStatement(c, file, parsed, 'statement_csv');
    return { kind: 'imported', documentId: document.id, transactionIds: transactions.map((t) => t.id) };
  });
}
