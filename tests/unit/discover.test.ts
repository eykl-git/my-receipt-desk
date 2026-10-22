/**
 * K01 knowledge-gap discovery (brief §25 A, task 3.6). Deterministic, read-only:
 * it can only point at a case; it never drafts, activates or records anything.
 */
import { describe, expect, it } from 'vitest';
import { discoverKnowledgeGaps, gapText } from '../../src/domain/knowledge/discover';
import { deriveWorkspaceView } from '../../src/domain/views';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { loadDemoBatch } from '../../src/persistence/commands';
import { deepFreeze, receipt, tx } from '../builders';
import { assets, demoRepo, teachAlias, tourToConfirmedR102, viewOf } from '../helpers/tour';

describe('K01 knowledge-gap discovery', () => {
  it('K01 Batch 1 shows one gap for MC COFFEE HK covering two receipts, from a real preview, and writes nothing', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s = await repo.loadSnapshot();
    const state = deepFreeze(structuredClone(asWorkspaceState(s)));
    const view = viewOf(s);
    const gaps = discoverKnowledgeGaps(state, view);
    expect(gaps).toHaveLength(1);
    const g = gaps[0]!;
    expect(g).toMatchObject({
      observedLabel: 'MC COFFEE HK',
      accountLabel: 'Demo Card ••1234',
      merchantName: 'Morning Cup',
      receiptIds: ['R-102', 'R-103'],
      wouldBecomeReady: ['R-102', 'R-103'],
      confirmedTimes: 0,
      reviewReceiptId: 'R-102',
    });
    expect(gapText(g)).toBe('2 receipts are waiting on one unknown card name: “MC COFFEE HK” (Demo Card ••1234) for Morning Cup. Check one to teach it.');
    // Read-only: the stored state, the rules and every evaluation outcome are unchanged.
    expect(await repo.loadSnapshot()).toEqual(s);
    expect(s.ruleHeads).toEqual([]);
    expect(viewOf(s)).toEqual(view);
  });

  it('K01 apply-once path: the confirmation is counted, and Batch 2 shows the gap again for R-103, R-201 and R-202', async () => {
    const repo = await tourToConfirmedR102();
    let s = await repo.loadSnapshot();
    let gaps = discoverKnowledgeGaps(asWorkspaceState(s), viewOf(s));
    expect(gaps.map((g) => [g.receiptIds, g.confirmedTimes])).toEqual([[['R-103'], 1]]);
    expect(gapText(gaps[0]!)).toBe(
      "1 receipt is waiting on one unknown card name: “MC COFFEE HK” (Demo Card ••1234) for Morning Cup. Check one to teach it. You've confirmed it 1 time.",
    );
    await loadDemoBatch(repo, 2, assets);
    s = await repo.loadSnapshot();
    gaps = discoverKnowledgeGaps(asWorkspaceState(s), viewOf(s));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.receiptIds).toEqual(['R-103', 'R-201', 'R-202']);
    expect(gaps[0]!.wouldBecomeReady).toEqual(['R-103', 'R-201', 'R-202']);
    expect(gaps[0]!.reviewReceiptId).toBe('R-103');
  });

  it('K01 the gap disappears once K-ALIAS-0001 is active (also after Batches 2 and 3)', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    for (const n of [null, 2, 3] as const) {
      if (n) await loadDemoBatch(repo, n, assets);
      const s = await repo.loadSnapshot();
      expect(discoverKnowledgeGaps(asWorkspaceState(s), viewOf(s))).toEqual([]);
    }
  });

  it('K01 generic processor labels are never offered as a gap', () => {
    const receipts = [receipt({ id: 'R-1', merchant: 'Page Corner', date: '2026-03-02', amount: 1000 })];
    const transactions = [tx({ row: 2, ref: 'S-1', label: 'SQ *PAGE CORNER', posting: '2026-03-03', amount: 1000 })];
    const state = { receipts, transactions, matches: [], ledger: [], decisions: [], payables: [], ruleHeads: [], ruleVersions: [] };
    const view = deriveWorkspaceView(state);
    expect(view.caseById.get('R-1')!.group).toBe('needs_decision');
    expect(discoverKnowledgeGaps(state, view)).toEqual([]);
  });
});
