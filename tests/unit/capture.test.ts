import { describe, expect, it } from 'vitest';
import { detectDuplicatePurchases } from '../../src/domain/capture/duplicates';
import { prefillMapping } from '../../src/domain/imports/mapping';
import { parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { deriveMetrics } from '../../src/domain/metrics';
import { deriveWorkspaceView } from '../../src/domain/views';
import {
  addReceipts,
  importStatement,
  recordProposal,
  resolveDuplicate,
  resolveStatementDuplicate,
  saveFields,
  DUPLICATE_MESSAGES,
} from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { sha256Hex } from '../../src/persistence/hash';
import type { Repository } from '../../src/persistence/repository';
import { distinctDecision, input, receipt, recorded, tx } from '../builders';
import { describeEachRepo, makeRepo } from '../helpers/repos';

const same = { merchant: 'Page Corner', date: '2026-03-02', amount: 12000 } as const;
const s101 = tx({ row: 2, ref: 'S-101', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });

describe('possible duplicate purchases (pure)', () => {
  it('T11 identical amount/merchant on two different files is flagged for review, never discarded', () => {
    const a = receipt({ id: 'R-801', ...same, doc: 'DOC-A' });
    const b = receipt({ id: 'R-802', ...same, doc: 'DOC-B' });
    const flags = detectDuplicatePurchases([a, b], [], [], []);
    expect(flags.get('R-801')).toEqual(['R-802']);
    expect(flags.get('R-802')).toEqual(['R-801']);

    const result = evaluateWorkspace(input({ receipts: [a, b], transactions: [s101] }));
    for (const id of ['R-801', 'R-802']) {
      const p = result.proposals.get(id)!;
      expect(p.outcome).toBe('blocked');
      expect(p.flags).toEqual(['duplicate_suspected']);
    }
    // Both are kept as active receipts; nothing is set aside automatically.
    expect([a, b].map((r) => r.disposition)).toEqual(['active', 'active']);
    expect(result.proposals.size).toBe(2);
  });

  it('T11 after "These are different purchases" both receipts evaluate normally again', () => {
    const a = receipt({ id: 'R-801', ...same, doc: 'DOC-A' });
    const b = receipt({ id: 'R-802', ...same, doc: 'DOC-B' });
    const decisions = [distinctDecision(1, 'R-801', 'R-802')];
    expect(detectDuplicatePurchases([a, b], [], [], decisions).size).toBe(0);
    const result = evaluateWorkspace(input({ receipts: [a, b], transactions: [s101], decisions }));
    // Both now compete for the single S-101: ambiguous, not blocked as duplicates.
    expect(result.proposals.get('R-801')!.flags).toEqual([]);
    expect(result.proposals.get('R-801')!.outcome).toBe('ambiguous');
    expect(result.proposals.get('R-802')!.outcome).toBe('ambiguous');
  });

  it('T11 (M1) a new upload duplicating recorded R-101 flags only the new, unlinked receipt', () => {
    const r101 = receipt({ id: 'R-101', ...same, doc: 'DOC-101' });
    const again = receipt({ id: 'R-811', ...same, doc: 'DOC-PHOTO-2' });
    const { match, entry } = recorded({ n: 1, receipt: r101, transaction: s101 });
    const flags = detectDuplicatePurchases([r101, again], [match], [entry], []);
    expect(flags.has('R-101')).toBe(false);
    expect(flags.get('R-811')).toEqual(['R-101']);
    const result = evaluateWorkspace(input({ receipts: [r101, again], transactions: [s101], matches: [match], ledgerEntries: [entry] }));
    expect(result.proposals.has('R-101')).toBe(false); // recorded: not re-evaluated
    expect(result.proposals.get('R-811')!.flags).toEqual(['duplicate_suspected']);
  });

  it('T11 (N10) the same merchant and amount on different dates is not a suspected duplicate', () => {
    const a = receipt({ id: 'R-821', ...same, doc: 'DOC-A' });
    const b = receipt({ id: 'R-822', ...same, date: '2026-03-09', doc: 'DOC-B' });
    expect(detectDuplicatePurchases([a, b], [], [], []).size).toBe(0);
    const s2 = tx({ row: 3, ref: 'S-822', label: 'PAGE CORNER', posting: '2026-03-10', amount: 12000 });
    const result = evaluateWorkspace(input({ receipts: [a, b], transactions: [s101, s2] }));
    expect(result.proposals.get('R-821')!.outcome).toBe('unique_candidate');
    expect(result.proposals.get('R-822')!.outcome).toBe('unique_candidate');
  });

  it('T11 receipts from the same file, unvalidated receipts and set-aside receipts are not flagged', () => {
    const a = receipt({ id: 'R-831', ...same, doc: 'DOC-SAME' });
    const b = receipt({ id: 'R-832', ...same, doc: 'DOC-SAME' });
    expect(detectDuplicatePurchases([a, b], [], [], []).size).toBe(0);
    const manual = receipt({ id: 'R-833', ...same, doc: 'DOC-M', adapter: 'manual', confirmed: false });
    expect(detectDuplicatePurchases([a, manual], [], [], []).size).toBe(0);
    const aside = receipt({ id: 'R-834', ...same, doc: 'DOC-X', disposition: 'set_aside_duplicate' });
    expect(detectDuplicatePurchases([a, aside], [], [], []).size).toBe(0);
  });

  it('T11 a card row held for duplicate review is never a candidate and blocks a proposal on another row', () => {
    const r = receipt({ id: 'R-841', ...same });
    const held = tx({ file: 'b.csv', row: 2, ref: 'S-841', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000, duplicateSuspected: true, duplicateOf: s101.id });
    const onlyHeld = evaluateWorkspace(input({ receipts: [r], transactions: [held] }));
    expect(onlyHeld.proposals.get('R-841')!.outcome).toBe('unmatched');
    expect(onlyHeld.proposals.get('R-841')!.heldIds).toEqual([held.id]);
    expect(onlyHeld.transactionFlags.get(held.id)?.flags).toEqual(['duplicate_suspected']);

    const both = evaluateWorkspace(input({ receipts: [r], transactions: [s101, held] }));
    const p = both.proposals.get('R-841')!;
    expect(p.outcome).toBe('ambiguous');
    expect(p.transactionId).toBeNull();
    expect(both.transactionFlags.get(held.id)?.explanation).toBe('Possible duplicate of S-101 from another file. Keep both or set this row aside.');

    const kept = { ...held, duplicateResolution: 'kept' as const };
    expect(evaluateWorkspace(input({ receipts: [r], transactions: [kept] })).proposals.get('R-841')!.outcome).toBe('unique_candidate');
  });
});

// ---------------------------------------------------------------------------
// Resolving possible duplicates through the commands (design §10.2, M1)

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CARD = { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' };
const FIELDS = { merchant: 'Page Corner', date: '2026-03-02', amount: '120.00', currency: 'HKD' };

function personalRepo(): Repository {
  return makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
}

async function addPng(repo: Repository, name: string, tag: number): Promise<string> {
  const bytes = new Uint8Array([...PNG_HEAD, tag]);
  const result = await addReceipts(repo, [{ fileName: name, mimeType: 'image/png', bytes, sha256: await sha256Hex(bytes) }]);
  return result.added[0]!;
}

/** A card CSV without a reference column (like the example file), ISO dates, positive charges. */
async function importCsv(repo: Repository, name: string, rows: string[]): Promise<string[]> {
  const text = ['Posting date,Description,Amount', ...rows].join('\n');
  const bytes = new TextEncoder().encode(text);
  const sha = await sha256Hex(bytes);
  const grid = readCsvGrid(text);
  const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'positive_charges', defaultCurrency: 'HKD' }, CARD, {
    sha256: sha,
    sourceDocumentId: 'DOC-PENDING',
    workspaceId: 'personal',
  });
  const result = await importStatement(repo, { fileName: name, mimeType: 'text/csv', bytes, sha256: sha }, parsed, CARD, 'all_rows');
  if (result.kind !== 'imported') throw new Error('expected an import');
  return result.transactionIds;
}

