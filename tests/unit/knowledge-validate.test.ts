import { describe, expect, it } from 'vitest';
import { validateDraft, type ValidationContext } from '../../src/domain/knowledge/validate';
import { toDraftContent } from '../../src/domain/knowledge/schema';
import { BASELINE_POLICY, MAX_POSTING_LAG, SAFETY_INVARIANTS } from '../../src/domain/knowledge/safety';
import { deriveCategory } from '../../src/domain/knowledge/resolve';
import { aliasRule, categoryRule, head, policyRule, receipt, tx } from '../builders';
import { batch1 } from '../scenario';

const b = batch1();
const extraRows = [
  tx({ file: 'extra.csv', row: 2, ref: 'X-1', label: 'MORNING CUP', posting: '2026-03-05', amount: 100 }),
  tx({ file: 'extra.csv', row: 3, ref: 'X-2', label: 'MC COFFEE', posting: '2026-03-05', amount: 100 }),
  tx({ file: 'extra.csv', row: 4, ref: 'X-3', label: 'SQ', posting: '2026-03-05', amount: 100 }),
  tx({ file: 'extra.csv', row: 5, ref: 'X-4', label: 'SQ *PAGE CORNER', posting: '2026-03-05', amount: 100 }),
  tx({ file: 'extra.csv', row: 6, ref: 'X-5', label: 'ABC', posting: '2026-03-05', amount: 100 }),
];

function ctx(over: Partial<ValidationContext> = {}): ValidationContext {
  return {
    receipts: b.receipts,
    transactions: [...b.transactions, ...extraRows],
    payables: [],
    activeRules: [],
    ruleHeads: [],
    ...over,
  };
}

const tourAlias = () => toDraftContent(aliasRule({ approved: false })) as Record<string, unknown>;
const withPath = (base: Record<string, unknown>, part: 'scope' | 'condition' | 'action', patch: Record<string, unknown>) => ({
  ...base,
  [part]: { ...(base[part] as Record<string, unknown>), ...patch },
});
const codes = (draft: unknown, c: ValidationContext = ctx()) =>
  [...new Set(validateDraft(draft, c).errors.map((e) => e.code))].sort();

