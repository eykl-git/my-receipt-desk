/**
 * Ledger integrity (design §6.4–§6.7, §14, REQ-7.4, REQ-7.7, REQ-13.3, REQ-17):
 * T12 statement-only entries gain receipt evidence, T13 unpaid invoices, T22
 * no double counting (with the category sub-case). Every case runs through the
 * real commands on MemoryRepository and IndexedDB.
 */
import { expect, it } from 'vitest';
import { paymentCandidates } from '../../src/domain/ledger/invoice';
import { ledgerCsv } from '../../src/domain/ledger/exportCsv';
import { deriveMetrics } from '../../src/domain/metrics';
import { deriveWorkspaceView } from '../../src/domain/views';
import { addPayable, attachPayment, confirmCategory, loadDemoBatch, recordProposal, recordStatementOnly, voidEntry } from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import type { WorkspaceSnapshot } from '../../src/persistence/repository';
import { describeEachRepo } from '../helpers/repos';
import { addReceipt, importCsv, personalRepo, png, txByLabel } from '../helpers/personal';
import { assets, demoRepo, txIdByRef, viewOf } from '../helpers/tour';

function metricsOf(s: WorkspaceSnapshot) {
  const state = asWorkspaceState(s);
  return deriveMetrics(state, deriveWorkspaceView(state), deriveWorkspaceView(state, []));
}

const CSV = [
  'Date,Posted,Details,Amount,Currency',
  '2026-04-02,2026-04-03,PAGE CORNER,-120.00,HKD',
  '2026-04-05,2026-04-06,HARBOUR PRINT LTD,-350.00,HKD',
  '2026-04-07,2026-04-08,CITY PARKING,-30.00,HKD',
  '',
].join('\n');

const INVOICE = { supplierName: 'Harbour Print Ltd', invoiceNumber: 'HP-2026-041', invoiceDate: '2026-04-01', amount: '350.00', currency: 'HKD' };

describeEachRepo('T12 statement-only entries', () => {
  it('T12 a statement-only recorded expense gains receipt evidence without a second ledger entry', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s0 = await repo.loadSnapshot();
    const s101 = txIdByRef(s0, 'S-101');
    const { ledgerEntryId } = await recordStatementOnly(repo, s101);
    const s1 = await repo.loadSnapshot();
    expect(s1.ledger).toHaveLength(1);
    expect(s1.ledger[0]).toMatchObject({ id: ledgerEntryId, origin: 'statement_only', identityKey: s101, status: 'recorded', amountMinor: 12000 });
    expect(s1.ledger[0]!.evidence).toEqual({ receiptIds: [], transactionIds: [s101], payableIds: [], sourceDocumentIds: [s0.transactions.find((t) => t.id === s101)!.sourceDocumentId], matchIds: [] });
    expect(s1.audit.at(-1)!.action).toBe('ledger.recorded');
    // R-101 is still ready: a statement-only entry stays eligible for receipt evidence.
    const r101 = viewOf(s1).caseById.get('R-101')!;
    expect(r101.group).toBe('ready');
    expect(metricsOf(s1).recordedPaidMinor).toBe(12000);
    await recordProposal(repo, r101.proposal!);
    const s2 = await repo.loadSnapshot();
    expect(s2.ledger).toHaveLength(1);
    const e = s2.ledger[0]!;
    expect(e.id).toBe(ledgerEntryId);
    expect(e.origin).toBe('statement_only');
    expect(e.evidence.receiptIds).toEqual(['R-101']);
    expect(e.evidence.transactionIds).toEqual([s101]);
    expect(e.evidence.matchIds).toEqual([s2.matches[0]!.id]);
    expect(s2.audit.slice(-2).map((a) => a.action)).toEqual(['match.confirmed', 'ledger.evidence_attached']);
    expect(viewOf(s2).caseById.get('R-101')).toMatchObject({ group: 'recorded', ledgerEntryId });
    // Counted once before and after the receipt was attached.
    expect(metricsOf(s2).recordedPaidMinor).toBe(12000);
  });

  it('T12 refuses to record a card transaction that is linked or already recorded', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s0 = await repo.loadSnapshot();
    await recordProposal(repo, viewOf(s0).caseById.get('R-101')!.proposal!);
    const s1 = await repo.loadSnapshot();
    await expect(recordStatementOnly(repo, txIdByRef(s1, 'S-101'))).rejects.toThrow('can’t be recorded on its own');
    await recordStatementOnly(repo, txIdByRef(s1, 'S-104'));
    await expect(recordStatementOnly(repo, txIdByRef(s1, 'S-104'))).rejects.toThrow('can’t be recorded on its own');
    expect((await repo.loadSnapshot()).ledger).toHaveLength(2);
  });
});

