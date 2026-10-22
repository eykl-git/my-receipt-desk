import { describe, expect, it } from 'vitest';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { deriveCaseView } from '../../src/domain/matching/caseView';
import { checkManualResolution } from '../../src/domain/matching/manual';
import { AlreadyLinkedError, ValidationError } from '../../src/domain/errors';
import { allStrictIso, daysBetween, parseDateWithFormat, toIsoDate, type IsoDate } from '../../src/domain/dates';
import { aliasRule, deepFreeze, input, policyRule, receipt, recorded, tx } from '../builders';
import { allBatches, batch1, byReceipt, byRef } from '../scenario';

const K_ALIAS = { ruleId: 'K-ALIAS-0001', version: 1 };

describe('matching engine', () => {
  it('T01 same merchant, amount, currency and eligible date yield a unique proposal when all checks pass', () => {
    const b = batch1();
    const inp = deepFreeze(input(b));
    const result = evaluateWorkspace(inp);
    const p = result.proposals.get('R-101')!;
    const s101 = byRef(b.transactions, 'S-101');

    expect(p.outcome).toBe('unique_candidate');
    expect(p.transactionId).toBe(s101.id);
    expect(p.candidateIds).toEqual([s101.id]);
    expect(p.flags).toEqual([]);
    expect(p.ruleRefs).toEqual([]);
    expect(p.policyRef).toEqual({ ruleId: 'P-BASE', version: 0 });
    expect(p.engineVersion).toBe('match-engine/1');
    for (const check of ['fields', 'currency', 'duplicate', 'rule_conflict', 'candidates', 'merchant_identity', 'outcome', 'collision'] as const) {
      expect(p.trace.some((s) => s.check === check && s.result === 'pass'), check).toBe(true);
    }
    expect(p.trace.some((s) => s.result === 'fail')).toBe(false);

    const view = deriveCaseView(byReceipt(b.receipts, 'R-101'), result, [], [], []);
    expect(view.capture).toBe('validated');
    expect(view.reconciliation).toBe('unique_candidate');
    expect(view.ledger).toBe('draft');
    expect(view.category).toEqual({ categoryId: null, status: 'unassigned', ruleRef: null });
    expect(view.group).toBe('ready');
  });

  it('T02 unknown alias pauses; a one-off confirmation does not teach the next case', () => {
    const all = allBatches(2);
    const s102 = byRef(all.transactions, 'S-102');
    const before = evaluateWorkspace(input(all));
    const p102 = before.proposals.get('R-102')!;
    expect(p102.outcome).toBe('unmatched');
    expect(p102.nearCandidateIds).toEqual([s102.id]);
    expect(p102.explanation).toBe(
      'Card label “MC COFFEE HK” is not a known name for Morning Cup. Amount, currency and date match S-102.',
    );

    // Apply once: the manual resolution is allowed with a reason and creates no rule.
    const check = checkManualResolution(input(all), {
      receiptId: 'R-102',
      transactionId: s102.id,
      reason: 'Receipt and card transaction show the same amount and date',
    });
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.value.identity).toBe('unrecognised');

    const { match, entry } = recorded({ n: 1, receipt: byReceipt(all.receipts, 'R-102'), transaction: s102 });
    const after = evaluateWorkspace(input({ ...all, matches: [match], ledgerEntries: [entry], activeRules: [] }));
    expect(after.proposals.has('R-102')).toBe(false);
    for (const id of ['R-103', 'R-201', 'R-202']) {
      const p = after.proposals.get(id)!;
      expect(p.outcome, id).toBe('unmatched');
      expect(p.explanation, id).toContain('is not a known name for Morning Cup');
      expect(p.ruleRefs, id).toEqual([]);
    }
  });

  it('T03 (domain) an approved scoped alias improves eligible pending and future cases', () => {
    const all = allBatches(2);
    const s102 = byRef(all.transactions, 'S-102');
    const { match, entry } = recorded({ n: 1, receipt: byReceipt(all.receipts, 'R-102'), transaction: s102 });
    const frozenEntry = deepFreeze(structuredClone(entry));
    const result = evaluateWorkspace(
      deepFreeze(input({ ...all, matches: [match], ledgerEntries: [frozenEntry], activeRules: [aliasRule()] })),
    );
    for (const [id, ref] of [['R-103', 'S-103'], ['R-201', 'S-201'], ['R-202', 'S-202']] as const) {
      const p = result.proposals.get(id)!;
      expect(p.outcome, id).toBe('unique_candidate');
      expect(p.transactionId, id).toBe(byRef(all.transactions, ref).id);
      expect(p.ruleRefs, id).toEqual([K_ALIAS]);
      expect(p.explanation, id).toBe(`Matches ${ref}. Matched name using K-ALIAS-0001 v1.`);
    }
    // The recorded R-102 entry is not re-evaluated or rewritten; R-103's category is untouched.
    expect(result.proposals.has('R-102')).toBe(false);
    expect(frozenEntry).toEqual(entry);
    const v103 = deriveCaseView(byReceipt(all.receipts, 'R-103'), result, [match], [entry], [aliasRule()]);
    expect(v103.category.status).toBe('unassigned');
    expect(v103.group).toBe('ready');
  });

  it('T04 the same alias does not apply outside its account/statement scope', () => {
    const r = receipt({ id: 'R-401', merchant: 'Morning Cup', date: '2026-03-04', amount: 4800 });
    const other = tx({ file: 'other.csv', row: 2, ref: 'O-1', label: 'MC COFFEE HK', posting: '2026-03-05', amount: 4800, account: 'Other Card 9999' });
    expect(other.accountId).toBe('acct:other-card-9999');
    const result = evaluateWorkspace(input({ receipts: [r], transactions: [other], activeRules: [aliasRule()] }));
    const p = result.proposals.get('R-401')!;
    expect(p.outcome).toBe('unmatched');
    expect(p.candidateIds).toEqual([]);
    expect(p.nearCandidateIds).toEqual([other.id]);
    expect(p.ruleRefs).toEqual([]);

    // In scope, the same alias does establish identity.
    const inScope = tx({ file: 'demo.csv', row: 2, ref: 'D-1', label: 'MC COFFEE HK', posting: '2026-03-05', amount: 4800 });
    const ok = evaluateWorkspace(input({ receipts: [r], transactions: [inScope], activeRules: [aliasRule()] }));
    expect(ok.proposals.get('R-401')!.outcome).toBe('unique_candidate');
  });

  it('T05 merchant knowledge does not override amount or currency mismatch', () => {
    const alias = [aliasRule()];
    const s103 = tx({ row: 4, ref: 'S-103', label: 'MC COFFEE HK', posting: '2026-03-07', amount: 6200 });

    // Off by one minor unit: not a candidate, reported as a difference only.
    const offByOne = receipt({ id: 'R-103', merchant: 'Morning Cup', date: '2026-03-06', amount: 6201 });
    const p = evaluateWorkspace(input({ receipts: [offByOne], transactions: [s103], activeRules: alias })).proposals.get('R-103')!;
    expect(p.outcome).toBe('unmatched');
    expect(p.candidateIds).toEqual([]);
    expect(p.transactionId).toBeNull();
    expect(p.trace.some((s) => s.check === 'difference' && s.message === 'S-103 is HKD 62.00, not HKD 62.01.')).toBe(true);

    // USD receipt: blocked as unsupported input, nothing converted.
    const usd = receipt({ id: 'R-501', merchant: 'Morning Cup', date: '2026-03-06', amount: 6200, currency: 'USD' });
    const usdTx = tx({ row: 5, ref: 'S-501', label: 'MC COFFEE HK', posting: '2026-03-07', amount: 6200, currency: 'USD' });
    const pu = evaluateWorkspace(input({ receipts: [usd], transactions: [s103, usdTx], activeRules: alias })).proposals.get('R-501')!;
    expect(pu.outcome).toBe('blocked');
    expect(pu.flags).toContain('unsupported_input');
    expect(pu.explanation).toContain('USD is not supported in this prototype. Nothing was converted.');
    expect(pu.candidateIds).toEqual([]);

    // HKD receipt vs USD row with the same digits: never a candidate.
    const hkd = receipt({ id: 'R-502', merchant: 'Morning Cup', date: '2026-03-06', amount: 6200 });
    const ph = evaluateWorkspace(input({ receipts: [hkd], transactions: [usdTx], activeRules: alias })).proposals.get('R-502')!;
    expect(ph.candidateIds).toEqual([]);

    // Manual resolution with a different amount or a non-HKD currency is rejected.
    const manual = checkManualResolution(input({ receipts: [offByOne], transactions: [s103], activeRules: alias }), {
      receiptId: 'R-103',
      transactionId: s103.id,
      reason: 'Looks like the same coffee',
    });
    expect(manual.ok).toBe(false);
    if (!manual.ok) {
      expect(manual.error).toBeInstanceOf(ValidationError);
      expect(manual.error.message).toBe('Amounts differ. Partial and split payments are not supported in this prototype.');
    }
    const manualUsd = checkManualResolution(input({ receipts: [usd], transactions: [s103] }), {
      receiptId: 'R-501',
      transactionId: s103.id,
      reason: 'Same purchase',
    });
    expect(manualUsd.ok).toBe(false);
  });

  it('T01/T05 boundary: different merchants whose names normalise to an empty label never match as "same name"', () => {
    // Both names have no Latin letters or digits, so both normalise to ''.
    const r = receipt({ id: 'R-701', merchant: '大家樂', date: '2026-03-10', amount: 4200 });
    const z1 = tx({ file: 'z.csv', row: 2, ref: 'Z-1', label: '美心', posting: '2026-03-11', amount: 4200 });
    const punct = tx({ file: 'z.csv', row: 3, ref: 'Z-2', label: '***', posting: '2026-03-11', amount: 4200 });
    expect(z1.normalizedLabel).toBe('');
    for (const t of [z1, punct]) {
      const inp = input({ receipts: [r], transactions: [t] });
      const p = evaluateWorkspace(inp).proposals.get('R-701')!;
      expect(p.outcome, t.reference ?? '').toBe('unmatched');
      expect(p.transactionId).toBeNull();
      expect(p.candidateIds).toEqual([]);
      expect(p.explanation).not.toContain('same name');
      // Manual resolution stays possible, but the name is not reported as matching.
      const manual = checkManualResolution(inp, { receiptId: 'R-701', transactionId: t.id, reason: 'Same lunch' });
      expect(manual.ok).toBe(true);
      if (manual.ok) expect(manual.value.identity).toBe('unrecognised');
    }
  });
});