describe('rule draft validation', () => {
  it('T14 a valid, scoped alias draft from the tour has no blocking findings', () => {
    expect(codes(tourAlias())).toEqual([]);
  });

  it('T14 invalid schemas cannot activate (INVALID_SCHEMA)', () => {
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 42 }))).toEqual(['INVALID_SCHEMA']);
    const policy = toDraftContent(policyRule({ approved: false })) as Record<string, unknown>;
    for (const days of [-1, 2.5, 400]) {
      expect(codes(withPath(policy, 'action', { postingLagMaxDays: days })), String(days)).toEqual(['INVALID_SCHEMA']);
    }
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'mc coffee hk' }))).toEqual(['INVALID_SCHEMA']);
  });

  it('T14 unsupported actions and rule types cannot activate (UNSUPPORTED_ACTION)', () => {
    expect(codes(withPath(tourAlias(), 'action', { amountTolerance: 100 }))).toEqual(['UNSUPPORTED_ACTION']);
    expect(codes({ ...tourAlias(), type: 'auto_mark_paid' })).toEqual(['UNSUPPORTED_ACTION']);
    const policy = toDraftContent(policyRule({ approved: false })) as Record<string, unknown>;
    expect(codes(withPath(policy, 'action', { disableAmbiguityCheck: true }))).toEqual(['UNSUPPORTED_ACTION']);
  });

  it('T14 direct conflicts cannot activate (CONFLICT)', () => {
    const toGreenBasket = withPath(tourAlias(), 'action', { canonicalMerchantId: 'm:green-basket', canonicalMerchantName: 'Green Basket' });
    expect(codes(toGreenBasket, ctx({ activeRules: [aliasRule()] }))).toEqual(['CONFLICT']);

    const otherCategory = toDraftContent(categoryRule({ ruleId: 'K-CAT-0002', category: 'office', approved: false }));
    expect(codes(otherCategory, ctx({ activeRules: [categoryRule()] }))).toEqual(['CONFLICT']);

    // At most one non-discarded K-POLICY head per workspace.
    const existing = policyRule({ days: 2 });
    const second = toDraftContent(policyRule({ ruleId: 'K-POLICY-0002', days: 1, approved: false }));
    expect(codes(second, ctx({ ruleHeads: [head(existing, 'suspended')] }))).toEqual(['CONFLICT']);
    expect(codes(second, ctx({ activeRules: [existing], ruleHeads: [head(existing)] }))).toEqual(['CONFLICT']);
  });

  it('T14 alias cycles and alias-to-alias chains cannot activate (ALIAS_CYCLE)', () => {
    const self = withPath(tourAlias(), 'condition', { observedLabel: 'MORNING CUP' });
    expect(codes(self)).toEqual(['ALIAS_CYCLE']);
    const otherMerchant = withPath(tourAlias(), 'condition', { observedLabel: 'PAGE CORNER' });
    expect(codes(otherMerchant)).toEqual(['ALIAS_CYCLE']);
    const toAliasLabel = withPath(withPath(tourAlias(), 'condition', { observedLabel: 'MC COFFEE' }), 'action', {
      canonicalMerchantId: 'm:mc-coffee-hk',
      canonicalMerchantName: 'MC COFFEE HK',
    });
    expect(codes(toAliasLabel, ctx({ activeRules: [aliasRule()] }))).toEqual(['ALIAS_CYCLE']);
    const notCanonical = withPath(tourAlias(), 'action', { canonicalMerchantId: 'K-ALIAS-0009' });
    expect(codes(notCanonical)).toEqual(['ALIAS_CYCLE']);
  });

  it('T14 overbroad scope cannot activate (OVERBROAD)', () => {
    expect(codes(withPath(tourAlias(), 'scope', { accountId: null }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'scope', { accountId: 'acct:not-here' }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'SQ' }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'SQ PAGE CORNER' }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'ABC' }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'MC*' }))).toEqual(['OVERBROAD']);
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'MC COFFEE.*' }))).toEqual(['OVERBROAD']);
  });

  it('T14 unsafe policy settings cannot activate (UNSAFE_POLICY) and safety checks stay immutable', () => {
    const policy = toDraftContent(policyRule({ days: 8, approved: false }));
    expect(codes(policy)).toEqual(['UNSAFE_POLICY']);
    expect(codes(toDraftContent(policyRule({ days: 7, approved: false })))).toEqual([]);
    expect(MAX_POSTING_LAG).toBe(7);
    expect(BASELINE_POLICY.postingLagMaxDays).toBe(3);
    expect(SAFETY_INVARIANTS.map((s) => s.id)).toEqual(['S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'S-7', 'S-8', 'S-9', 'S-10']);
    expect(Object.isFrozen(SAFETY_INVARIANTS)).toBe(true);
    expect(SAFETY_INVARIANTS.every((s) => Object.isFrozen(s))).toBe(true);
    expect(Object.isFrozen(BASELINE_POLICY)).toBe(true);
    expect(() => (SAFETY_INVARIANTS as unknown as unknown[]).push({ id: 'S-11' })).toThrow();
  });

  it('T14 drafts without evidence in this workspace cannot activate (NO_EVIDENCE)', () => {
    expect(codes(withPath(tourAlias(), 'condition', { observedLabel: 'MC COFFEE KLN' }))).toEqual(['NO_EVIDENCE']);
    const cat = toDraftContent(categoryRule({ merchant: 'Unknown Shop', approved: false }));
    expect(codes(cat)).toEqual(['NO_EVIDENCE']);
  });

  it('T14 a category preference for a name with no comparable characters ("m:") cannot activate (OVERBROAD) and never suggests', () => {
    const r = receipt({ id: 'R-701', merchant: '大家樂', date: '2026-03-10', amount: 4200 });
    const other = receipt({ id: 'R-702', merchant: '美心', date: '2026-03-10', amount: 4200, doc: 'DOC-other' });
    const empty = categoryRule({ ruleId: 'K-CAT-0009', merchant: '大家樂', approved: false });
    expect(empty.type === 'category_preference' && empty.condition.canonicalMerchantId).toBe('m:');
    expect(codes(toDraftContent(empty), ctx({ receipts: [...b.receipts, r] }))).toEqual(['OVERBROAD']);
    // Even if such a rule reached storage, it suggests nothing for any merchant.
    const stored = categoryRule({ ruleId: 'K-CAT-0009', merchant: '大家樂' });
    for (const x of [r, other]) expect(deriveCategory(x, [stored])).toEqual({ categoryId: null, status: 'unassigned', ruleRef: null });
  });

  it('T14 shadowed duplicates cannot activate (DUPLICATE), but an edit is not a duplicate of itself', () => {
    expect(codes(tourAlias(), ctx({ activeRules: [aliasRule()] }))).toEqual(['DUPLICATE']);
    expect(codes(tourAlias(), ctx({ activeRules: [aliasRule()], ruleId: 'K-ALIAS-0001' }))).toEqual([]);
  });

  it('T14 activation needs a current preview (STALE_PREVIEW, including "no preview yet")', () => {
    const none = validateDraft(tourAlias(), ctx({ activation: { preview: null, currentFingerprint: 'now' } }));
    expect(none.errors.map((e) => [e.code, e.message])).toEqual([['STALE_PREVIEW', 'Preview the impact first']]);
    const stale = validateDraft(tourAlias(), ctx({ activation: { preview: { stateFingerprint: 'then' }, currentFingerprint: 'now' } }));
    expect(stale.errors.map((e) => e.code)).toEqual(['STALE_PREVIEW']);
    const fresh = validateDraft(tourAlias(), ctx({ activation: { preview: { stateFingerprint: 'now' }, currentFingerprint: 'now' } }));
    expect(fresh.errors).toEqual([]);
  });

  it('T14 every applicable semantic code is reported, not just the first', () => {
    const many = withPath(withPath(tourAlias(), 'scope', { accountId: null }), 'condition', { observedLabel: 'PAGE CORNER' });
    expect(codes(many)).toEqual(['ALIAS_CYCLE', 'OVERBROAD']);
  });
});

