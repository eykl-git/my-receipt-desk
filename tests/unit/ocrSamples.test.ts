/**
 * O02: the real tesseract.js engine in Node reads each fictional sample PNG,
 * and the parsed merchant, date, total and currency equal the fixture. Where a
 * field was measured as hard to read (fixture `measuredUnclear`, recorded in
 * .agents/tasks/ocr/verification.md), the test asserts it is unclear with
 * value null rather than a wrong confident value. Every other field must be
 * clear and exact.
 *
 * O04 (task 4.10): the Malaysian sample receipt yields the expected merchant,
 * date and total after OCR and parsing, and the Malaysian sample CSV imports
 * into an MYR workspace with exact preview totals.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectedRegions, type ReceiptRegion } from '../../src/domain/capture/ocrLocale';
import { prefillMapping, presetDateFormat } from '../../src/domain/imports/mapping';
import { decodeCsvBytes, parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { resolveAccount } from '../../src/domain/imports/rows';
import { parseAmount } from '../../src/domain/money';
import { FIELD_NAMES, type FieldName } from '../../src/domain/schemas';
import { createOcrAdapter, createTesseractEngine, type OcrEngine, type OcrLanguageCode } from '../../src/ocr';
import { importStatement, setWorkspaceCurrency } from '../../src/persistence/commands';
import { PENDING_DOCUMENT_ID } from '../../src/persistence/commands/statements';
import { sha256Hex } from '../../src/persistence/hash';
import { makeRepo } from '../helpers/repos';

interface SampleFixture {
  image: string;
  fictional: true;
  region: ReceiptRegion;
  languages: OcrLanguageCode[];
  expected: { merchant: string; date: string; amountMinor: number; currency: string };
  measuredUnclear: FieldName[];
  statementRow: string | null;
}

const SAMPLES = ['sample-receipt-my', 'sample-receipt-my-zh', 'sample-receipt-hk-zh'].map((name) => ({
  name,
  fixture: JSON.parse(readFileSync(`tests/fixtures/ocr/${name}.json`, 'utf8')) as SampleFixture,
}));

let assets: string;
const engines: OcrEngine[] = [];
beforeAll(() => {
  assets = mkdtempSync(join(tmpdir(), 'mrd-ocr-samples-'));
  execFileSync(process.execPath, ['scripts/ocr/copy-assets.mjs', '--out', assets], { stdio: 'pipe' });
});
afterAll(async () => {
  await Promise.all(engines.map((e) => e.terminate()));
  rmSync(assets, { recursive: true, force: true });
});

describe('O02 OCR of the fictional samples (real engine)', () => {
  for (const { name, fixture } of SAMPLES) {
    it(`O02 ${name}: parsed fields equal the fixture (${fixture.languages.join('+')})`, { timeout: 120_000 }, async () => {
      expect(fixture.fictional).toBe(true);
      const engine = createTesseractEngine({ assetBase: assets, languages: fixture.languages, timeoutMs: 110_000 });
      engines.push(engine);
      const file = new Blob([readFileSync(fixture.image)], { type: 'image/png' });
      const { result, locale } = await createOcrAdapter(engine).extractWithDetails({ file, sourceDocumentId: name });

      for (const field of FIELD_NAMES) {
        const got = result[field];
        expect(got.provenance).toEqual({ adapterId: 'ocr-tesseract', kind: 'ocr' });
        if (fixture.measuredUnclear.includes(field)) {
          // Measured as hard to read: never a confident value; the raw text is kept for the user.
          expect(got.clarity, `${field} raw=${String(got.raw)}`).toBe('unclear');
          expect(got.value).toBeNull();
          expect(got.raw).not.toBeNull();
        } else {
          expect({ field, value: got.value, clarity: got.clarity }).toEqual({
            field,
            value: fixture.expected[field],
            clarity: 'clear',
          });
        }
      }
      expect(detectedRegions(locale)).toEqual([fixture.region]);
      await engine.terminate();
    });
  }

  it('O02 the MYR statement CSV has the rows that match the Malaysian samples', () => {
    const bytes = readFileSync('public/samples/example-card-statement-my.csv');
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = bytes.toString('utf8').slice(1);
    expect(text.endsWith('\r\n\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    const rows = text.split('\r\n').filter((r) => r !== '');
    expect(rows[0]).toBe('Date,Posted,Details,Amount,Currency');
    for (const row of rows.slice(1)) {
      const [date, posted, , , currency] = row.split(',');
      expect(currency).toBe('MYR');
      // Day > 12 everywhere, so DD/MM/YYYY is the only valid reading.
      expect(Number(date?.slice(0, 2))).toBeGreaterThan(12);
      expect(Number(posted?.slice(0, 2))).toBeGreaterThan(12);
    }
    for (const { fixture } of SAMPLES) {
      if (fixture.statementRow === null) continue;
      expect(rows).toContain(fixture.statementRow);
      const [date, , , amount] = fixture.statementRow.split(',');
      const [d, m, y] = (date ?? '').split('/');
      expect(`${y}-${m}-${d}`).toBe(fixture.expected.date);
      expect(parseAmount(amount ?? '')).toBe(-fixture.expected.amountMinor);
    }
  });
});

describe('O04 Malaysia sample assets (task 4.10)', () => {
  it('O04 sample-receipt-my.png: real OCR then parsing yields merchant CONTOH MART SDN BHD, date 2026-03-14 and total MYR 23.00', { timeout: 120_000 }, async () => {
    const engine = createTesseractEngine({ assetBase: assets, languages: ['eng', 'msa'], timeoutMs: 110_000 });
    engines.push(engine);
    const file = new Blob([readFileSync('public/samples/sample-receipt-my.png')], { type: 'image/png' });
    const { result } = await createOcrAdapter(engine).extractWithDetails({ file, sourceDocumentId: 'O04-sample-receipt-my' });
    expect(result.merchant).toMatchObject({ value: 'CONTOH MART SDN BHD', clarity: 'clear' });
    expect(result.date).toMatchObject({ value: '2026-03-14', clarity: 'clear' });
    expect(result.amountMinor).toMatchObject({ value: 2300, clarity: 'clear' });
    expect(result.currency).toMatchObject({ value: 'MYR', clarity: 'clear' });
    await engine.terminate();
  });

  it('O04 example-card-statement-my.csv imports into an MYR workspace with exact preview totals (4 rows, 0 quarantined, 4 MYR debits, MYR 97.40)', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' }, 'memory');
    expect(await setWorkspaceCurrency(repo, 'MYR')).toEqual({ changed: true });

    // The same steps as the "Import card CSV" wizard: decode, read, prefill, choose DD/MM/YYYY and the amount sign.
    const bytes = new Uint8Array(readFileSync('public/samples/example-card-statement-my.csv'));
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) throw new Error(decoded.message);
    const grid = readCsvGrid(decoded.text);
    expect(grid.problems).toEqual([]);
    const mapping = prefillMapping(grid.header);
    expect(presetDateFormat(grid.rows.map((r) => r.cells), mapping)).toBeNull();
    const acct = resolveAccount('Maybank 5678', []);
    if (!acct.ok) throw new Error(acct.message);
    const account = { accountId: acct.accountId, accountLabel: acct.accountLabel };
    const sha256 = await sha256Hex(bytes);
    const workspaceCurrency = (await repo.loadSnapshot()).currency;
    expect(workspaceCurrency).toBe('MYR');
    const parsed = parseStatementCsv(grid, mapping, { dateFormat: 'DD/MM/YYYY', amountSign: 'negative_charges', defaultCurrency: 'MYR' }, account, {
      sha256,
      sourceDocumentId: PENDING_DOCUMENT_ID,
      workspaceId: 'personal',
      workspaceCurrency,
    });
    expect(parsed.fileErrors).toEqual([]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.preview).toEqual({
      currency: 'MYR',
      totalRows: 4,
      validRows: 4,
      errorRows: 0,
      quarantinedRows: [],
      creditRows: [],
      hkdDebitRows: 4,
      hkdDebitTotalMinor: 9740,
      otherCurrencyTotals: [],
    });

    await importStatement(repo, { fileName: 'example-card-statement-my.csv', mimeType: 'text/csv', bytes, sha256 }, parsed, account, 'all_rows');
    const s = await repo.loadSnapshot();
    expect(s.transactions.map((t) => [t.postingDate, t.amountMinor, t.currency, t.intake])).toEqual([
      ['2026-03-15', 2300, 'MYR', 'available'],
      ['2026-03-17', 2650, 'MYR', 'available'],
      ['2026-03-20', 500, 'MYR', 'available'],
      ['2026-03-23', 4290, 'MYR', 'available'],
    ]);
  });
});