describeEachRepo('T13 unpaid invoices', () => {
  it('T13 an unpaid invoice is excluded from paid totals; adding payment evidence does not double-count it', async () => {
    const repo = personalRepo();
    await importCsv(repo, CSV);
    const added = await addPayable(repo, await png('invoice.png'), INVOICE);
    expect(added.payableId).toBe('INV-0001');
    const s1 = await repo.loadSnapshot();
    expect(s1.payables[0]).toMatchObject({ state: 'unpaid', amountMinor: 35000, paidByMatchId: null, supplierName: 'Harbour Print Ltd', invoiceNumber: 'HP-2026-041' });
    expect(s1.ledger).toEqual([]);
    const m1 = metricsOf(s1);
    expect(m1.unpaidInvoicesMinor).toBe(35000);
    expect(m1.recordedPaidMinor).toBe(0);
    expect(m1.cardSpendingWithoutRecordMinor).toBe(50000);
    expect(s1.audit.at(-1)!.action).toBe('capture.payable_added');

    // Only the equal-amount debit posted on or after the invoice date is offered.
    const harbour = txByLabel(s1, 'HARBOUR PRINT LTD');
    expect(paymentCandidates(s1.payables[0]!, s1.transactions, { matches: s1.matches, ledger: s1.ledger, currency: s1.currency }).map((t) => t.id)).toEqual([harbour]);
    await expect(attachPayment(repo, 'INV-0001', txByLabel(s1, 'PAGE CORNER'), 'Paid by card')).rejects.toThrow('can’t pay this invoice');
    await expect(attachPayment(repo, 'INV-0001', harbour, 'x')).rejects.toThrow('Reason must be');
    expect(await repo.loadSnapshot()).toEqual(s1);

    await attachPayment(repo, 'INV-0001', harbour, 'Paid by card on 6 April');
    const s2 = await repo.loadSnapshot();
    expect(s2.ledger).toHaveLength(1);
    expect(s2.ledger[0]).toMatchObject({ origin: 'invoice_payment', identityKey: harbour, amountMinor: 35000, status: 'recorded' });
    expect(s2.ledger[0]!.evidence.payableIds).toEqual(['INV-0001']);
    expect(s2.payables[0]).toMatchObject({ state: 'paid', paidByMatchId: s2.matches[0]!.id });
    expect(s2.matches[0]).toMatchObject({ subject: { kind: 'payable', id: 'INV-0001' }, method: 'manual_resolution', activeSubjectKey: 'payable:INV-0001' });
    expect(s2.audit.slice(-3).map((a) => a.action)).toEqual(['match.confirmed', 'ledger.recorded', 'payable.paid']);
    const m2 = metricsOf(s2);
    expect(m2.unpaidInvoicesMinor).toBe(0);
    expect(m2.recordedPaidMinor).toBe(35000);
    // The card row is now recorded, so it is no longer card spending without a record.
    expect(m2.cardSpendingWithoutRecordMinor).toBe(15000);
    expect(m2.recordedPaidMinor + m2.cardSpendingWithoutRecordMinor).toBe(50000);
    // A second payment for the same invoice is refused and writes nothing.
    await expect(attachPayment(repo, 'INV-0001', harbour, 'Again')).rejects.toThrow('already paid');
    expect(await repo.loadSnapshot()).toEqual(s2);
  });

  it('T13 paying an invoice whose card row was recorded from the statement extends that entry; voiding reopens the invoice', async () => {
    const repo = personalRepo();
    await importCsv(repo, CSV);
    const s0 = await repo.loadSnapshot();
    const harbour = txByLabel(s0, 'HARBOUR PRINT LTD');
    const { ledgerEntryId } = await recordStatementOnly(repo, harbour);
    await addPayable(repo, await png('invoice-2.png'), INVOICE);
    await attachPayment(repo, 'INV-0001', harbour, 'Paid by card');
    const s1 = await repo.loadSnapshot();
    expect(s1.ledger).toHaveLength(1);
    expect(s1.ledger[0]).toMatchObject({ id: ledgerEntryId, origin: 'statement_only' });
    expect(s1.ledger[0]!.evidence.payableIds).toEqual(['INV-0001']);
    expect(s1.audit.slice(-3).map((a) => a.action)).toEqual(['match.confirmed', 'ledger.evidence_attached', 'payable.paid']);
    expect(metricsOf(s1).recordedPaidMinor).toBe(35000);
    await voidEntry(repo, ledgerEntryId, 'Wrong card row');
    const s2 = await repo.loadSnapshot();
    expect(s2.payables[0]).toMatchObject({ state: 'unpaid', paidByMatchId: null });
    expect(s2.matches[0]).toMatchObject({ status: 'released' });
    expect(s2.audit.slice(-3).map((a) => a.action)).toEqual(['ledger.voided', 'match.released', 'payable.reopened']);
    expect(metricsOf(s2)).toMatchObject({ recordedPaidMinor: 0, unpaidInvoicesMinor: 35000 });
  });

  it('T13 invoices exist only in My files, and an identical file is not added twice', async () => {
    const demo = demoRepo();
    await expect(addPayable(demo, await png('demo-invoice.png'), INVOICE)).rejects.toThrow('only be added in My files');
    const repo = personalRepo();
    const file = await png('same.png');
    await addPayable(repo, file, INVOICE);
    expect(await addPayable(repo, file, INVOICE)).toEqual({ payableId: null, duplicateOf: 'INV-0001' });
    const s = await repo.loadSnapshot();
    expect(s.payables).toHaveLength(1);
    expect(s.audit.at(-1)!.action).toBe('capture.duplicate_upload_rejected');
  });
});

