/**
 * T23: guided-demo counters and coach text are derived from actual state on
 * both paths (design §8 counter table, §9.1, review-3 amendments N1 and N2).
 */
import { describe, expect, it } from 'vitest';
import { coachText, STEP_2_TEXT } from '../../src/demo/coach';
import { deriveMetrics, type Metrics } from '../../src/domain/metrics';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { advanceTourStep, confirmCaseOnly, loadDemoBatch, newRecordRun, recordAllReady, recordProposal } from '../../src/persistence/commands';
import type { Repository } from '../../src/persistence/repository';
import { describeEachRepo } from '../helpers/repos';
import { buildFixtureSnapshot } from '../../src/persistence/fixtureSnapshot';
import { compareReplay, selectCompareTarget } from '../../src/demo/compare';
import { aliasRule, categoryRule, head, policyRule } from '../builders';
import { assets, demoRepo, teachAlias, tourToConfirmedR102, txIdByRef, viewOf } from '../helpers/tour';

interface Row {
  unique: number;
  ready: number;
  needs: number;
  recorded: number;
  confirmed: number;
  linked: number;
  active: number;
  newly: number;
  rulesUsed: number;
  coverage: [number, number];
  paid: number;
  spending: number;
  cardRows: number;
  unpaid: number;
}

async function measure(repo: Repository) {
  const s = await repo.loadSnapshot();
  const current = viewOf(s);
  const baseline = viewOf(s, []);
  const m = deriveMetrics(asWorkspaceState(s), current, baseline);
  const coach = coachText(s.demoState.tourStep, current, s);
  return { s, m, coach };
}

function row(m: Metrics): Row {
  return {
    unique: m.uniqueReceipts,
    ready: m.ready,
    needs: m.needsDecision,
    recorded: m.recorded,
    confirmed: m.receiptsWithConfirmedMatches,
    linked: m.linkedTransactions,
    active: m.activeRules,
    newly: m.newlyReady.length,
    rulesUsed: m.rulesUsedInRecorded.length,
    coverage: [m.safeProposals.x, m.safeProposals.y],
    paid: m.recordedPaidMinor,
    spending: m.cardSpendingWithoutRecordMinor,
    cardRows: m.cardRowsNeedingAttention,
    unpaid: m.unpaidInvoicesMinor,
  };
}

/** Identities asserted at every row (design §8 notes). */
function identities(m: Metrics, hkdDebitTotal: number) {
  expect(m.ready + m.needsDecision + m.recorded).toBe(m.uniqueReceipts);
  expect(m.recordedPaidMinor + m.cardSpendingWithoutRecordMinor).toBe(hkdDebitTotal);
  expect(m.linkedTransactions).toBe(m.receiptsWithConfirmedMatches);
}

const STEP1_TEXT =
  'Step 1 of 4 · Batch 1: First encounter. One receipt is ready. Four need you: two because the card shows “MC COFFEE HK”, a name the desk doesn\'t know yet, one unclear amount and one with two equal payments.';

