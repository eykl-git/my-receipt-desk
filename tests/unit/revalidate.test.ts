import { describe, expect, it } from 'vitest';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { revalidate } from '../../src/domain/matching/revalidate';
import type { Receipt } from '../../src/domain/schemas';
import { aliasRule, input, receipt, recorded, T0 } from '../builders';
import { allBatches, byReceipt, byRef } from '../scenario';

describe('revalidate before commit', () => {
  const all = allBatches(1);
  const base = input({ ...all, activeRules: [aliasRule()] });
  const shown = evaluateWorkspace(base).proposals.get('R-103')!;

  it('T15 (domain) an unchanged state revalidates to the same proposal', () => {
    expect(shown.outcome).toBe('unique_candidate');
    const r = revalidate(base, shown);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.fingerprint).toBe(shown.fingerprint);
  });

  it('T15 (domain) a stale proposal is refused after the alias is suspended', () => {
    const r = revalidate({ ...base, activeRules: [] }, shown);
    expect(r).toEqual({ ok: false, reason: 'rule_changed' });
  });

  it('T15 (domain) a stale proposal is refused after the alias is superseded by a new version', () => {
    const r = revalidate({ ...base, activeRules: [aliasRule({ version: 2 })] }, shown);
    expect(r).toEqual({ ok: false, reason: 'rule_changed' });
  });

  it('T15 (domain) a stale proposal is refused after a competing commit links the transaction', () => {
    const other = receipt({ id: 'R-190', merchant: 'Morning Cup', date: '2026-03-06', amount: 6200, doc: 'DOC-OTHER' });
    const { match, entry } = recorded({ n: 1, receipt: other, transaction: byRef(all.transactions, 'S-103') });
    const r = revalidate({ ...base, receipts: [...all.receipts, other], matches: [match], ledgerEntries: [entry] }, shown);
    expect(r).toEqual({ ok: false, reason: 'transaction_taken' });
  });

  it('T15 (domain) a stale proposal is refused after the receipt is edited', () => {
    const r103 = byReceipt(all.receipts, 'R-103');
    const edited: Receipt = {
      ...r103,
      fields: {
        ...r103.fields,
        merchant: { ...r103.fields.merchant, correction: { value: 'Morning Cup Cafe', at: T0, by: 'local-owner' }, confirmedAt: T0 },
      },
      updatedAt: '2026-03-31T09:00:05.000Z',
    };
    const receipts = all.receipts.map((r) => (r.id === 'R-103' ? edited : r));
    expect(revalidate({ ...base, receipts }, shown)).toEqual({ ok: false, reason: 'receipt_changed' });
  });

  it('T15 (domain) a stale proposal is refused when a new competing receipt makes it ambiguous', () => {
    const rival = receipt({ id: 'R-191', merchant: 'Morning Cup', date: '2026-03-05', amount: 6200, doc: 'DOC-RIVAL' });
    expect(revalidate({ ...base, receipts: [...all.receipts, rival] }, shown)).toEqual({ ok: false, reason: 'now_ambiguous' });
  });
});
