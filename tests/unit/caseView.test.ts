import { describe, expect, expectTypeOf, it } from 'vitest';
import { deriveCaseView, deriveTransactionCases, groupCases, type CaseView } from '../../src/domain/matching/caseView';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { LedgerEntrySchema } from '../../src/domain/schemas';
import { aliasRule, categoryRule, input, receipt, recorded, T0, tx } from '../builders';
import { allBatches, byReceipt, byRef } from '../scenario';

describe('separate status dimensions (S7)', () => {
  it('CaseView has no single status field', () => {
    expectTypeOf<CaseView>().not.toHaveProperty('status');
    expectTypeOf<CaseView>().toHaveProperty('capture');
    expectTypeOf<CaseView>().toHaveProperty('category');
    expectTypeOf<CaseView>().toHaveProperty('reconciliation');
    expectTypeOf<CaseView>().toHaveProperty('ledger');
    expectTypeOf<CaseView>().toHaveProperty('flags');
  });

  it('a confirmed category does not prove a match, and a confirmed match does not prove the category', () => {
    const r = receipt({ id: 'R-001', merchant: 'Page Corner', date: '2026-03-02', amount: 12000, category: { categoryId: 'books', status: 'confirmed' } });
    const ev = evaluateWorkspace(input({ receipts: [r] }));
    const v = deriveCaseView(r, ev, [], [], []);
    expect(v.category.status).toBe('confirmed');
    expect(v.reconciliation).toBe('unmatched');
    expect(v.group).toBe('needs_decision');

    const r2 = receipt({ id: 'R-002', merchant: 'Page Corner', date: '2026-03-02', amount: 12000 });
    const t = tx({ row: 2, ref: 'S-1', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });
    const rec = recorded({ n: 1, receipt: r2, transaction: t });
    const v2 = deriveCaseView(r2, evaluateWorkspace(input({ receipts: [r2], transactions: [t], matches: [rec.match], ledgerEntries: [rec.entry] })), [rec.match], [rec.entry], []);
    expect(v2.reconciliation).toBe('confirmed');
    expect(v2.ledger).toBe('recorded');
    expect(v2.category.status).toBe('unassigned');
    expect(v2.group).toBe('recorded');
  });

  it('a suggested category from a preference never changes the group or reconciliation', () => {
    const all = allBatches(1);
    const without = evaluateWorkspace(input({ ...all, activeRules: [aliasRule()] }));
    const withCat = evaluateWorkspace(input({ ...all, activeRules: [aliasRule(), categoryRule()] }));
    const r103 = byReceipt(all.receipts, 'R-103');
    const a = deriveCaseView(r103, without, [], [], [aliasRule()]);
    const b = deriveCaseView(r103, withCat, [], [], [aliasRule(), categoryRule()]);
    expect(a.category.status).toBe('unassigned');
    expect(b.category).toEqual({ categoryId: 'dining', status: 'suggested', ruleRef: { ruleId: 'K-CAT-0001', version: 1 } });
    expect([b.group, b.reconciliation, b.capture]).toEqual([a.group, a.reconciliation, a.capture]);
  });

  it('voided entries return the case to review; set-aside duplicates leave the three groups', () => {
    const r = receipt({ id: 'R-003', merchant: 'Page Corner', date: '2026-03-02', amount: 12000 });
    const t = tx({ row: 2, ref: 'S-1', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });
    const rec = recorded({ n: 1, receipt: r, transaction: t });
    const { activeIdentityKey: _k, ...rest } = rec.entry;
    void _k;
    const voided = LedgerEntrySchema.parse({ ...rest, status: 'voided', voidedAt: T0, voidReason: 'Wrong card' });
    const released = { ...rec.match, status: 'released' as const, activeTxnKey: undefined, activeSubjectKey: undefined };
    const ev = evaluateWorkspace(input({ receipts: [r], transactions: [t], matches: [released], ledgerEntries: [voided] }));
    const v = deriveCaseView(r, ev, [released], [voided], []);
    expect(v.ledger).toBe('voided');
    expect(v.voidedEntryIds).toEqual(['L-0001']);
    expect(v.reconciliation).toBe('unique_candidate');
    expect(v.group).toBe('ready');

    const aside = receipt({ id: 'R-004', merchant: 'Page Corner', date: '2026-03-02', amount: 12000, disposition: 'set_aside_duplicate' });
    const va = deriveCaseView(aside, evaluateWorkspace(input({ receipts: [aside] })), [], [], []);
    expect(va.reconciliation).toBe('not_applicable');
    expect(va.group).toBeNull();
    expect(groupCases([v, va]).setAside.map((x) => x.receiptId)).toEqual(['R-004']);
  });

  it('demo groups and card rows needing attention follow design §8 (alias and apply-once paths)', () => {
    const all = allBatches(3);
    const r102 = recorded({ n: 1, receipt: byReceipt(all.receipts, 'R-102'), transaction: byRef(all.transactions, 'S-102') });
    for (const [rules, ready, needs] of [[[aliasRule()], 6, 4], [[], 3, 7]] as const) {
      const ev = evaluateWorkspace(input({ ...all, matches: [r102.match], ledgerEntries: [r102.entry], activeRules: [...rules] }));
      const views = all.receipts.map((r) => deriveCaseView(r, ev, [r102.match], [r102.entry], [...rules]));
      const g = groupCases(views);
      expect([g.ready.length, g.needs_decision.length, g.recorded.length]).toEqual([ready, needs, 1]);
      const cards = deriveTransactionCases(ev, all.transactions);
      expect(cards).toEqual([{ transactionId: byRef(all.transactions, 'S-302').id, flags: ['unsupported_input'], explanation: 'Not supported: USD is not converted.' }]);
    }
    // Batch 1 alone: no card rows need attention (every row is a candidate or near candidate).
    const b1 = allBatches(1);
    expect(deriveTransactionCases(evaluateWorkspace(input(b1)), b1.transactions)).toEqual([]);
  });
});