describeEachRepo('T23 guided-demo counters and coach text', () => {
  it('T23 step 1 (both paths): counters and coach text from state', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const { m, coach } = await measure(repo);
    expect(row(m)).toEqual({ unique: 5, ready: 1, needs: 4, recorded: 0, confirmed: 0, linked: 0, active: 0, newly: 0, rulesUsed: 0, coverage: [1, 5], paid: 0, spending: 37000, cardRows: 0, unpaid: 0 });
    identities(m, 37000);
    expect(coach).toBe(STEP1_TEXT);
    await advanceTourStep(repo, 2);
    expect((await measure(repo)).coach).toBe(STEP_2_TEXT);
  });

  it('T23 alias path steps 2–3: counters, identities and coach Variant A (N1)', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    let r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 5, ready: 2, needs: 2, recorded: 1, confirmed: 1, linked: 1, active: 1, newly: 1, rulesUsed: 0, coverage: [2, 5], paid: 4800, spending: 32200, cardRows: 0, unpaid: 0 });
    identities(r.m, 37000);
    expect(r.m.newlyReady).toEqual(['R-103']);
    // Step 2 follows the state (A-S2-1): what the rule changed and the next action.
    expect(r.coach).toBe('Step 2 of 4 · Rule K-ALIAS-0001 v1 is active. R-103 is now ready without another decision. Next: load Batch 2.');

    await loadDemoBatch(repo, 2, assets);
    r = await measure(repo);
    expect(r.s.demoState.tourStep).toBe(3);
    expect(row(r.m)).toEqual({ unique: 8, ready: 5, needs: 2, recorded: 1, confirmed: 1, linked: 1, active: 1, newly: 3, rulesUsed: 0, coverage: [5, 8], paid: 4800, spending: 54300, cardRows: 0, unpaid: 0 });
    identities(r.m, 59100);
    expect(r.m.newlyReady).toEqual(['R-103', 'R-201', 'R-202']);
    expect(r.coach).toBe('Step 3 of 4 · Batch 2: Knowledge reused. Two Morning Cup receipts are ready because of K-ALIAS-0001 v1. The re-uploaded file was caught.');
  });

  it('T23 apply-once path steps 2–3: counters, identities and coach Variant B', async () => {
    const repo = await tourToConfirmedR102();
    let r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 5, ready: 1, needs: 3, recorded: 1, confirmed: 1, linked: 1, active: 0, newly: 0, rulesUsed: 0, coverage: [1, 5], paid: 4800, spending: 32200, cardRows: 0, unpaid: 0 });
    identities(r.m, 37000);
    expect(r.coach).toBe('Step 2 of 4 · R-102 is recorded for this case only. No rule was created. Next: open R-102 and choose “Propose reusable knowledge”.');

    await loadDemoBatch(repo, 2, assets);
    r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 8, ready: 2, needs: 5, recorded: 1, confirmed: 1, linked: 1, active: 0, newly: 0, rulesUsed: 0, coverage: [2, 8], paid: 4800, spending: 54300, cardRows: 0, unpaid: 0 });
    identities(r.m, 59100);
    expect(r.coach).toBe('Step 3 of 4 · Batch 2: Without an approved rule, both new Morning Cup receipts still need your decision. The re-uploaded file was caught.');
  });

  it('T23 N2: apply-once path with R-201 and R-202 confirmed manually renders the "is loaded" fallback', async () => {
    const repo = await tourToConfirmedR102();
    await loadDemoBatch(repo, 2, assets);
    const s = await repo.loadSnapshot();
    for (const [rid, ref] of [['R-201', 'S-201'], ['R-202', 'S-202']] as const) {
      await confirmCaseOnly(repo, { receiptId: rid, transactionId: txIdByRef(s, ref), reason: 'Same amount and date on the card' });
    }
    const r = await measure(repo);
    expect(r.coach).toBe('Step 3 of 4 · Batch 2 is loaded. The re-uploaded file was caught.');
    identities(r.m, 59100);
    expect(r.m.recorded).toBe(3);
  });

  it('T23 alias path step 4 and "Record all ready": counters, identities and coach A+USD', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    await loadDemoBatch(repo, 3, assets);
    let r = await measure(repo);
    expect(r.s.demoState.tourStep).toBe(4);
    expect(row(r.m)).toEqual({ unique: 11, ready: 6, needs: 4, recorded: 1, confirmed: 1, linked: 1, active: 1, newly: 3, rulesUsed: 0, coverage: [6, 11], paid: 4800, spending: 66900, cardRows: 1, unpaid: 0 });
    identities(r.m, 71700);
    expect(r.coach).toBe(
      "Step 4 of 4 · Batch 3: The boundary still holds. A known name still can't pick between two equal payments, USD is not converted, and receipt text can't change your rules.",
    );

    const shown = viewOf(r.s).groups.ready.map((c) => c.proposal!);
    expect(shown.map((p) => p.subject.id)).toEqual(['R-101', 'R-103', 'R-201', 'R-202', 'R-203', 'R-303']);
    const committed: string[] = [];
    const result = await recordAllReady(repo, newRecordRun(), [...shown].reverse(), { onCommitted: (id) => committed.push(id) });
    expect(result.recorded.map((x) => x.receiptId)).toEqual(['R-101', 'R-103', 'R-201', 'R-202', 'R-203', 'R-303']);
    expect(committed).toEqual(result.recorded.map((x) => x.receiptId));
    expect(result.skipped).toEqual([]);
    expect(result.remaining).toEqual([]);
    r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 11, ready: 0, needs: 4, recorded: 7, confirmed: 7, linked: 7, active: 1, newly: 0, rulesUsed: 1, coverage: [6, 11], paid: 48700, spending: 23000, cardRows: 1, unpaid: 0 });
    identities(r.m, 71700);
    expect(r.m.rulesUsedInRecorded.map((u) => u.ruleId)).toEqual(['K-ALIAS-0001']);
  });

  it('T23 apply-once path step 4 and "Record all ready": counters, identities and coach B+USD', async () => {
    const repo = await tourToConfirmedR102();
    await loadDemoBatch(repo, 2, assets);
    await loadDemoBatch(repo, 3, assets);
    let r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 11, ready: 3, needs: 7, recorded: 1, confirmed: 1, linked: 1, active: 0, newly: 0, rulesUsed: 0, coverage: [3, 11], paid: 4800, spending: 66900, cardRows: 1, unpaid: 0 });
    identities(r.m, 71700);
    expect(r.coach).toBe(
      "Step 4 of 4 · Batch 3: The boundary still holds. Two equal payments still come back to you, USD is not converted, and receipt text can't change your rules.",
    );
    const shown = viewOf(r.s).groups.ready.map((c) => c.proposal!);
    const result = await recordAllReady(repo, newRecordRun(), shown);
    expect(result.recorded.map((x) => x.receiptId)).toEqual(['R-101', 'R-203', 'R-303']);
    r = await measure(repo);
    expect(row(r.m)).toEqual({ unique: 11, ready: 0, needs: 7, recorded: 4, confirmed: 4, linked: 4, active: 0, newly: 0, rulesUsed: 0, coverage: [3, 11], paid: 29900, spending: 41800, cardRows: 1, unpaid: 0 });
    identities(r.m, 71700);
  });

  it('T23 "Record all ready" stops before the next record when paused, skips stale proposals and never retries', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    const shown = viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!);
    expect(shown.map((p) => p.subject.id)).toEqual(['R-101', 'R-103']);
    // Paused after the first commit: R-103 is not attempted, R-101 stays recorded.
    const run = newRecordRun();
    const first = await recordAllReady(repo, run, shown, { onCommitted: () => (run.paused = true) });
    expect(first.recorded.map((x) => x.receiptId)).toEqual(['R-101']);
    expect(first.paused).toBe(true);
    expect(first.remaining).toEqual(['R-103']);
    // A second run with the same (now stale) R-101 proposal skips it and records R-103 only.
    const second = await recordAllReady(repo, newRecordRun(), shown);
    expect(second.skipped.map((x) => x.receiptId)).toEqual(['R-101']);
    expect(second.recorded.map((x) => x.receiptId)).toEqual(['R-103']);
    const s = await repo.loadSnapshot();
    expect(s.ledger.filter((e) => e.status === 'recorded')).toHaveLength(3);
  });

  it('T23 Variant A recorded form: alias-matched Batch 2 receipts that were recorded are cited by their match refs', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    const v = viewOf(await repo.loadSnapshot());
    await recordProposal(repo, v.caseById.get('R-201')!.proposal!);
    await recordProposal(repo, v.caseById.get('R-202')!.proposal!);
    const r = await measure(repo);
    expect(r.coach).toBe('Step 3 of 4 · Batch 2: Knowledge reused. Two Morning Cup receipts were recorded using K-ALIAS-0001 v1. The re-uploaded file was caught.');
    expect(r.m.rulesUsedInRecorded.map((u) => [u.ruleId, u.ledgerEntryIds])).toEqual([['K-ALIAS-0001', ['L-0002', 'L-0003']]]);
    identities(r.m, 59100);
  });
});

