import { describe, expect, it } from 'vitest';
import { previewImpact, RECORDED_NOT_CHANGED, RECORDED_USING_RULE, stateFingerprint, type WorkspaceState } from '../../src/domain/knowledge/preview';
import { prefillDraftFromCase } from '../../src/domain/knowledge/prefill';
import { validateDraft, validateVersion } from '../../src/domain/knowledge/validate';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { revalidate } from '../../src/domain/matching/revalidate';
import type { RuleVersion } from '../../src/domain/knowledge/schema';
import { aliasRule, categoryRule, deepFreeze, head, input, receipt, recorded, tx } from '../builders';
import { allBatches, byReceipt, byRef } from '../scenario';

function state(parts: Partial<WorkspaceState> & { active?: RuleVersion[] }): WorkspaceState {
  const active = parts.active ?? [];
  return {
    receipts: parts.receipts ?? [],
    transactions: parts.transactions ?? [],
    matches: parts.matches ?? [],
    ledger: parts.ledger ?? [],
    decisions: parts.decisions ?? [],
    payables: parts.payables ?? [],
    ruleHeads: parts.ruleHeads ?? active.map((v) => head(v)),
    ruleVersions: parts.ruleVersions ?? active,
  };
}

/** Tour step 2: Batch 1 loaded, R-102 recorded by "Confirm this case only". */
function tourStep2(batches: 1 | 2 = 1) {
  const all = allBatches(batches);
  const r102 = recorded({ n: 1, receipt: byReceipt(all.receipts, 'R-102'), transaction: byRef(all.transactions, 'S-102') });
  return { all, r102 };
}