async function viewOf(repo: Repository) {
  const s = await repo.loadSnapshot();
  const state = asWorkspaceState(s);
  const view = deriveWorkspaceView(state);
  return { s, view, metrics: deriveMetrics(state, view, deriveWorkspaceView(state, [])) };
}

describeEachRepo('resolving possible duplicates (commands)', () => {
  it('T11 two different photos with the same fields are both kept and flagged; "These are different purchases" clears the flag', async () => {
    const repo = personalRepo();
    const a = await addPng(repo, 'lunch.png', 1);
    const b = await addPng(repo, 'lunch-again.png', 2);
    await saveFields(repo, a, FIELDS);
    await saveFields(repo, b, FIELDS);
    let { s, view } = await viewOf(repo);
    expect(s.receipts.map((r) => r.disposition)).toEqual(['active', 'active']);
    expect(view.caseById.get(a)!.flags).toEqual(['duplicate_suspected']);
    expect(view.caseById.get(b)!.flags).toEqual(['duplicate_suspected']);
    expect(view.caseById.get(b)!.explanation).toBe(`Possible duplicate of ${a} from another file. Choose “These are different purchases” or set this one aside.`);

    expect(await resolveDuplicate(repo, b, 'distinct')).toEqual({ decisionIds: ['D-0001'] });
    ({ s, view } = await viewOf(repo));
    expect(s.decisions).toMatchObject([{ id: 'D-0001', kind: 'duplicate_resolution', choice: 'distinct', subjectIds: [b, a] }]);
    expect(s.receipts.map((r) => r.disposition)).toEqual(['active', 'active']);
    expect(view.caseById.get(a)!.flags).toEqual([]);
    expect(view.caseById.get(b)!.flags).toEqual([]);
    const ev = s.audit.at(-1)!;
    expect(ev.action).toBe('capture.duplicate_resolved');
    expect(ev.affected).toEqual([
      { kind: 'receipt', id: b },
      { kind: 'receipt', id: a },
    ]);
    expect(ev.after).toMatchObject({ choice: 'distinct', decisionIds: ['D-0001'] });

    // Nothing left to resolve: refused, nothing written.
    const before = await repo.loadSnapshot();
    await expect(resolveDuplicate(repo, a, 'distinct')).rejects.toThrow(DUPLICATE_MESSAGES.receiptNotFlagged);
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it('T11 "Set this one aside as a duplicate" leaves the groups and the counts; the other receipt evaluates normally', async () => {
    const repo = personalRepo();
    const a = await addPng(repo, 'lunch.png', 1);
    const b = await addPng(repo, 'lunch-again.png', 2);
    await saveFields(repo, a, FIELDS);
    await saveFields(repo, b, FIELDS);
    await importCsv(repo, 'march.csv', ['2026-03-03,PAGE CORNER,120.00']);
    await resolveDuplicate(repo, b, 'set_aside');
    const { s, view, metrics } = await viewOf(repo);
    expect(s.receipts.find((r) => r.id === b)!.disposition).toBe('set_aside_duplicate');
    expect(view.caseById.get(b)!.group).toBeNull();
    expect(view.caseById.get(b)!.reconciliation).toBe('not_applicable');
    expect(view.groups.setAside.map((c) => c.receiptId)).toEqual([b]);
    expect(view.caseById.get(a)!.group).toBe('ready');
    expect(metrics.uniqueReceipts).toBe(1);
    expect(s.decisions).toMatchObject([{ choice: 'set_aside', subjectIds: [b, a] }]);
    expect(s.audit.at(-1)!).toMatchObject({ action: 'capture.duplicate_resolved', after: { choice: 'set_aside', disposition: 'set_aside_duplicate' } });
  });

  it('T11 (M1) a duplicate of recorded R-0001 flags only the new receipt; set-aside of the recorded one is refused', async () => {
    const repo = personalRepo();
    const first = await addPng(repo, 'lunch.png', 1);
    await saveFields(repo, first, FIELDS);
    await importCsv(repo, 'march.csv', ['2026-03-03,PAGE CORNER,120.00']);
    let { view } = await viewOf(repo);
    await recordProposal(repo, view.caseById.get(first)!.proposal!);
    const again = await addPng(repo, 'lunch-photo-2.png', 2);
    await saveFields(repo, again, FIELDS);
    ({ view } = await viewOf(repo));
    expect(view.caseById.get(first)!.group).toBe('recorded');
    expect(view.caseById.get(first)!.flags).toEqual([]);
    expect(view.caseById.get(again)!.flags).toEqual(['duplicate_suspected']);

    const before = await repo.loadSnapshot();
    for (const choice of ['set_aside', 'distinct'] as const) {
      await expect(resolveDuplicate(repo, first, choice)).rejects.toThrow('This one is recorded. Void its entry first.');
    }
    expect(await repo.loadSnapshot()).toEqual(before);

    // The new one can be resolved; the recorded entry is untouched.
    await resolveDuplicate(repo, again, 'set_aside');
    const after = await repo.loadSnapshot();
    expect(after.ledger).toEqual(before.ledger);
    expect(after.matches).toEqual(before.matches);
  });

  it('T11 (M1) an overlapping re-import flags only incoming rows; "Keep both" marks only the flagged row; linked rows are refused', async () => {
    const repo = personalRepo();
    const r = await addPng(repo, 'lunch.png', 1);
    await saveFields(repo, r, FIELDS);
    const [s1, s2] = (await importCsv(repo, 'march.csv', ['2026-03-03,PAGE CORNER,120.00', '2026-03-05,CITY PARKING,30.00'])) as [string, string];
    const first = await viewOf(repo);
    await recordProposal(repo, first.view.caseById.get(r)!.proposal!);
    const existing = (await repo.loadSnapshot()).transactions;

    // A second, slightly different file repeats both rows.
    const [n1, n2, n3] = (await importCsv(repo, 'march-export.csv', ['2026-03-03,PAGE CORNER,120.00', '2026-03-05,CITY PARKING,30.00', '2026-03-06,PAGE CORNER,9.00'])) as [string, string, string];
    let { s, view } = await viewOf(repo);
    // Existing rows (one of them linked) are unchanged; only incoming rows carry the flag.
    expect(s.transactions.filter((t) => t.id === s1 || t.id === s2)).toEqual(existing);
    expect(s.transactions.find((t) => t.id === n1)).toMatchObject({ duplicateSuspected: true, duplicateOf: s1, duplicateResolution: null });
    expect(s.transactions.find((t) => t.id === n2)).toMatchObject({ duplicateSuspected: true, duplicateOf: s2, duplicateResolution: null });
    expect(s.transactions.find((t) => t.id === n3)).toMatchObject({ duplicateSuspected: false });
    expect(view.transactionCases.find((c) => c.transactionId === n1)?.explanation).toBe(`Possible duplicate of ${s1} from another file. Keep both or set this row aside.`);

    // Linked or recorded rows are refused, rows without a flag too, and nothing is written.
    const before = await repo.loadSnapshot();
    for (const choice of ['keep', 'set_aside'] as const) {
      await expect(resolveStatementDuplicate(repo, s1, choice)).rejects.toThrow('This one is recorded. Void its entry first.');
    }
    await expect(resolveStatementDuplicate(repo, n3, 'keep')).rejects.toThrow(DUPLICATE_MESSAGES.rowNotFlagged);
    expect(await repo.loadSnapshot()).toEqual(before);

    // "Keep both" on the flagged row only.
    await resolveStatementDuplicate(repo, n2, 'keep');
    ({ s, view } = await viewOf(repo));
    expect(s.transactions.find((t) => t.id === n2)!.duplicateResolution).toBe('kept');
    expect(s.transactions.find((t) => t.id === s2)).toEqual(existing.find((t) => t.id === s2));
    expect(view.transactionCases.find((c) => c.transactionId === n2)?.flags).toEqual(['missing_receipt']);
    expect(s.audit.at(-1)!).toMatchObject({ action: 'import.rows_kept', affected: [{ kind: 'transaction', id: n2 }] });

    // "Set aside this row": never a candidate, out of the totals and of the rows to check.
    const spendBefore = (await viewOf(repo)).metrics.cardSpendingWithoutRecordMinor;
    await resolveStatementDuplicate(repo, n1, 'set_aside');
    const done = await viewOf(repo);
    expect(done.s.transactions.find((t) => t.id === n1)!.intake).toBe('set_aside_duplicate');
    expect(done.view.transactionCases.some((c) => c.transactionId === n1)).toBe(false);
    expect(done.metrics.cardSpendingWithoutRecordMinor).toBe(spendBefore - 12000);
    expect(done.s.audit.at(-1)!).toMatchObject({ action: 'import.row_set_aside', affected: [{ kind: 'transaction', id: n1 }] });
    expect(done.s.ledger).toEqual(before.ledger);
  });
});