describe('T26 comparison replay', () => {
  it('T26 replay is deterministic, uses frozen fixture inputs and leaves the live workspace untouched: 7 of 11 vs 3 of 11', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    await loadDemoBatch(repo, 3, assets);
    const before = await repo.loadSnapshot();
    const fixture = await buildFixtureSnapshot(before.demoState.loadedBatches, assets);
    expect(Object.isFrozen(fixture)).toBe(true);
    expect(Object.isFrozen(fixture.receipts[0]!.fields.merchant.original)).toBe(true);
    const fixtureCopy = structuredClone(fixture);
    const active = viewOf(before).activeRules;
    const ref = selectCompareTarget(before.ruleHeads, before.ruleVersions)!;
    expect(ref).toEqual({ ruleId: 'K-ALIAS-0001', version: 1 });

    const a = compareReplay(fixture, active, ref);
    const b = compareReplay(fixture, active, ref);
    expect(a).toEqual(b);
    expect(fixture).toEqual(fixtureCopy);
    expect(a.counts).toEqual({ total: 11, readyWith: 7, readyWithout: 3 });
    const readyWith = a.rows.filter((x) => x.withRule?.group === 'ready').map((x) => x.caseId);
    expect(readyWith).toEqual(['R-101', 'R-102', 'R-103', 'R-201', 'R-202', 'R-203', 'R-303']);
    expect(a.rows.filter((x) => x.withoutRule?.group === 'ready').map((x) => x.caseId)).toEqual(['R-101', 'R-203', 'R-303']);
    // R-102 is a fixture receipt here: the live manual match is not part of the replay.
    expect(a.rows.find((x) => x.caseId === 'R-204')).toEqual({ caseId: 'R-204', withRule: null, withoutRule: null, duplicateOf: 'R-102' });
    expect(a.rows.find((x) => x.caseId === 'R-301')!.withRule!.group).toBe('needs_decision');

    // No live-state side effect: the repository snapshot is identical.
    expect(await repo.loadSnapshot()).toEqual(before);
  });

  it('T26 N8 target selection: the most recently activated active alias or posting-window rule, never a category preference; null with none', () => {
    const alias = { ...aliasRule(), approvedAt: '2026-03-31T09:00:10.000Z' };
    const cat = { ...categoryRule(), approvedAt: '2026-03-31T09:00:20.000Z' };
    expect(selectCompareTarget([head(alias), head(cat)], [alias, cat])).toEqual({ ruleId: alias.ruleId, version: 1 });
    expect(selectCompareTarget([head(cat)], [cat])).toBeNull();
    expect(selectCompareTarget([], [])).toBeNull();
    const policy = { ...policyRule({ days: 5 }), approvedAt: '2026-03-31T09:00:30.000Z' };
    expect(selectCompareTarget([head(alias), head(cat), head(policy)], [alias, cat, policy])).toEqual({ ruleId: policy.ruleId, version: 1 });
    expect(selectCompareTarget([head(alias, 'suspended'), head(cat)], [alias, cat])).toBeNull();
  });
});