describe('impact preview', () => {
  it('T03 (domain) previewing the tour alias lists R-103 as newly ready and recorded L-0001 as unchanged', () => {
    const { all, r102 } = tourStep2();
    const draft = aliasRule({ approved: false });
    const s = deepFreeze(state({ ...all, matches: [r102.match], ledger: [r102.entry], ruleHeads: [head(draft, 'draft_only')], ruleVersions: [draft] }));
    const preview = previewImpact(s, { kind: 'activate', version: draft });
    expect(preview.pendingChanges.map((c) => c.caseId)).toEqual(['R-103']);
    const c = preview.pendingChanges[0]!;
    expect(c.before.group).toBe('needs_decision');
    expect(c.after.group).toBe('ready');
    expect(c.after.explanation).toBe('Matches S-103. Matched name using K-ALIAS-0001 v1.');
    expect(c.after.category).toEqual({ categoryId: null, status: 'unassigned' });
    expect(preview.recordedDifferences).toEqual([{ ledgerEntryId: 'L-0001', note: RECORDED_NOT_CHANGED }]);
    expect(preview.unchangedCount).toBe(3); // R-101, R-104, R-105
    const v = validateVersion(draft, { receipts: s.receipts, transactions: s.transactions, payables: [], activeRules: [], ruleHeads: s.ruleHeads, preview });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);
  });

  it('T03 (category sub-case) a category preference preview shows the derived category change only', () => {
    const { all, r102 } = tourStep2();
    const alias = aliasRule();
    const cat = categoryRule({ approved: false });
    const s = deepFreeze(
      state({
        ...all,
        matches: [r102.match],
        ledger: [r102.entry],
        ruleHeads: [head(alias), head(cat, 'draft_only')],
        ruleVersions: [alias, cat],
      }),
    );
    const preview = previewImpact(s, { kind: 'activate', version: cat });
    const r103 = preview.pendingChanges.find((c) => c.caseId === 'R-103')!;
    expect(r103.before).toEqual({ ...r103.before, group: 'ready', category: { categoryId: null, status: 'unassigned' } });
    expect(r103.after).toEqual({ ...r103.before, category: { categoryId: 'dining', status: 'suggested' } });
    expect(preview.pendingChanges.map((x) => x.caseId)).toEqual(['R-103']);
    expect(preview.recordedDifferences).toEqual([{ ledgerEntryId: 'L-0001', note: RECORDED_NOT_CHANGED }]);
    const v = validateVersion(cat, { receipts: s.receipts, transactions: s.transactions, payables: [], activeRules: [alias], ruleHeads: s.ruleHeads, preview });
    expect(v.errors).toEqual([]);
    expect(v.warnings).toEqual([]);

    // After activation, only the derived view changes: the stored category and L-0001 stay unassigned.
    const after = evaluateWorkspace(input({ ...all, matches: [r102.match], ledgerEntries: [r102.entry], activeRules: [alias, cat] }));
    expect(after.proposals.get('R-103')!.category).toEqual({ categoryId: 'dining', ruleRef: { ruleId: 'K-CAT-0001', version: 1 } });
    expect(after.proposals.get('R-103')!.outcome).toBe('unique_candidate');
    expect(byReceipt(all.receipts, 'R-103').category.status).toBe('unassigned');
    expect(r102.entry.category.status).toBe('unassigned');
  });

  it('NO_PENDING_EFFECT fires only when no pending case differs in group, explanation or category', () => {
    const r101 = receipt({ id: 'R-101', merchant: 'Page Corner', date: '2026-03-02', amount: 12000 });
    const s101 = tx({ row: 2, ref: 'S-101', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });
    const rec = recorded({ n: 1, receipt: r101, transaction: s101 });
    const cat = categoryRule({ merchant: 'Page Corner', category: 'books', approved: false });
    const s = state({ receipts: [r101], transactions: [s101], matches: [rec.match], ledger: [rec.entry], ruleHeads: [head(cat, 'draft_only')], ruleVersions: [cat] });
    const preview = previewImpact(s, { kind: 'activate', version: cat });
    expect(preview.pendingChanges).toEqual([]);
    expect(preview.recordedDifferences).toEqual([{ ledgerEntryId: 'L-0001', note: RECORDED_NOT_CHANGED }]);
    const v = validateVersion(cat, { receipts: s.receipts, transactions: s.transactions, payables: [], activeRules: [], ruleHeads: s.ruleHeads, preview });
    expect(v.warnings.map((w) => w.code)).toEqual(['NO_PENDING_EFFECT']);
    expect(v.errors).toEqual([]);
  });

  it('the preview fingerprint changes when the state or the draft content changes', () => {
    const { all } = tourStep2();
    const s = state({ ...all });
    const a = stateFingerprint(s, null);
    expect(stateFingerprint(state({ ...all }), null)).toBe(a);
    expect(stateFingerprint(s, aliasRule({ approved: false }))).not.toBe(a);
    const edited = all.receipts.map((r) => (r.id === 'R-101' ? { ...r, updatedAt: '2026-03-31T09:00:09.000Z' } : r));
    expect(stateFingerprint(state({ ...all, receipts: edited }), null)).not.toBe(a);
  });

  it('T16 (domain) suspension invalidates pending dependent proposals without rewriting recorded entries', () => {
    const all = allBatches(2);
    const alias = aliasRule();
    const r102 = recorded({ n: 1, receipt: byReceipt(all.receipts, 'R-102'), transaction: byRef(all.transactions, 'S-102') });
    const r103 = recorded({
      n: 2,
      receipt: byReceipt(all.receipts, 'R-103'),
      transaction: byRef(all.transactions, 'S-103'),
      method: 'confirmed_proposal',
      ruleRefs: [{ ruleId: 'K-ALIAS-0001', version: 1 }],
    });
    const s = deepFreeze(
      state({ ...all, matches: [r102.match, r103.match], ledger: [r102.entry, r103.entry], active: [alias] }),
    );
    const snapshot = structuredClone(s);
    const preview = previewImpact(s, { kind: 'suspend', ruleId: 'K-ALIAS-0001' });
    expect(preview.pendingChanges.map((c) => [c.caseId, c.before.group, c.after.group])).toEqual([
      ['R-201', 'ready', 'needs_decision'],
      ['R-202', 'ready', 'needs_decision'],
    ]);
    expect(preview.recordedDifferences).toContainEqual({ ledgerEntryId: 'L-0002', note: RECORDED_USING_RULE });
    expect(s).toEqual(snapshot); // nothing written; recorded ledger keeps its ruleRefs and amounts
    expect(s.ledger[1]!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(s.ruleVersions).toEqual([alias]); // history keeps v1

    // A proposal shown before suspension no longer revalidates.
    const inp = input({ ...all, matches: [r102.match, r103.match], ledgerEntries: [r102.entry, r103.entry], activeRules: [alias] });
    const shown = evaluateWorkspace(inp).proposals.get('R-201')!;
    expect(shown.outcome).toBe('unique_candidate');
    expect(revalidate({ ...inp, activeRules: [] }, shown)).toEqual({ ok: false, reason: 'rule_changed' });
  });
});

