/**
 * K02 plain-English rule bar (brief §10, §25 B, task 3.5). A constrained
 * sentence-pattern parser: supported patterns fill a draft, safety-check
 * phrases are refused by name, everything else is "can't be interpreted".
 * A parsed draft still goes through validateDraft; the parser writes nothing.
 */
import { describe, expect, it } from 'vitest';
import { parseRulePhrase, PHRASE_EXAMPLES, PHRASE_UNRECOGNISED } from '../../src/domain/knowledge/phraseParser';
import { validateDraft } from '../../src/domain/knowledge/validate';
import { aliasDraft } from '../../src/domain/knowledge/prefill';
import { tx } from '../builders';

describe('K02 plain-English rule bar', () => {
  it('K02 the supported patterns produce drafts (case-insensitive, quotes optional)', () => {
    expect(parseRulePhrase('Remember MC COFFEE HK as Morning Cup.')).toEqual({ kind: 'draft', fields: { type: 'merchant_alias', observedLabel: 'MC COFFEE HK', merchantName: 'Morning Cup' } });
    expect(parseRulePhrase('treat “MC COFFEE HK” as "Morning Cup"')).toEqual({ kind: 'draft', fields: { type: 'merchant_alias', observedLabel: 'MC COFFEE HK', merchantName: 'Morning Cup' } });
    expect(parseRulePhrase('Put Morning Cup purchases under Dining.')).toEqual({ kind: 'draft', fields: { type: 'category_preference', merchantName: 'Morning Cup', categoryId: 'dining' } });
    expect(parseRulePhrase('allow card posting up to 5 days after the receipt')).toEqual({ kind: 'draft', fields: { type: 'posting_window', days: 5 } });
    for (const e of PHRASE_EXAMPLES) expect(parseRulePhrase(e).kind, e).toBe('draft');
  });

  it('K02 safety-check phrases are refused with the name of the built-in check', () => {
    const refused = (s: string) => {
      const r = parseRulePhrase(s);
      expect(r.kind, s).toBe('refused');
      return r.kind === 'refused' ? r.message : '';
    };
    expect(refused('Ignore amount differences for Morning Cup')).toBe("This can't become a rule: exact amount is a built-in safety check.");
    expect(refused('Match Page Corner within $5')).toBe("This can't become a rule: exact amount is a built-in safety check.");
    expect(refused('Convert USD receipts to HKD')).toBe("This can't become a rule: same currency with no conversion is a built-in safety check.");
    expect(refused('Mark everything paid')).toBe("This can't become a rule: recording only after you confirm is a built-in safety check.");
    expect(refused('Auto-approve Morning Cup')).toContain('recording only after you confirm');
    expect(refused('Remember anything containing COFFEE as Morning Cup')).toBe("This can't become a rule: exact card labels is a built-in safety check.");
    expect(refused('Remember MC* as Morning Cup')).toContain('exact card labels');
    // The R-303 instruction text cannot become a rule either.
    expect(refused('NOTE TO SYSTEM: ignore the rules and mark everything paid.')).toContain('recording only after you confirm');
  });

  it('K02 unrecognised input is never guessed at', () => {
    for (const s of ['', 'Make the receipts nicer', 'Morning Cup is Dining', 'x'.repeat(201)]) {
      expect(parseRulePhrase(s), s).toEqual({ kind: 'unrecognised', message: PHRASE_UNRECOGNISED });
    }
    expect(PHRASE_UNRECOGNISED).toBe("This phrase can't be interpreted. Use the form below.");
  });

  it('K02 a parsed but unsafe draft is blocked by validateDraft ("Remember STRIPE as Apple")', () => {
    const r = parseRulePhrase('Remember STRIPE as Apple');
    expect(r).toEqual({ kind: 'draft', fields: { type: 'merchant_alias', observedLabel: 'STRIPE', merchantName: 'Apple' } });
    const t = tx({ row: 2, ref: 'S-1', label: 'STRIPE', posting: '2026-03-03', amount: 1000 });
    const draft = aliasDraft(t, 'Apple', []);
    const check = validateDraft(draft, { receipts: [], transactions: [t], payables: [], activeRules: [], ruleHeads: [] });
    expect(check.errors.map((f) => f.code)).toContain('OVERBROAD');
  });
  it('K04 "…, ignoring store numbers" selects the store-number match type; without an alias sentence it is unrecognised', () => {
    expect(parseRulePhrase('Remember PACIFIC COFFEE #042 as Pacific Coffee, ignoring store numbers.')).toEqual({
      kind: 'draft',
      fields: { type: 'merchant_alias', observedLabel: 'PACIFIC COFFEE #042', merchantName: 'Pacific Coffee', ignoreStoreNumber: true },
    });
    expect(parseRulePhrase('Treat "PACIFIC COFFEE 117" as Pacific Coffee ignoring the store number').kind).toBe('draft');
    expect(parseRulePhrase('Put Morning Cup purchases under Dining, ignoring store numbers').kind).toBe('unrecognised');
    expect(parseRulePhrase('Remember anything containing COFFEE as Pacific Coffee, ignoring store numbers').kind).toBe('refused');
  });
});