describe('T06 date window', () => {
  const r = (date: string) => receipt({ id: 'R-601', merchant: 'Page Corner', date, amount: 5000 });
  const t = (posting: string, txnDate: string | null = null) =>
    tx({ file: 'w.csv', row: 2, ref: 'W-1', label: 'PAGE CORNER', posting, txnDate, amount: 5000 });
  const outcome = (date: string, posting: string, txnDate: string | null = null, rules = [] as ReturnType<typeof aliasRule>[]) =>
    evaluateWorkspace(input({ receipts: [r(date)], transactions: [t(posting, txnDate)], activeRules: rules })).proposals.get('R-601')!;

  it('T06 date-window boundaries are inclusive and unambiguous: lag −1 out, 0 and 3 in, 4 out', () => {
    expect(outcome('2026-03-10', '2026-03-09').outcome).toBe('unmatched');
    expect(outcome('2026-03-10', '2026-03-10').outcome).toBe('unique_candidate');
    expect(outcome('2026-03-10', '2026-03-13').outcome).toBe('unique_candidate');
    expect(outcome('2026-03-10', '2026-03-14').outcome).toBe('unmatched');
    expect(outcome('2026-03-10', '2026-03-14').trace.some((s) => s.check === 'difference' && s.message.includes('4 days after'))).toBe(true);
  });

  it('T06 across month end, year end and 29 February 2028', () => {
    expect(outcome('2026-01-30', '2026-02-02').outcome).toBe('unique_candidate');
    expect(outcome('2026-01-30', '2026-02-03').outcome).toBe('unmatched');
    expect(outcome('2026-12-30', '2027-01-02').outcome).toBe('unique_candidate');
    expect(outcome('2026-12-30', '2027-01-03').outcome).toBe('unmatched');
    expect(outcome('2028-02-27', '2028-03-01').outcome).toBe('unique_candidate'); // 27→28→29→1 = 3 days
    expect(outcome('2028-02-29', '2028-03-03').outcome).toBe('unique_candidate');
    expect(outcome('2028-02-29', '2028-03-04').outcome).toBe('unmatched');
    expect(outcome('2027-02-28', '2027-03-03').outcome).toBe('unique_candidate'); // no 29 Feb in 2027
    expect(outcome('2027-02-28', '2027-03-04').outcome).toBe('unmatched');
  });

  it('T06 the transaction date is shown but not used for eligibility', () => {
    expect(outcome('2026-03-10', '2026-03-11', '2025-12-01').outcome).toBe('unique_candidate');
    expect(outcome('2026-03-10', '2026-03-20', '2026-03-10').outcome).toBe('unmatched');
  });

  it('T06 dates are date-only and never parsed ambiguously', () => {
    expect(parseDateWithFormat('03/04/2026', 'DD/MM/YYYY')).toBe('2026-04-03');
    expect(parseDateWithFormat('03/04/2026', 'MM/DD/YYYY')).toBe('2026-03-04');
    expect(parseDateWithFormat('03/04/2026', 'YYYY-MM-DD')).toBeNull();
    expect(parseDateWithFormat('31/02/2026', 'DD/MM/YYYY')).toBeNull();
    expect(parseDateWithFormat('14/04/2026', 'MM/DD/YYYY')).toBeNull();
    expect(toIsoDate('2026-3-4')).toBeNull();
    expect(toIsoDate('2026-02-29')).toBeNull();
    expect(toIsoDate('2028-02-29')).toBe('2028-02-29');
    expect(toIsoDate('2026-03-04T00:00:00Z')).toBeNull();
    // A format may only be pre-selected when every cell is strict ISO.
    expect(allStrictIso(['2026-03-03', '2026-03-04'])).toBe(true);
    expect(allStrictIso(['2026-03-03', '03/04/2026'])).toBe(false);
    expect(daysBetween('2026-12-31' as IsoDate, '2027-01-01' as IsoDate)).toBe(1);
    expect(daysBetween('2026-03-10' as IsoDate, '2026-03-09' as IsoDate)).toBe(-1);
    // Real date check: 2027-02-29 is not a receipt date the schema accepts.
    expect(() => receipt({ id: 'R-602', merchant: 'Page Corner', date: '2027-02-29', amount: 100 })).toThrow();
  });

  it('T06 an approved posting-window policy of 1 day narrows the window and is cited', () => {
    const narrow = [policyRule({ days: 1 })];
    const two = outcome('2026-03-10', '2026-03-12', null, narrow);
    expect(two.outcome).toBe('unmatched');
    expect(two.policyRef).toEqual({ ruleId: 'K-POLICY-0001', version: 1 });
    expect(outcome('2026-03-10', '2026-03-11', null, narrow).outcome).toBe('unique_candidate');
    expect(outcome('2026-03-10', '2026-03-12').outcome).toBe('unique_candidate');
  });
});

