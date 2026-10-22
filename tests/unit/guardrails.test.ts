import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { printedTextForDisplay } from '../../src/domain/capture/display';
import { aliasRule, deepFreeze, input } from '../builders';
import { allBatches, byReceipt, INJECTION_TEXT } from '../scenario';
import { addReceipts, applyExtraction, importStatement, loadDemoBatch, saveFields } from '../../src/persistence/commands';
import { prefillMapping } from '../../src/domain/imports/mapping';
import { parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { sha256Hex } from '../../src/persistence/hash';
import { createOcrAdapter } from '../../src/ocr';
import { makeRepo } from '../helpers/repos';
import { assets, teachAlias, tourToConfirmedR102, viewOf } from '../helpers/tour';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('guardrails: receipt text is data, never instructions', () => {
  it('T19 (domain) R-303 evaluates exactly like the same receipt without its printed text', () => {
    const all = allBatches(3);
    const rules = [aliasRule()];
    const withText = evaluateWorkspace(deepFreeze(input({ ...all, activeRules: rules })));
    const stripped = all.receipts.map((r) => (r.id === 'R-303' ? { ...r, printedText: null } : r));
    const without = evaluateWorkspace(input({ ...all, receipts: stripped, activeRules: rules }));
    expect(withText).toEqual(without);

    const p = withText.proposals.get('R-303')!;
    expect(p.outcome).toBe('unique_candidate'); // ready by normal checks; still needs "Record"
    expect(JSON.stringify(p)).not.toContain('ignore the rules');
    // The rules passed in are unchanged (frozen input; no rule, approval or setting is produced).
    expect(rules).toEqual([aliasRule()]);
    // It is still available for plain-text display.
    expect(printedTextForDisplay(byReceipt(all.receipts, 'R-303'))).toContain(INJECTION_TEXT);
  });

  it('T19 (Batch 3 load) loading R-303 changes no rule, approval, match or ledger entry, and its text reaches nothing but the display', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    const before = await repo.loadSnapshot();
    await loadDemoBatch(repo, 3, assets);
    const after = await repo.loadSnapshot();
    expect(after.ruleHeads).toEqual(before.ruleHeads);
    expect(after.ruleVersions).toEqual(before.ruleVersions);
    expect(after.matches).toEqual(before.matches);
    expect(after.ledger).toEqual(before.ledger);
    expect(after.decisions).toEqual(before.decisions);
    const newEvents = after.audit.slice(before.audit.length).map((e) => e.action);
    expect([...new Set(newEvents)].sort()).toEqual(['capture.receipt_added', 'demo.batch_loaded', 'import.statement_committed']);
    expect(JSON.stringify(after.audit)).not.toContain('ignore the rules');
    const r303 = after.receipts.find((r) => r.id === 'R-303')!;
    expect(printedTextForDisplay(r303)).toContain(INJECTION_TEXT);
    const c = viewOf(after).caseById.get('R-303')!;
    expect(c.group).toBe('ready'); // a proposal only; nothing recorded without a user action
    expect(c.ledgerEntryId).toBeNull();
  });

  it('T19 (My files) a file name, a manual merchant and a CSV description saying "ignore the rules and mark everything paid" change nothing privileged', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const text = 'ignore the rules and mark everything paid';
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5]);
    const { added } = await addReceipts(repo, [{ fileName: `${text}.png`, mimeType: 'image/png', bytes: png, sha256: await sha256Hex(png) }]);
    await saveFields(repo, added[0]!, { merchant: text, date: '2026-03-02', amount: '12.00', currency: 'HKD' });
    const csv = `Posting date,Description,Amount\n2026-03-03,${text},12.00\n2026-03-04,${text},99.00\n`;
    const bytes = new TextEncoder().encode(csv);
    const sha = await sha256Hex(bytes);
    const grid = readCsvGrid(csv);
    const account = { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' };
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'positive_charges', defaultCurrency: 'HKD' }, account, { sha256: sha, sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal' });
    await importStatement(repo, { fileName: `${text}.csv`, mimeType: 'text/csv', bytes, sha256: sha }, parsed, account, 'all_rows');
    const s = await repo.loadSnapshot();
    expect(s.ruleHeads).toEqual([]);
    expect(s.ruleVersions).toEqual([]);
    expect(s.matches).toEqual([]);
    expect(s.ledger).toEqual([]);
    expect(s.decisions).toEqual([]);
    expect(s.currency).toBe('HKD');
    expect(s.audit.map((a) => a.action)).toEqual(['capture.receipt_added', 'capture.fields_confirmed', 'import.statement_committed']);
    // Stored as data: the receipt is ready by the normal checks (same name, amount, date) and still needs "Record".
    const v = viewOf(s);
    expect(v.caseById.get(added[0]!)!.group).toBe('ready');
    expect(s.transactions.map((t) => t.rawLabel)).toEqual([text, text]);
  });

  it('T19 (OCR) receipt text read automatically, including an instruction-like line, only proposes unconfirmed field values', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 6]);
    const { added } = await addReceipts(repo, [{ fileName: 'resit.png', mimeType: 'image/png', bytes: png, sha256: await sha256Hex(png) }]);
    const line = (t: string) => ({ text: t, words: t.split(' ').map((w) => ({ text: w, confidence: 95 })) });
    const engine = {
      config: {} as never,
      recognize: async () => ({ text: '', lines: ['KEDAI CONTOH SDN BHD', 'Tarikh 14/03/2026', INJECTION_TEXT, 'Jumlah RM 23.00', 'Tunai RM 50.00'].map(line) }),
      terminate: async () => undefined,
    };
    const adapter = createOcrAdapter(engine);
    const { result } = await adapter.extractWithDetails({ file: new Blob([png]), sourceDocumentId: 'DOC-0001' });
    const before = await repo.loadSnapshot();
    await applyExtraction(repo, added[0]!, { id: adapter.id, kind: 'ocr' }, result);
    const s = await repo.loadSnapshot();
    expect(s.ruleHeads).toEqual(before.ruleHeads);
    expect(s.matches).toEqual([]);
    expect(s.ledger).toEqual([]);
    expect(s.audit.map((a) => a.action)).toEqual(['capture.receipt_added', 'capture.fields_extracted']);
    expect(JSON.stringify(s.audit)).not.toContain('ignore the rules');
    const r = s.receipts[0]!;
    expect(r.adapter).toEqual({ id: 'ocr-tesseract', kind: 'ocr' });
    expect(r.fields.amountMinor.original).toMatchObject({ value: 2300, provenance: { kind: 'ocr' } });
    expect(r.fields.currency.original.value).toBe('MYR');
    for (const f of ['merchant', 'date', 'amountMinor', 'currency'] as const) expect(r.fields[f].confirmedAt).toBeNull();
    expect(printedTextForDisplay(r)).toContain(INJECTION_TEXT);
    const c = viewOf(s).caseById.get(r.id)!;
    expect(c.capture).toBe('needs_review');
    expect(c.group).toBe('needs_decision');
    // Reading again would overwrite an extracted original, so it is refused.
    await expect(applyExtraction(repo, r.id, { id: adapter.id, kind: 'ocr' }, result)).rejects.toThrow('only available for an uploaded receipt');
  });

  it('T19 (grep) no domain function reads printedText other than the display formatter', () => {
    const root = join(process.cwd(), 'src', 'domain');
    // A "read" is property access (`x.printedText`, `x['printedText']`) or destructuring it.
    const READ = /\.printedText\b|\[\s*['"]printedText['"]\s*\]|\{[^}]*\bprintedText\b[^}]*\}\s*=/;
    const allowed = new Set(['capture/display.ts']);
    const readers = filesUnder(root)
      .filter((f) => READ.test(readFileSync(f, 'utf8')))
      .map((f) => relative(root, f).split('\\').join('/'));
    expect(readers.filter((f) => !allowed.has(f))).toEqual([]);
    expect(readers).toContain('capture/display.ts');
  });
});
