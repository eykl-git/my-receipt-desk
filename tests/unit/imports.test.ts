import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { DEMO_CONVENTIONS, DEMO_MAPPING } from '../../src/demo/batches';
import { decodeCsvBytes, parseStatementCsv, readCsvGrid, IMPORT_MESSAGES } from '../../src/domain/imports/parse';
import { prefillMapping, type ImportConventions } from '../../src/domain/imports/mapping';
import { resolveAccount } from '../../src/domain/imports/rows';
import { describeEachRepo, makeRepo } from '../helpers/repos';
import { importStatement } from '../../src/persistence/commands';
import { sha256Hex } from '../../src/persistence/hash';
import { fakeSha } from '../builders';

const demoAccount = { accountId: 'acct:demo-card-1234', accountLabel: 'Demo Card ••1234' };
const src = (tag: string) => ({ sha256: fakeSha(tag), sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal' as const });
const exampleBytes = () => new Uint8Array(readFileSync(join(process.cwd(), 'public/demo/example-card-statement.csv')));

function gridOf(text: string) {
  return readCsvGrid(text);
}

describeEachRepo('card CSV parsing', () => {
  it('demo CSVs parse to the design §8 rows through the normal pipeline', () => {
    const text = readFileSync(join(process.cwd(), 'public/demo/statements/batch-1.csv'), 'utf8');
    const parsed = parseStatementCsv(gridOf(text), DEMO_MAPPING, DEMO_CONVENTIONS, demoAccount, src('batch-1.csv'));
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.reference, r.rawLabel, r.transactionDate, r.postingDate, r.amountMinor, r.currency, r.direction, r.intake, r.rowNumber])).toEqual([
      ['S-101', 'PAGE CORNER', '2026-03-02', '2026-03-03', 12000, 'HKD', 'debit', 'available', 2],
      ['S-102', 'MC COFFEE HK', '2026-03-04', '2026-03-05', 4800, 'HKD', 'debit', 'available', 3],
      ['S-103', 'MC COFFEE HK', '2026-03-06', '2026-03-07', 6200, 'HKD', 'debit', 'available', 4],
      ['S-104', 'GREEN BASKET', '2026-03-08', '2026-03-09', 8000, 'HKD', 'debit', 'available', 5],
      ['S-105A', 'CITY PARKING', '2026-03-10', '2026-03-11', 3000, 'HKD', 'debit', 'available', 6],
      ['S-105B', 'CITY PARKING', '2026-03-11', '2026-03-12', 3000, 'HKD', 'debit', 'available', 7],
    ]);
    expect(parsed.rows.every((r) => r.accountId === 'acct:demo-card-1234')).toBe(true);
    expect(parsed.preview.hkdDebitTotalMinor).toBe(37000);
  });

  it('BOM, CRLF, a quoted comma and blank lines are handled; rows keep their file line numbers', () => {
    const text = '\uFEFFReference,Posting date,Description,Amount\r\n\r\nA1,2026-03-03,"Page Corner, Central",-12.50\r\n\r\nA2,2026-03-04,MC COFFEE HK,-4.00\r\n\r\n';
    const grid = gridOf(text);
    expect(grid.header).toEqual(['Reference', 'Posting date', 'Description', 'Amount']);
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: null, amountSign: 'negative_charges', defaultCurrency: 'HKD' }, demoAccount, src('x'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows.map((r) => [r.rowNumber, r.rawLabel, r.amountMinor])).toEqual([
      [3, 'Page Corner, Central', 1250],
      [5, 'MC COFFEE HK', 400],
    ]);
  });

  it('T17 the example CSV gives exactly the §12.4 preview with DD/MM/YYYY and negative charges', () => {
    const decoded = decodeCsvBytes(exampleBytes());
    if (!decoded.ok) throw new Error('not utf-8');
    const grid = gridOf(decoded.text);
    const mapping = prefillMapping(grid.header);
    expect(mapping).toEqual({ transactionDate: 0, postingDate: 1, description: 2, amount: 3, currency: 4 });
    const conventions: ImportConventions = { dateFormat: 'DD/MM/YYYY', amountSign: 'negative_charges', defaultCurrency: 'HKD' };
    const parsed = parseStatementCsv(grid, mapping, conventions, { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' }, src('example'));
    expect(parsed.errors).toEqual([]);
    expect(parsed.preview).toEqual({
      currency: 'HKD',
      totalRows: 6,
      validRows: 6,
      errorRows: 0,
      quarantinedRows: [7],
      creditRows: [6],
      hkdDebitRows: 4,
      hkdDebitTotalMinor: 27850,
      otherCurrencyTotals: [{ currency: 'USD', totalMinor: 2500 }],
    });
    expect(parsed.rows[0]!.rawLabel).toBe('Page Corner, Central');
    expect(parsed.rows[0]!.postingDate).toBe('2026-04-03');

    // MM/DD/YYYY: row 7 has two DATE_INVALID errors.
    const us = parseStatementCsv(grid, mapping, { ...conventions, dateFormat: 'MM/DD/YYYY' }, demoAccount, src('example'));
    expect(us.errors.filter((e) => e.row === 7).map((e) => [e.code, e.value])).toEqual([
      ['DATE_INVALID', '15/04/2026'],
      ['DATE_INVALID', '14/04/2026'],
    ]);
  });

  it('T17 neither the date format nor the amount sign is guessed', () => {
    const decoded = decodeCsvBytes(exampleBytes());
    if (!decoded.ok) throw new Error('not utf-8');
    const grid = gridOf(decoded.text);
    const none = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: null, amountSign: null, defaultCurrency: 'HKD' }, demoAccount, src('e'));
    expect(none.fileErrors).toEqual([IMPORT_MESSAGES.chooseDateFormat, IMPORT_MESSAGES.chooseAmountSign]);
    expect(none.rows).toEqual([]);

    // ISO dates pre-select the format, but a signed Amount column still needs "Amount sign".
    const iso = gridOf('Posting date,Description,Amount\n2026-03-03,PAGE CORNER,-120.00\n');
    const isoParsed = parseStatementCsv(iso, prefillMapping(iso.header), { dateFormat: null, amountSign: null, defaultCurrency: 'HKD' }, demoAccount, src('i'));
    expect(isoParsed.fileErrors).toEqual([IMPORT_MESSAGES.chooseAmountSign]);
  });

  it('T17 malformed rows report row number, column and original value', () => {
    const text = [
      'Reference,Posting date,Description,Amount',
      'B1,2026-02-30,PAGE CORNER,1.00',
      'B2,2026-03-03,PAGE CORNER,12.345',
      'B3,2026-03-03,PAGE CORNER,10000000.00',
      'B4,2026-03-03,,5.00',
      'B5,2026-03-03,FINE,0.00',
    ].join('\n');
    const grid = gridOf(text);
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'positive_charges', defaultCurrency: 'HKD' }, demoAccount, src('m'));
    expect(parsed.errors.map((e) => [e.row, e.column, e.value, e.code])).toEqual([
      [2, 'Posting date', '2026-02-30', 'DATE_INVALID'],
      [3, 'Amount', '12.345', 'AMOUNT_INVALID'],
      [4, 'Amount', '10000000.00', 'AMOUNT_OUT_OF_RANGE'],
      [5, 'Description', '', 'REQUIRED_MISSING'],
      [6, 'Amount', '0.00', 'AMOUNT_ZERO'],
    ]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.preview.errorRows).toBe(5);
  });

  it('T17 commit is refused with errors unless valid rows only is chosen; refusals write nothing', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const text = 'Reference,Posting date,Description,Amount\nC1,2026-03-03,PAGE CORNER,12.00\nC2,2026-03-33,PAGE CORNER,13.00\n';
    const bytes = new TextEncoder().encode(text);
    const sha = await sha256Hex(bytes);
    const grid = gridOf(text);
    const account = { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' };
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'positive_charges', defaultCurrency: 'HKD' }, account, { sha256: sha, sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal' });
    const file = { fileName: 'card.csv', mimeType: 'text/csv', bytes, sha256: sha };
    const empty = await repo.loadSnapshot();
    await expect(importStatement(repo, file, parsed, account, 'all_rows')).rejects.toThrow('Some rows have errors');
    expect(await repo.loadSnapshot()).toEqual(empty);

    const ok = await importStatement(repo, file, parsed, account, 'valid_rows_only');
    expect(ok.kind).toBe('imported');
    const s = await repo.loadSnapshot();
    expect(s.transactions.map((t) => t.reference)).toEqual(['C1']);
    expect(s.audit.map((a) => a.action)).toEqual(['import.statement_committed']);
    expect(s.audit[0]!.after).toMatchObject({ excludedRows: [3] });
  });

  it('T17 an account name whose slug matches a different label is refused; the same label is reused (N6)', () => {
    const existing = [{ accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' }];
    expect(resolveAccount('VISA-1234', existing)).toEqual({
      ok: false,
      message: 'A card account with a similar name already exists: “Visa 1234”. Choose it from the list or use a different name.',
    });
    expect(resolveAccount('Visa 1234', existing)).toEqual({ ok: true, accountId: 'acct:visa-1234', accountLabel: 'Visa 1234', existing: true });
    expect(resolveAccount('•••', existing)).toEqual({ ok: false, message: 'Use letters or numbers in the account name.' });
  });

  it('T10 re-importing the same file adds nothing and is audited', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const bytes = exampleBytes();
    const sha = await sha256Hex(bytes);
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) throw new Error('utf-8');
    const grid = gridOf(decoded.text);
    const account = { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' };
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'DD/MM/YYYY', amountSign: 'negative_charges', defaultCurrency: 'HKD' }, account, { sha256: sha, sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal' });
    const file = { fileName: 'example-card-statement.csv', mimeType: 'text/csv', bytes, sha256: sha };
    await importStatement(repo, file, parsed, account, 'all_rows');
    const once = await repo.loadSnapshot();
    const again = await importStatement(repo, file, parsed, account, 'all_rows');
    expect(again.kind).toBe('duplicate_file');
    const twice = await repo.loadSnapshot();
    expect(twice.transactions).toEqual(once.transactions);
    expect(twice.sourceDocuments).toEqual(once.sourceDocuments);
    expect(twice.audit.map((a) => a.action)).toEqual(['import.statement_committed', 'import.duplicate_file_rejected']);
  });
});
