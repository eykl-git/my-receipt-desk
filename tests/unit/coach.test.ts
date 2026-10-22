import { describe, expect, it } from 'vitest';
import { coachSentence, coachText, STEP_2_TEXT } from '../../src/demo/coach';
import { aliasRule, head } from '../builders';
import { deriveWorkspaceView } from '../../src/domain/views';
import { capitalize, joinAnd, numberWord } from '../../src/domain/words';
import { receipt, tx } from '../builders';

describe('coach text wording', () => {
  it('numbers 1–10 are words, larger numbers digits; sentences start with a capital', () => {
    expect([1, 2, 10, 11, 25].map(numberWord)).toEqual(['one', 'two', 'ten', '11', '25']);
    expect(capitalize(numberWord(4))).toBe('Four');
    expect(joinAnd(['a'])).toBe('a');
    expect(joinAnd(['a', 'b'])).toBe('a and b');
    expect(joinAnd(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('the tour bar sentence drops the "Step N of 4 · " prefix that its indicator already shows', () => {
    expect(coachSentence(STEP_2_TEXT)).toBe('Open R-102, confirm its card transaction, then propose the card name as reusable knowledge.');
    expect(coachSentence('Step 3 of 4 · Batch 2 is loaded.')).toBe('Batch 2 is loaded.');
  });

  it('step 2 follows the state: instruction, then the one-off confirmation, then the active rule and what it changed', () => {
    const receipts = [
      receipt({ id: 'R-102', merchant: 'Morning Cup', date: '2026-03-04', amount: 4800 }),
      receipt({ id: 'R-103', merchant: 'Morning Cup', date: '2026-03-06', amount: 6200 }),
    ];
    const transactions = [tx({ row: 4, ref: 'S-103', label: 'MC COFFEE HK', posting: '2026-03-07', amount: 6200 })];
    const base = { receipts, transactions, matches: [], ledger: [], decisions: [], payables: [], ruleHeads: [], ruleVersions: [] };
    const none = deriveWorkspaceView(base);
    expect(coachText(2, none, { receipts, transactions, matches: [], audit: [] })).toBe(STEP_2_TEXT);

    const alias = aliasRule();
    const withRule = deriveWorkspaceView({ ...base, ruleHeads: [head(alias)], ruleVersions: [alias] });
    expect(coachText(2, withRule, { receipts, transactions, matches: [], audit: [], demoState: { loadedBatches: [1] } })).toBe(
      'Step 2 of 4 · Rule K-ALIAS-0001 v1 is active. R-103 is now ready without another decision. Next: load Batch 2.',
    );
    // With every listed batch loaded there is no "Next: load …" clause.
    expect(coachText(2, withRule, { receipts, transactions, matches: [], audit: [], demoState: { loadedBatches: [1, 2, 3] } })).toBe(
      'Step 2 of 4 · Rule K-ALIAS-0001 v1 is active. R-103 is now ready without another decision.',
    );
    // S5: a suspended alias is named as suspended; the text never says no rule was created.
    const suspendedHead = head(alias, 'suspended');
    const heads = [suspendedHead];
    const suspended = deriveWorkspaceView({ ...base, ruleHeads: heads, ruleVersions: [alias] });
    const text = coachText(2, suspended, { receipts, transactions, matches: [], audit: [], demoState: { loadedBatches: [1] }, ruleHeads: heads });
    expect(text).toBe('Step 2 of 4 · Rule K-ALIAS-0001 v1 is suspended, so it is not applied. Reactivate it from “View history”, or continue without it. Next: load Batch 2.');
    expect(text).not.toContain('No rule was created');
  });

  it('step 4 renders only the clauses the state shows (A only, B only, USD only, none; A+USD and B+USD are in T23)', () => {
    const empty = { matches: [], ledger: [], decisions: [], payables: [], ruleHeads: [], ruleVersions: [] };
    const prefix = 'Step 4 of 4 · Batch 3: The boundary still holds. ';
    const render = (receipts: ReturnType<typeof receipt>[], transactions: ReturnType<typeof tx>[], rules: ReturnType<typeof aliasRule>[] = []) => {
      const view = deriveWorkspaceView({ ...empty, receipts, transactions, ruleHeads: rules.map((r) => head(r)), ruleVersions: rules });
      return coachText(4, view, { receipts, transactions, matches: [], audit: [] });
    };
    const mc = [receipt({ id: 'R-1', merchant: 'Morning Cup', date: '2026-03-24', amount: 4500 })];
    const mcTx = [
      tx({ row: 2, ref: 'S-1A', label: 'MC COFFEE HK', posting: '2026-03-25', amount: 4500 }),
      tx({ row: 3, ref: 'S-1B', label: 'MC COFFEE HK', posting: '2026-03-26', amount: 4500 }),
    ];
    expect(render(mc, mcTx, [aliasRule()])).toBe(`${prefix}A known name still can't pick between two equal payments, and receipt text can't change your rules.`);

    const pc = [receipt({ id: 'R-2', merchant: 'Page Corner', date: '2026-03-02', amount: 1000 })];
    const pcTx = [
      tx({ row: 2, ref: 'S-2A', label: 'PAGE CORNER', posting: '2026-03-02', amount: 1000 }),
      tx({ row: 3, ref: 'S-2B', label: 'PAGE CORNER', posting: '2026-03-03', amount: 1000 }),
    ];
    expect(render(pc, pcTx)).toBe(`${prefix}Two equal payments still come back to you, and receipt text can't change your rules.`);

    const usd = [receipt({ id: 'R-3', merchant: 'Harbour Books Online', date: '2026-03-25', amount: 2500, currency: 'USD' })];
    expect(render(usd, [])).toBe(`${prefix}USD is not converted, and receipt text can't change your rules.`);

    const plain = [receipt({ id: 'R-4', merchant: 'Page Corner', date: '2026-03-02', amount: 1000 })];
    expect(render(plain, [pcTx[0]!])).toBe(`${prefix}Receipt text can't change your rules.`);
  });

  it('step 1 reads only what the state shows: no ready receipt, one unclear date, other reasons', () => {
    const receipts = [
      receipt({ id: 'R-1', merchant: 'Page Corner', date: null, amount: 1000, unclear: { date: '2026-0?-02' } }),
      receipt({ id: 'R-2', merchant: 'Page Corner', date: '2026-03-02', amount: 1000 }),
    ];
    const view = deriveWorkspaceView({ receipts, transactions: [], matches: [], ledger: [], decisions: [], payables: [], ruleHeads: [], ruleVersions: [] });
    expect(coachText(1, view, { receipts, transactions: [], matches: [], audit: [] })).toBe(
      'Step 1 of 4 · Batch 1: First encounter. No receipt is ready yet. Two need you: one unclear date and one for other reasons.',
    );
  });

  it('step 1 with one pending receipt uses the singular, and differing labels are not named', () => {
    const receipts = [receipt({ id: 'R-1', merchant: 'Morning Cup', date: '2026-03-04', amount: 4800 })];
    const transactions = [tx({ row: 2, ref: 'S-1', label: 'MC COFFEE HK', posting: '2026-03-05', amount: 4800 })];
    const view = deriveWorkspaceView({ receipts, transactions, matches: [], ledger: [], decisions: [], payables: [], ruleHeads: [], ruleVersions: [] });
    expect(coachText(1, view, { receipts, transactions, matches: [], audit: [] })).toBe(
      'Step 1 of 4 · Batch 1: First encounter. No receipt is ready yet. One needs you: one because the card shows “MC COFFEE HK”, a name the desk doesn\'t know yet.',
    );
  });
});
