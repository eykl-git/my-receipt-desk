/**
 * O01 workspace currency (brief §26 A, task 4.7, REQ-20). My files can use
 * HKD (default) or MYR, chosen only while the workspace is empty. The safety
 * invariant becomes "same currency as the workspace, exact to the cent, never
 * converted". The demo stays HKD.
 */
import { expect, it } from 'vitest';
import { prefillMapping } from '../../src/domain/imports/mapping';
import { parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { checkManualResolution } from '../../src/domain/matching/manual';
import { deriveMetrics } from '../../src/domain/metrics';
import { deriveWorkspaceView } from '../../src/domain/views';
import { SAFETY_INVARIANTS } from '../../src/domain/knowledge/safety';
import { addReceipts, CURRENCY_MESSAGES, importStatement, loadDemoBatch, saveFields, setWorkspaceCurrency } from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { sha256Hex } from '../../src/persistence/hash';
import { input, receipt, tx } from '../builders';
import { describeEachRepo, makeRepo } from '../helpers/repos';
import { assets } from '../helpers/tour';

const myr = (row: number, label: string, posting: string, amount: number, currency = 'MYR') =>
  tx({ file: 'my.csv', row, ref: `M-${row}`, label, posting, amount, currency, intake: 'available', account: 'Maybank 5678' });

it('O01 (engine) an MYR receipt matches an MYR row in an MYR workspace; an HKD receipt there is unsupported; amounts stay exact', () => {
  const receipts = [
    receipt({ id: 'R-1', merchant: 'Kedai Contoh', date: '2026-03-14', amount: 2300, currency: 'MYR' }),
    receipt({ id: 'R-2', merchant: 'Kedai Contoh', date: '2026-03-15', amount: 1250, currency: 'HKD' }),
    receipt({ id: 'R-3', merchant: 'Kedai Contoh', date: '2026-03-16', amount: 1250, currency: 'MYR' }),
  ];
  const transactions = [myr(2, 'KEDAI CONTOH', '2026-03-15', 2300), myr(3, 'KEDAI CONTOH', '2026-03-16', 1250, 'HKD'), myr(4, 'KEDAI CONTOH', '2026-03-17', 1249)];
  const result = evaluateWorkspace(input({ receipts, transactions, workspaceCurrency: 'MYR' }));
  const r1 = result.proposals.get('R-1')!;
  expect(r1.outcome).toBe('unique_candidate');
  expect(r1.transactionId).toBe(transactions[0]!.id);
  expect(r1.trace.find((t) => t.check === 'currency')!.message).toBe('Currency is MYR.');
  const r2 = result.proposals.get('R-2')!;
  expect(r2.flags).toEqual(['unsupported_input']);
  expect(r2.explanation).toBe('HKD is not supported in this workspace, which uses MYR. Nothing was converted.');
  // MYR 12.50 vs a MYR 12.49 row: exact to the cent, so no candidate.
  expect(result.proposals.get('R-3')!.candidateIds).toEqual([]);

  // The same data in an HKD workspace (the default): the MYR receipt is the unsupported one.
  const hkd = evaluateWorkspace(input({ receipts, transactions }));
  expect(hkd.proposals.get('R-1')!.flags).toEqual(['unsupported_input']);
  expect(hkd.proposals.get('R-1')!.explanation).toBe('MYR is not supported in this prototype. Nothing was converted.');

  // Manual resolution refuses a currency other than the workspace's; nothing is converted.
  const manual = checkManualResolution(input({ receipts, transactions, workspaceCurrency: 'MYR' }), { receiptId: 'R-2', transactionId: transactions[1]!.id, reason: 'same purchase' });
  expect(manual.ok).toBe(false);
  if (!manual.ok) expect(manual.error.message).toBe('HKD is not supported in this workspace, which uses MYR. Nothing was converted.');
});

it('O01 (import) in an MYR workspace HKD rows are quarantined and the preview totals the MYR debits exactly', () => {
  const text = 'Date,Posted,Details,Amount,Currency\n14/03/2026,15/03/2026,KEDAI CONTOH,-23.00,MYR\n15/03/2026,16/03/2026,KEDAI LAIN,-12.35,MYR\n16/03/2026,17/03/2026,HK SHOP,-80.00,HKD\n';
  const grid = readCsvGrid(text);
  const account = { accountId: 'acct:maybank-5678', accountLabel: 'Maybank 5678' };
  const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'DD/MM/YYYY', amountSign: 'negative_charges', defaultCurrency: 'MYR' }, account, {
    sha256: 'a'.repeat(64),
    sourceDocumentId: 'DOC-PENDING',
    workspaceId: 'personal',
    workspaceCurrency: 'MYR',
  });
  expect(parsed.errors).toEqual([]);
  expect(parsed.preview).toMatchObject({ currency: 'MYR', totalRows: 3, validRows: 3, quarantinedRows: [4], hkdDebitRows: 2, hkdDebitTotalMinor: 3535, otherCurrencyTotals: [{ currency: 'HKD', totalMinor: 8000 }] });
  expect(parsed.rows.map((r) => r.intake)).toEqual(['available', 'available', 'quarantined_currency']);
});