describe('matching blocks and ambiguity', () => {
  it('T07 unvalidated or missing receipt fields block automatic matching', () => {
    const b = batch1();
    const inp = deepFreeze(input(b));
    const p = evaluateWorkspace(inp).proposals.get('R-104')!;
    expect(p.outcome).toBe('blocked');
    expect(p.flags).toEqual(['missing_fields']);
    expect(p.transactionId).toBeNull();
    expect(p.candidateIds).toEqual([]);
    expect(p.nearCandidateIds).toEqual([byRef(b.transactions, 'S-104').id]);
    expect(p.explanation).toBe('Amount is unclear on the receipt (read as “8?.00”). Check the image and enter it.');
    expect(p.trace.find((s) => s.check === 'candidates')?.message).toContain('Not compared: the receipt amount is not validated');
    // The statement amount is never copied into the receipt.
    const r104 = byReceipt(b.receipts, 'R-104');
    expect(r104.fields.amountMinor.original.value).toBeNull();
    expect(r104.fields.amountMinor.correction).toBeNull();

    // Each missing field blocks on its own.
    const s = tx({ file: 'm.csv', row: 2, ref: 'M-1', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });
    const full = { id: 'R-701', merchant: 'Page Corner', date: '2026-03-02', amount: 12000 } as const;
    const variants = [
      receipt({ ...full, merchant: null }),
      receipt({ ...full, date: null }),
      receipt({ ...full, amount: null }),
      receipt({ ...full, currency: null }),
    ];
    for (const v of variants) {
      const pv = evaluateWorkspace(input({ receipts: [v], transactions: [s] })).proposals.get('R-701')!;
      expect(pv.outcome).toBe('blocked');
      expect(pv.flags).toEqual(['missing_fields']);
      expect(pv.candidateIds).toEqual([]);
    }

    // Manual-entry values need explicit confirmation before they count as validated.
    const unconfirmed = receipt({ ...full, adapter: 'manual', confirmed: false });
    expect(evaluateWorkspace(input({ receipts: [unconfirmed], transactions: [s] })).proposals.get('R-701')!.flags).toEqual(['missing_fields']);
    const confirmed = receipt({ ...full, adapter: 'manual', confirmed: true });
    expect(evaluateWorkspace(input({ receipts: [confirmed], transactions: [s] })).proposals.get('R-701')!.outcome).toBe('unique_candidate');
  });

  it('T08 two candidate transactions remain ambiguous regardless of alias knowledge', () => {
    const all = allBatches(3);
    const a = byRef(all.transactions, 'S-301A').id;
    const bId = byRef(all.transactions, 'S-301B').id;

    const withAlias = evaluateWorkspace(input({ ...all, activeRules: [aliasRule()] })).proposals.get('R-301')!;
    expect(withAlias.outcome).toBe('ambiguous');
    expect(withAlias.transactionId).toBeNull();
    expect(withAlias.candidateIds).toEqual([a, bId].sort());
    expect(withAlias.explanation).toBe('2 card transactions match equally: S-301A, S-301B. Choose one.');

    const without = evaluateWorkspace(input(all)).proposals.get('R-301')!;
    expect(without.outcome).toBe('unmatched');
    expect(without.transactionId).toBeNull();
    expect(without.nearCandidateIds).toEqual([a, bId].sort());

    for (const rules of [[], [aliasRule()], [aliasRule({ label: 'CITY PARKING HK', merchant: 'City Parking' })]]) {
      const p105 = evaluateWorkspace(input({ ...all, activeRules: rules })).proposals.get('R-105')!;
      expect(p105.outcome).toBe('ambiguous');
      expect(p105.transactionId).toBeNull();
      expect(p105.candidateIds).toHaveLength(2);
    }

    // Never "the first row by accident": reversed input order gives the same result.
    const reversed = evaluateWorkspace(
      input({ receipts: [...all.receipts].reverse(), transactions: [...all.transactions].reverse(), activeRules: [aliasRule()] }),
    ).proposals.get('R-301')!;
    expect(reversed).toEqual(withAlias);
  });

  it('T09 two receipts competing for one transaction are not both matched', () => {
    const ra = receipt({ id: 'R-901', merchant: 'Page Corner', date: '2026-03-10', amount: 5000, doc: 'DOC-A' });
    const rb = receipt({ id: 'R-902', merchant: 'Page Corner', date: '2026-03-11', amount: 5000, doc: 'DOC-B' });
    const s = tx({ file: 'c.csv', row: 2, ref: 'S-900', label: 'PAGE CORNER', posting: '2026-03-12', amount: 5000 });
    const result = evaluateWorkspace(input({ receipts: [ra, rb], transactions: [s] }));
    const pa = result.proposals.get('R-901')!;
    const pb = result.proposals.get('R-902')!;
    for (const p of [pa, pb]) {
      expect(p.outcome).toBe('ambiguous');
      expect(p.transactionId).toBeNull();
    }
    expect(pa.explanation).toBe('Another receipt (R-902) also matches S-900. Choose which one it belongs to.');
    expect(pa.competingReceiptIds).toEqual(['R-902']);
    expect([...result.proposals.values()].filter((p) => p.outcome === 'unique_candidate')).toHaveLength(0);

    // Domain check for double-linking: a second manual link to a linked transaction is refused.
    const { match, entry } = recorded({ n: 1, receipt: ra, transaction: s });
    const second = checkManualResolution(input({ receipts: [ra, rb], transactions: [s], matches: [match], ledgerEntries: [entry] }), {
      receiptId: 'R-902',
      transactionId: s.id,
      reason: 'This is the one',
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error).toBeInstanceOf(AlreadyLinkedError);
      expect(second.error.message).toBe('That card transaction is already linked to R-901.');
    }
    // Once one receipt is linked, the other is no longer competing and finds nothing.
    const after = evaluateWorkspace(input({ receipts: [ra, rb], transactions: [s], matches: [match], ledgerEntries: [entry] }));
    expect(after.proposals.get('R-902')!.outcome).toBe('unmatched');
  });

  it('T09 (batch) proposals never share a transaction across the whole demo data', () => {
    const all = allBatches(3);
    const result = evaluateWorkspace(input({ ...all, activeRules: [aliasRule()] }));
    const taken = [...result.proposals.values()].filter((p) => p.outcome === 'unique_candidate').map((p) => p.transactionId);
    expect(taken).toHaveLength(7);
    expect(new Set(taken).size).toBe(taken.length);
  });
});