describe('prefill from a case', () => {
  it('prefills the scoped alias from the matched transaction with case evidence', () => {
    const { all, r102 } = tourStep2();
    const result = prefillDraftFromCase({
      receipt: byReceipt(all.receipts, 'R-102'),
      proposal: null,
      matches: [r102.match],
      transactions: all.transactions,
      activeRules: [],
    });
    expect(result.kind).toBe('alias');
    if (result.kind !== 'alias' || result.draft.type !== 'merchant_alias') throw new Error('expected alias draft');
    expect(result.draft.scope).toEqual({ accountId: 'acct:demo-card-1234' });
    expect(result.draft.condition).toEqual({ observedLabel: 'MC COFFEE HK', match: 'exact' });
    expect(result.draft.action).toEqual({ canonicalMerchantId: 'm:morning-cup', canonicalMerchantName: 'Morning Cup' });
    expect(result.draft.evidenceRefs).toEqual([
      { kind: 'receipt', ref: 'R-102' },
      { kind: 'transaction', ref: byRef(all.transactions, 'S-102').id },
      { kind: 'match', ref: 'M-0001' },
    ]);
    expect(result.draft.plainEnglish).toBe(
      'On card Demo Card ••1234, the statement label “MC COFFEE HK” means the merchant Morning Cup. Amount, currency, date, duplicate and ambiguity checks still apply.',
    );
    const v = validateDraft(result.draft, { receipts: all.receipts, transactions: all.transactions, payables: [], activeRules: [], ruleHeads: [] });
    expect(v.errors).toEqual([]);
  });

  it('prefills from near candidates for a pending case', () => {
    const { all, r102 } = tourStep2();
    const proposal = evaluateWorkspace(input({ ...all, matches: [r102.match], ledgerEntries: [r102.entry] })).proposals.get('R-103')!;
    const result = prefillDraftFromCase({ receipt: byReceipt(all.receipts, 'R-103'), proposal, matches: [r102.match], transactions: all.transactions, activeRules: [] });
    expect(result.kind).toBe('alias');
  });

  it('N5 near candidates that already carry the merchant name offer only a category draft (R-104)', () => {
    const { all } = tourStep2();
    const proposal = evaluateWorkspace(input(all)).proposals.get('R-104')!;
    expect(proposal.nearCandidateIds).toHaveLength(1);
    const result = prefillDraftFromCase({ receipt: byReceipt(all.receipts, 'R-104'), proposal, matches: [], transactions: all.transactions, activeRules: [] });
    expect(result).toEqual({ kind: 'category_only', merchantId: 'm:green-basket', merchantName: 'Green Basket' });
  });

  it('a matched transaction whose label is the merchant name offers only a category draft (R-101)', () => {
    const { all } = tourStep2();
    const rec = recorded({ n: 2, receipt: byReceipt(all.receipts, 'R-101'), transaction: byRef(all.transactions, 'S-101') });
    const result = prefillDraftFromCase({ receipt: byReceipt(all.receipts, 'R-101'), proposal: null, matches: [rec.match], transactions: all.transactions, activeRules: [] });
    expect(result.kind).toBe('category_only');
  });

  it('different near labels ask the user to pick one; no near candidates open the form', () => {
    const r = receipt({ id: 'R-901', merchant: 'Morning Cup', date: '2026-03-04', amount: 4800 });
    const t1 = tx({ file: 'p.csv', row: 2, ref: 'P-1', label: 'MC COFFEE HK', posting: '2026-03-05', amount: 4800 });
    const t2 = tx({ file: 'p.csv', row: 3, ref: 'P-2', label: 'MORNING CUP CENTRAL', posting: '2026-03-05', amount: 4800 });
    const proposal = evaluateWorkspace(input({ receipts: [r], transactions: [t1, t2] })).proposals.get('R-901')!;
    const pick = prefillDraftFromCase({ receipt: r, proposal, matches: [], transactions: [t1, t2], activeRules: [] });
    expect(pick.kind).toBe('choose_label');
    if (pick.kind === 'choose_label') expect(pick.options.map((o) => o.observedLabel)).toEqual(['MC COFFEE HK', 'MORNING CUP CENTRAL']);

    const lonely = evaluateWorkspace(input({ receipts: [r] })).proposals.get('R-901')!;
    expect(prefillDraftFromCase({ receipt: r, proposal: lonely, matches: [], transactions: [], activeRules: [] })).toEqual({
      kind: 'form',
      merchantName: 'Morning Cup',
    });
  });
});