it('O01 the safety card states the generalised invariant', () => {
  expect(SAFETY_INVARIANTS.find((s) => s.id === 'S-1')!.title).toBe('Same currency as the workspace (HKD, or MYR in My files); no conversion');
});

describeEachRepo('O01 workspace currency setting', () => {
  it('O01 My files switches to MYR only while empty; afterwards the change is refused with the visible reason', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    expect((await repo.loadSnapshot()).currency).toBe('HKD');
    expect(await setWorkspaceCurrency(repo, 'MYR')).toEqual({ changed: true });
    expect(await setWorkspaceCurrency(repo, 'HKD')).toEqual({ changed: true });
    expect(await setWorkspaceCurrency(repo, 'MYR')).toEqual({ changed: true });
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const { added } = await addReceipts(repo, [{ fileName: 'resit.png', mimeType: 'image/png', bytes, sha256: await sha256Hex(bytes) }]);
    const before = await repo.loadSnapshot();
    await expect(setWorkspaceCurrency(repo, 'HKD')).rejects.toThrow(CURRENCY_MESSAGES.locked);
    expect(await repo.loadSnapshot()).toEqual(before);
    expect(before.audit.map((a) => a.action)).toEqual(['capture.receipt_added']);

    // An MYR import and an MYR receipt then match; the totals are in MYR.
    const text = 'Date,Posted,Details,Amount,Currency\n14/03/2026,15/03/2026,KEDAI CONTOH,-23.00,MYR\n';
    const csv = new TextEncoder().encode(text);
    const sha = await sha256Hex(csv);
    const grid = readCsvGrid(text);
    const account = { accountId: 'acct:maybank-5678', accountLabel: 'Maybank 5678' };
    const conventions = { dateFormat: 'DD/MM/YYYY' as const, amountSign: 'negative_charges' as const, defaultCurrency: 'MYR' };
    const wrong = parseStatementCsv(grid, prefillMapping(grid.header), conventions, account, { sha256: sha, sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal' });
    await expect(importStatement(repo, { fileName: 'my.csv', mimeType: 'text/csv', bytes: csv, sha256: sha }, wrong, account, 'all_rows')).rejects.toThrow('The workspace currency changed');
    const parsed = parseStatementCsv(grid, prefillMapping(grid.header), conventions, account, { sha256: sha, sourceDocumentId: 'DOC-PENDING', workspaceId: 'personal', workspaceCurrency: 'MYR' });
    await importStatement(repo, { fileName: 'my.csv', mimeType: 'text/csv', bytes: csv, sha256: sha }, parsed, account, 'all_rows');
    await saveFields(repo, added[0]!, { merchant: 'Kedai Contoh', date: '2026-03-14', amount: '23.00', currency: 'MYR' });
    const s = await repo.loadSnapshot();
    const state = asWorkspaceState(s);
    const view = deriveWorkspaceView(state);
    expect(view.caseById.get(added[0]!)!.group).toBe('ready');
    const m = deriveMetrics(state, view, deriveWorkspaceView(state, []));
    expect(m.currency).toBe('MYR');
    expect(m.cardSpendingWithoutRecordMinor).toBe(2300);
  });

  it('O01 the demo workspace is locked to HKD and its tour is unchanged', async () => {
    const demo = makeRepo('demo');
    await expect(setWorkspaceCurrency(demo, 'MYR')).rejects.toThrow(CURRENCY_MESSAGES.demoLocked);
    await loadDemoBatch(demo, 1, assets);
    const s = await demo.loadSnapshot();
    expect(s.currency).toBe('HKD');
    const view = deriveWorkspaceView(asWorkspaceState(s));
    expect(view.groups.ready.map((c) => c.receiptId)).toEqual(['R-101']);
  });
});