describe('K04 store-number alias match type (engine)', () => {
  const card = 'Visa 1234';
  const coffee = (row: number, label: string, posting: string, amount: number, account = card) => tx({ file: 'k04.csv', row, ref: `P-${row}`, label, posting, amount, account });
  const storeAlias = (label = 'PACIFIC COFFEE 042') =>
    aliasRule({ ruleId: 'K-ALIAS-0007', label, merchant: 'Pacific Coffee', accountId: 'acct:visa-1234', match: 'exact_ignoring_store_number' });
  const receipts = [
    receipt({ id: 'R-1', merchant: 'Pacific Coffee', date: '2026-03-02', amount: 3800 }),
    receipt({ id: 'R-2', merchant: 'Pacific Coffee', date: '2026-03-03', amount: 4200 }),
    receipt({ id: 'R-3', merchant: 'Pacific Coffee', date: '2026-03-04', amount: 5100 }),
    receipt({ id: 'R-4', merchant: 'Pacific Coffee', date: '2026-03-05', amount: 2900 }),
  ];
  const rows = [
    coffee(2, 'PACIFIC COFFEE #042', '2026-03-03', 3800),
    coffee(3, 'PACIFIC COFFEE #117', '2026-03-04', 4200),
    coffee(4, 'PACIFIC COFFEE ROASTERS #1', '2026-03-05', 5100),
    coffee(5, 'PACIFIC COFFEE #117', '2026-03-06', 2900, 'Other Card 9999'),
  ];

  it('K04 one trailing store number is ignored on both sides; a longer name is not covered; scope stays one card account', () => {
    const result = evaluateWorkspace(input({ receipts, transactions: rows, activeRules: [storeAlias()] }));
    const p = (id: string) => result.proposals.get(id)!;
    expect(p('R-1').outcome).toBe('unique_candidate');
    expect(p('R-2').outcome).toBe('unique_candidate');
    expect(p('R-2').ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0007', version: 1 }]);
    expect(p('R-2').explanation).toBe('Matches P-3. Matched name using K-ALIAS-0007 v1.');
    // "PACIFIC COFFEE ROASTERS #1" is a different name: not covered by a "PACIFIC COFFEE #042" rule.
    expect(p('R-3').outcome).toBe('unmatched');
    expect(p('R-3').ruleRefs).toEqual([]);
    // Same label on another card account: outside the scope.
    expect(p('R-4').outcome).toBe('unmatched');
  });

  it('K04 the store-number alias only establishes identity: amount, currency, date and ambiguity checks still apply', () => {
    const two = [coffee(2, 'PACIFIC COFFEE #042', '2026-03-03', 3800), coffee(3, 'PACIFIC COFFEE #117', '2026-03-03', 3800), coffee(4, 'PACIFIC COFFEE #9', '2026-03-03', 3801)];
    const result = evaluateWorkspace(input({ receipts: [receipts[0]!], transactions: two, activeRules: [storeAlias()] }));
    const p = result.proposals.get('R-1')!;
    expect(p.outcome).toBe('ambiguous');
    expect(p.candidateIds).toHaveLength(2);
    expect(p.candidateIds).not.toContain(two[2]!.id);
  });

  it('K04 existing exact rules are unchanged: an exact alias does not ignore store numbers', () => {
    const exact = aliasRule({ ruleId: 'K-ALIAS-0008', label: 'PACIFIC COFFEE 042', merchant: 'Pacific Coffee', accountId: 'acct:visa-1234' });
    const result = evaluateWorkspace(input({ receipts, transactions: rows, activeRules: [exact] }));
    expect(result.proposals.get('R-1')!.outcome).toBe('unique_candidate');
    expect(result.proposals.get('R-2')!.outcome).toBe('unmatched');
  });

  it('K04 an exact and a store-number alias that disagree about a label block it as a rule conflict', () => {
    const other = aliasRule({ ruleId: 'K-ALIAS-0009', label: 'PACIFIC COFFEE 117', merchant: 'Harbour Coffee', accountId: 'acct:visa-1234' });
    const result = evaluateWorkspace(input({ receipts, transactions: rows, activeRules: [storeAlias(), other] }));
    expect(result.proposals.get('R-2')!.flags).toContain('rule_conflict');
    expect(result.proposals.get('R-2')!.outcome).not.toBe('unique_candidate');
  });
});