describeEachRepo('T22 no double counting', () => {
  it('T22 recorded expense totals do not count statement and receipt evidence twice', async () => {
    const repo = personalRepo();
    await importCsv(repo, CSV);
    const r = await addReceipt(repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
    const s0 = await repo.loadSnapshot();
    const debitTotal = 50000;
    // Receipt match on PAGE CORNER, statement-only entry on CITY PARKING.
    await recordProposal(repo, viewOf(s0).caseById.get(r)!.proposal!);
    await recordStatementOnly(repo, txByLabel(s0, 'CITY PARKING'));
    const s1 = await repo.loadSnapshot();
    const m = metricsOf(s1);
    const recorded = s1.ledger.filter((e) => e.status === 'recorded');
    expect(recorded).toHaveLength(2);
    expect(m.recordedPaidMinor).toBe(recorded.reduce((n, e) => n + e.amountMinor, 0));
    expect(m.recordedPaidMinor).toBe(15000);
    // The linked card transaction is not added again: recorded + without record = all debits, exactly once.
    expect(m.recordedPaidMinor + m.cardSpendingWithoutRecordMinor).toBe(debitTotal);
    expect(m.linkedTransactions).toBe(1);
    expect(m.receiptsWithConfirmedMatches).toBe(1);
    // A voided entry stops counting; nothing else changes.
    await voidEntry(repo, recorded.find((e) => e.origin === 'statement_only')!.id, 'Recorded by mistake');
    const m2 = metricsOf(await repo.loadSnapshot());
    expect(m2.recordedPaidMinor).toBe(12000);
    expect(m2.recordedPaidMinor + m2.cardSpendingWithoutRecordMinor).toBe(debitTotal);
  });

  it('T22 (category sub-case) "Confirm category" on recorded R-101 updates the receipt and its entry together, leaves matches alone, and the export shows it', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s0 = await repo.loadSnapshot();
    await recordProposal(repo, viewOf(s0).caseById.get('R-101')!.proposal!);
    const s1 = await repo.loadSnapshot();
    expect(s1.ledger[0]!.category).toEqual({ categoryId: null, status: 'unassigned' });
    await confirmCategory(repo, 'R-101', 'books');
    const s2 = await repo.loadSnapshot();
    expect(s2.matches).toEqual(s1.matches);
    expect(s2.transactions).toEqual(s1.transactions);
    expect(s2.receipts.find((x) => x.id === 'R-101')!.category).toMatchObject({ categoryId: 'books', status: 'confirmed' });
    expect(s2.ledger[0]!.category).toEqual({ categoryId: 'books', status: 'confirmed' });
    const events = s2.audit.slice(s1.audit.length);
    expect(events.map((a) => a.action)).toEqual(['category.confirmed', 'ledger.category_changed']);
    expect(events[1]!.before).toEqual({ categoryId: null, status: 'unassigned' });
    expect(events[1]!.after).toEqual({ categoryId: 'books', status: 'confirmed' });
    expect(metricsOf(s2).recordedPaidMinor).toBe(metricsOf(s1).recordedPaidMinor);
    const csv = ledgerCsv(asWorkspaceState(s2));
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain('"Books & stationery","confirmed","recorded","confirmed"');
    // Confirming the same category again writes nothing.
    expect(await confirmCategory(repo, 'R-101', 'books')).toEqual({ changed: false });
    expect(await repo.loadSnapshot()).toEqual(s2);
    // On a pending receipt only the receipt changes, and its group is untouched.
    const groupBefore = viewOf(s2).caseById.get('R-105')!.group;
    await confirmCategory(repo, 'R-105', 'transport');
    const s3 = await repo.loadSnapshot();
    expect(s3.ledger).toEqual(s2.ledger);
    expect(s3.audit.slice(s2.audit.length).map((a) => a.action)).toEqual(['category.confirmed']);
    expect(viewOf(s3).caseById.get('R-105')!.group).toBe(groupBefore);
  });
});
