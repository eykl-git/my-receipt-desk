import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AuditActionSchema,
  AuditEventSchema,
  ConfirmedMatchSchema,
  LedgerEntrySchema,
  MatchProposalSchema,
  MetaRecordSchema,
  PayableSchema,
  ReceiptSchema,
  ReviewDecisionSchema,
  RuleHeadSchema,
  RuleVersionSchema,
  SourceDocumentSchema,
  StatementTransactionSchema,
  StoredRuleVersionSchema,
  type Receipt,
} from '../../src/domain/schemas';
import { buildAuditEvent } from '../../src/domain/audit/events';
import { effectiveFields } from '../../src/domain/capture/fields';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { aliasRule, categoryRule, distinctDecision, fakeSha, head, input, policyRule, receipt, recorded, T0, tx } from '../builders';
import { batch1 } from '../scenario';

const roundTrip = <S extends z.ZodType>(schema: S, value: unknown) => {
  const parsed = schema.parse(JSON.parse(JSON.stringify(value)));
  expect(parsed).toEqual(value);
};

const sourceDocument = {
  schemaVersion: 1,
  workspaceId: 'demo',
  id: 'DOC-0001',
  sha256: fakeSha('R-102.svg'),
  fileName: 'R-102.svg',
  mimeType: 'image/svg+xml',
  sizeBytes: 1234,
  sourceType: 'demo_receipt_image',
  importedAt: T0,
  fileKey: 'file:DOC-0001',
};

const payable = {
  schemaVersion: 1,
  workspaceId: 'personal',
  id: 'INV-0001',
  sourceDocumentId: 'DOC-0002',
  supplierName: 'Harbour Print Shop',
  canonicalMerchantId: 'm:harbour-print-shop',
  invoiceNumber: 'HP-77',
  invoiceDate: '2026-04-01',
  amountMinor: 45000,
  currency: 'HKD',
  state: 'unpaid',
  paidByMatchId: null,
};

describe('typed, versioned models (S14)', () => {
  it('every stored model round-trips through its schema', () => {
    const b = batch1();
    const rec = recorded({ n: 1, receipt: b.receipts[1]!, transaction: b.transactions[1]! });
    roundTrip(SourceDocumentSchema, sourceDocument);
    for (const r of b.receipts) roundTrip(ReceiptSchema, r);
    for (const t of b.transactions) roundTrip(StatementTransactionSchema, t);
    roundTrip(PayableSchema, payable);
    roundTrip(LedgerEntrySchema, rec.entry);
    roundTrip(ConfirmedMatchSchema, rec.match);
    for (const v of [aliasRule(), categoryRule(), policyRule({ days: 2 })]) {
      roundTrip(RuleVersionSchema, v);
      roundTrip(RuleHeadSchema, head(v));
      roundTrip(StoredRuleVersionSchema, { ...v, schemaVersion: 1, workspaceId: 'demo' });
    }
    roundTrip(ReviewDecisionSchema, distinctDecision(1, 'R-1', 'R-2'));
    roundTrip(
      AuditEventSchema,
      buildAuditEvent({ workspaceId: 'demo', seq: 1, at: T0, action: 'match.confirmed', affected: [{ kind: 'receipt', id: 'R-102' }], ruleRefs: [], reason: 'x' }),
    );
    roundTrip(MetaRecordSchema, { key: 'demoState', value: { loadedBatches: [1], tourStep: 1, clockTick: 0 } });
    roundTrip(MetaRecordSchema, { key: 'counters', values: { match: 1, ledger: 1, audit: 3, ALIAS: 0 } });
    for (const p of evaluateWorkspace(input(b)).proposals.values()) roundTrip(MatchProposalSchema, p);
  });

  it('records carry schemaVersion 1 and a workspace, and unknown keys or wrong versions are rejected', () => {
    const r = batch1().receipts[0]!;
    expect(r.schemaVersion).toBe(1);
    expect(ReceiptSchema.safeParse({ ...r, schemaVersion: 2 }).success).toBe(false);
    expect(ReceiptSchema.safeParse({ ...r, workspaceId: 'shared' }).success).toBe(false);
    expect(ReceiptSchema.safeParse({ ...r, status: 'ready' }).success).toBe(false);
    const t = batch1().transactions[0]!;
    expect(StatementTransactionSchema.safeParse({ ...t, amountMinor: 120.5 }).success).toBe(false);
    expect(StatementTransactionSchema.safeParse({ ...t, postingDate: '03/03/2026' }).success).toBe(false);
    expect(StatementTransactionSchema.safeParse({ ...t, direction: 'out' }).success).toBe(false);
    expect(PayableSchema.safeParse({ ...payable, state: 'partially_paid' }).success).toBe(false);
  });

  it('the audit action list is closed', () => {
    expect(AuditActionSchema.safeParse('rule.activated').success).toBe(true);
    expect(AuditActionSchema.safeParse('rule.deleted').success).toBe(false);
    // 29 actions of design §4.1 plus `capture.fields_extracted` for "Read automatically" (S4, design §20 A-S4-3).
    expect(AuditActionSchema.options).toHaveLength(30);
    expect(AuditActionSchema.safeParse('capture.fields_extracted').success).toBe(true);
  });

  it('a ledger entry keeps activeIdentityKey exactly while recorded; a rule head is active iff activeVersion is set', () => {
    const b = batch1();
    const { entry } = recorded({ n: 1, receipt: b.receipts[0]!, transaction: b.transactions[0]! });
    expect(LedgerEntrySchema.safeParse({ ...entry, status: 'voided' }).success).toBe(false);
    const { activeIdentityKey: _drop, ...voided } = entry;
    void _drop;
    expect(LedgerEntrySchema.safeParse({ ...voided, status: 'voided', voidedAt: T0, voidReason: 'Wrong card' }).success).toBe(true);
    expect(RuleHeadSchema.safeParse({ ...head(aliasRule()), activeVersion: null }).success).toBe(false);
  });

  it('original values are kept apart from corrections', () => {
    const r = receipt({ id: 'R-001', merchant: 'Morning Cup', date: '2026-03-04', amount: null, unclear: { amountMinor: '4?.00' }, adapter: 'manual' });
    const corrected: Receipt = ReceiptSchema.parse({
      ...r,
      fields: { ...r.fields, amountMinor: { ...r.fields.amountMinor, correction: { value: 4800, at: T0, by: 'local-owner' }, confirmedAt: T0 } },
    });
    expect(corrected.fields.amountMinor.original).toEqual({ value: null, raw: '4?.00', clarity: 'unclear', provenance: { adapterId: 'manual', kind: 'manual' } });
    expect(effectiveFields(corrected).amountMinor).toBe(4800);
    expect(effectiveFields(r).amountMinor).toBeNull();
    // A statement transaction is observed evidence with its own source-row identity.
    const t = tx({ row: 9, ref: null, label: 'X SHOP', posting: '2026-03-04', amount: 100 });
    expect(t.sourceRowId).toMatch(/^[0-9a-f]{64}:9$/);
    expect(t.id).toMatch(/^TX-[0-9a-f]{12}-9$/);
  });
});
