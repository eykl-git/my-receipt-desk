/** My files helpers for persistence suites: real CSV import and real (tiny) PNG uploads through the commands. */
import { prefillMapping } from '../../src/domain/imports/mapping';
import { parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { addReceipts, importStatement, saveFields } from '../../src/persistence/commands';
import { sha256Hex } from '../../src/persistence/hash';
import type { Repository } from '../../src/persistence/repository';
import { makeRepo } from './repos';

export const NOW = '2026-04-20T10:00:00.000Z';

export function personalRepo(): Repository {
  return makeRepo('personal', { systemNow: () => NOW });
}

/** Import CSV text (header `Date,Posted,Details,Amount,Currency`, ISO dates, negative charges). */
export async function importCsv(repo: Repository, text: string, fileName = 'card.csv', accountLabel = 'Visa 1234') {
  const bytes = new TextEncoder().encode(text);
  const sha = await sha256Hex(bytes);
  const grid = readCsvGrid(text);
  const account = { accountId: `acct:${accountLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, accountLabel };
  const s = await repo.loadSnapshot();
  const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'negative_charges', defaultCurrency: s.currency }, account, {
    sha256: sha,
    sourceDocumentId: 'DOC-PENDING',
    workspaceId: 'personal',
    workspaceCurrency: s.currency,
  });
  if (parsed.errors.length > 0) throw new Error(`CSV errors: ${JSON.stringify(parsed.errors)}`);
  return importStatement(repo, { fileName, mimeType: 'text/csv', bytes, sha256: sha }, parsed, account, 'all_rows');
}

let salt = 0;
/** A PNG upload with unique bytes (so each one is a different file). */
export async function png(name: string) {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ++salt, salt >> 8, 7]);
  return { fileName: name, mimeType: 'image/png', bytes, sha256: await sha256Hex(bytes) };
}

/** Add one receipt and save its four fields; returns its ID. */
export async function addReceipt(repo: Repository, fields: { merchant: string; date: string; amount: string; currency?: string }): Promise<string> {
  const { added } = await addReceipts(repo, [await png(`${fields.merchant}.png`)]);
  const id = added[0]!;
  await saveFields(repo, id, { currency: (await repo.loadSnapshot()).currency, ...fields });
  return id;
}

export function txByLabel(s: { transactions: readonly { id: string; rawLabel: string }[] }, label: string): string {
  const t = s.transactions.find((x) => x.rawLabel === label);
  if (!t) throw new Error(`No transaction ${label}`);
  return t.id;
}