describe('K04 store-number alias match type (validation)', () => {
  const visa = (row: number, label: string) => tx({ file: 'k04.csv', row, ref: `P-${row}`, label, posting: '2026-03-03', amount: 3800, account: 'Visa 1234' });
  const rows = [visa(2, 'PACIFIC COFFEE #042'), visa(3, 'PACIFIC COFFEE #117'), visa(4, 'PACIFIC COFFEE ROASTERS #1'), visa(5, 'CAFE 12'), visa(6, 'SQ COFFEE 12')];
  const k = (over: Partial<ValidationContext> = {}) => ctx({ transactions: [...b.transactions, ...rows], ...over });
  const draft = (label: string, merchant = 'Pacific Coffee') =>
    toDraftContent(aliasRule({ approved: false, ruleId: 'K-ALIAS-0007', label, merchant, accountId: 'acct:visa-1234', match: 'exact_ignoring_store_number' }));

  it('K04 a specific stem with evidence passes; the plain-English text names the stem', () => {
    const d = draft('PACIFIC COFFEE 042');
    expect(codes(d, k())).toEqual([]);
    expect((d as { plainEnglish: string }).plainEnglish).toContain('the statement label “PACIFIC COFFEE”, alone or followed by one store number such as #042, means the merchant Pacific Coffee.');
  });

  it('K04 a stem under 6 normalised characters or a generic stem is OVERBROAD', () => {
    expect(codes(draft('CAFE 12', 'Cafe Bloom'), k())).toEqual(['OVERBROAD']);
    expect(codes(draft('SQ COFFEE 12', 'Some Coffee'), k())).toEqual(['OVERBROAD']);
  });

  it('K04 only one trailing store token is stripped, so a longer name is neither evidence nor covered', () => {
    expect(codes(draft('PACIFIC COFFEE ROASTERS 9'), k({ transactions: [...b.transactions, visa(4, 'PACIFIC COFFEE ROASTERS #1')] }))).toEqual([]);
    expect(codes(draft('PACIFIC COFFEE 042'), k({ transactions: [...b.transactions, visa(4, 'PACIFIC COFFEE ROASTERS #1')] }))).toEqual(['NO_EVIDENCE']);
  });

  it('K04 overlapping labels in one account that map elsewhere are a CONFLICT; an identical rule is a DUPLICATE', () => {
    const exactOther = aliasRule({ ruleId: 'K-ALIAS-0009', label: 'PACIFIC COFFEE 117', merchant: 'Harbour Coffee', accountId: 'acct:visa-1234' });
    expect(codes(draft('PACIFIC COFFEE 042'), k({ activeRules: [exactOther] }))).toEqual(['CONFLICT']);
    const same = aliasRule({ ruleId: 'K-ALIAS-0010', label: 'PACIFIC COFFEE 042', merchant: 'Pacific Coffee', accountId: 'acct:visa-1234', match: 'exact_ignoring_store_number' });
    expect(codes(draft('PACIFIC COFFEE 042'), k({ activeRules: [same] }))).toEqual(['DUPLICATE']);
  });

  it('K04 a stem equal to another known merchant name is ALIAS_CYCLE', () => {
    const r = receipt({ id: 'R-900', merchant: 'Pacific Coffee', date: '2026-03-02', amount: 100 });
    expect(codes(draft('PACIFIC COFFEE 042', 'Harbour Coffee'), k({ receipts: [...b.receipts, r] }))).toEqual(['ALIAS_CYCLE']);
  });

  it('K04 unknown match types are rejected by the schema', () => {
    const d = draft('PACIFIC COFFEE 042') as Record<string, unknown>;
    expect(codes(withPath(d, 'condition', { match: 'contains' }), k())).toEqual(['INVALID_SCHEMA']);
  });
});
