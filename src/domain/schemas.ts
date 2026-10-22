/**
 * Typed, versioned, zod-validated models for every stored entity (design §4, S14).
 * Every stored record carries `schemaVersion: 1` and `workspaceId`.
 *
 * Provenance is kept explicit:
 * - observed evidence: SourceDocument, StatementTransaction, ExtractedField.original
 * - user assertions: ReceiptField.correction / confirmedAt, ConfirmedMatch.method + reason
 * - proposed interpretations: MatchProposal (derived, never stored) and its trace
 * - approved policy: RuleVersion with approvedAt
 */
import { z } from 'zod';
import { LIMITS } from './limits';
import {
  CategoryIdSchema,
  CategoryStatusSchema,
  CurrencyCodeSchema,
  DirectionSchema,
  EvidenceRefSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LocalOwnerSchema,
  MinorUnitsSchema,
  PolicyRefSchema,
  ReviewFlagSchema,
  RuleRefSchema,
  SchemaVersionSchema,
  WorkspaceIdSchema,
} from './primitives';

export * from './primitives';
export * from './knowledge/schema';

const stored = { schemaVersion: SchemaVersionSchema, workspaceId: WorkspaceIdSchema };

// ---------------------------------------------------------------------------
// Source document (original file identity)

export const SourceTypeSchema = z.enum([
  'demo_receipt_image',
  'demo_statement_csv',
  'receipt_upload',
  'invoice_upload',
  'statement_csv',
]);

export const SourceDocumentSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^DOC-[A-Za-z0-9-]+$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  fileName: z.string().min(1).max(LIMITS.fileNameMaxChars),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().min(0),
  sourceType: SourceTypeSchema,
  importedAt: IsoDateTimeSchema,
  fileKey: z.string().min(1).max(200),
});
export type SourceDocument = z.infer<typeof SourceDocumentSchema>;

// ---------------------------------------------------------------------------
// Receipt fields: original extraction kept apart from user corrections

export const FieldClaritySchema = z.enum(['clear', 'unclear', 'missing']);
export type FieldClarity = z.infer<typeof FieldClaritySchema>;
export const AdapterKindSchema = z.enum(['demo-fixture', 'manual', 'ocr', 'model']);
export type AdapterKind = z.infer<typeof AdapterKindSchema>;
export const AdapterRefSchema = z.strictObject({ adapterId: z.string().min(1).max(80), kind: AdapterKindSchema });

export function extractedFieldSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({
    value: value.nullable(),
    raw: z.string().max(200).nullable(),
    clarity: FieldClaritySchema,
    provenance: AdapterRefSchema,
  });
}

export function receiptFieldSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({
    /** What the source said. Never overwritten. */
    original: extractedFieldSchema(value),
    /** The user's corrected value, stored only where it differs from the original. */
    correction: z.strictObject({ value, at: IsoDateTimeSchema, by: LocalOwnerSchema }).nullable(),
    /** Set when the user explicitly confirmed this field. */
    confirmedAt: IsoDateTimeSchema.nullable(),
  });
}

export const MerchantValueSchema = z.string().trim().min(LIMITS.merchantMinChars).max(LIMITS.merchantMaxChars);

export const ReceiptFieldsSchema = z.strictObject({
  merchant: receiptFieldSchema(MerchantValueSchema),
  date: receiptFieldSchema(IsoDateSchema),
  amountMinor: receiptFieldSchema(MinorUnitsSchema),
  currency: receiptFieldSchema(CurrencyCodeSchema),
});
export type ReceiptFields = z.infer<typeof ReceiptFieldsSchema>;
export type FieldName = keyof ReceiptFields;
export const FIELD_NAMES: readonly FieldName[] = Object.freeze(['merchant', 'date', 'amountMinor', 'currency']);

export const StoredCategorySchema = z.strictObject({
  categoryId: CategoryIdSchema.nullable(),
  status: CategoryStatusSchema,
  ruleRef: RuleRefSchema.optional(),
  confirmedAt: IsoDateTimeSchema.optional(),
});

export const ReceiptSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^R-[A-Za-z0-9-]+$/),
  sourceDocumentId: z.string().min(1),
  fixtureId: z.string().min(1).max(40).optional(),
  adapter: z.strictObject({ id: z.string().min(1).max(80), kind: AdapterKindSchema }),
  fields: ReceiptFieldsSchema,
  /** Untrusted text printed on the receipt. Display only; never read for control. */
  printedText: z.string().max(LIMITS.printedTextMaxChars).nullable(),
  canonicalMerchantId: z.string().min(1).max(200).nullable(),
  disposition: z.enum(['active', 'set_aside_duplicate']),
  category: StoredCategorySchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type Receipt = z.infer<typeof ReceiptSchema>;

// ---------------------------------------------------------------------------
// Statement transaction

export const TransactionIntakeSchema = z.enum([
  'available',
  'quarantined_currency',
  'credit_not_supported',
  'set_aside_duplicate',
]);

export const StatementTransactionSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^TX-[0-9a-f]{12}-\d+$/),
  sourceDocumentId: z.string().min(1),
  sourceRowId: z.string().regex(/^[0-9a-f]{64}:\d+$/),
  rowNumber: z.number().int().min(1),
  reference: z.string().min(1).max(LIMITS.csvCellMaxChars).nullable(),
  accountId: z.string().regex(/^acct:[a-z0-9&'-]+$/),
  accountLabel: z.string().min(1).max(LIMITS.accountNameMaxChars),
  rawLabel: z.string().max(LIMITS.csvDescriptionMaxChars),
  normalizedLabel: z.string().max(LIMITS.csvDescriptionMaxChars),
  transactionDate: IsoDateSchema.nullable(),
  postingDate: IsoDateSchema,
  currency: CurrencyCodeSchema,
  direction: DirectionSchema,
  amountMinor: MinorUnitsSchema,
  intake: TransactionIntakeSchema,
  duplicateSuspected: z.boolean(),
  /** The earlier row this one may duplicate (shown in the flag text, M1). */
  duplicateOf: z.string().min(1).nullable(),
  duplicateResolution: z.literal('kept').nullable(),
  rawCells: z.array(z.string().max(LIMITS.csvCellMaxChars)).max(LIMITS.csvMaxColumns),
});
export type StatementTransaction = z.infer<typeof StatementTransactionSchema>;

// ---------------------------------------------------------------------------
// Invoice / payable (secondary record type)

export const PayableSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^INV-\d{4,}$/),
  sourceDocumentId: z.string().min(1),
  supplierName: MerchantValueSchema,
  canonicalMerchantId: z.string().min(1).max(200),
  invoiceNumber: z.string().min(1).max(LIMITS.invoiceNumberMaxChars).nullable(),
  invoiceDate: IsoDateSchema,
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  state: z.enum(['unpaid', 'paid']),
  paidByMatchId: z.string().min(1).nullable(),
});
export type Payable = z.infer<typeof PayableSchema>;

// ---------------------------------------------------------------------------
// Ledger entry: one expense identity

export const LedgerEntrySchema = z
  .strictObject({
    ...stored,
    id: z.string().regex(/^L-\d{4,}$/),
    origin: z.enum(['receipt_match', 'statement_only', 'invoice_payment']),
    /** The card transaction ID this expense is (always present). */
    identityKey: z.string().min(1),
    /** Equals identityKey while recorded; removed on void (backs a unique index). */
    activeIdentityKey: z.string().min(1).optional(),
    status: z.enum(['recorded', 'voided']),
    expenseDate: IsoDateSchema,
    merchantName: z.string().min(1).max(LIMITS.csvDescriptionMaxChars),
    canonicalMerchantId: z.string().min(1).max(200).nullable(),
    amountMinor: MinorUnitsSchema,
    currency: CurrencyCodeSchema,
    category: z.strictObject({
      categoryId: CategoryIdSchema.nullable(),
      status: CategoryStatusSchema,
      ruleRef: RuleRefSchema.optional(),
    }),
    evidence: z.strictObject({
      receiptIds: z.array(z.string()),
      transactionIds: z.array(z.string()).min(1),
      payableIds: z.array(z.string()),
      sourceDocumentIds: z.array(z.string()),
      matchIds: z.array(z.string()),
    }),
    ruleRefs: z.array(RuleRefSchema),
    recordedAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    voidedAt: IsoDateTimeSchema.optional(),
    voidReason: z.string().min(LIMITS.reasonMinChars).max(LIMITS.reasonMaxChars).optional(),
  })
  .refine((e) => (e.status === 'recorded') === (e.activeIdentityKey === e.identityKey), {
    message: 'activeIdentityKey must equal identityKey exactly while the entry is recorded',
  });
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

// ---------------------------------------------------------------------------
// Match proposal (derived) and confirmed match (stored)

export const TraceCheckSchema = z.enum([
  'fields',
  'currency',
  'duplicate',
  'rule_conflict',
  'candidates',
  'merchant_identity',
  'held',
  'outcome',
  'collision',
  'difference',
  'category',
  'manual',
]);
export type TraceCheck = z.infer<typeof TraceCheckSchema>;

export const TraceStepSchema = z.strictObject({
  check: TraceCheckSchema,
  result: z.enum(['pass', 'fail', 'info']),
  message: z.string().min(1).max(1000),
  evidence: z.array(EvidenceRefSchema),
  ruleRef: z.union([RuleRefSchema, PolicyRefSchema]).optional(),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const ENGINE_VERSION = 'match-engine/1' as const;
export const MatchOutcomeSchema = z.enum(['unique_candidate', 'ambiguous', 'unmatched', 'blocked']);
export type MatchOutcome = z.infer<typeof MatchOutcomeSchema>;

export const MatchProposalSchema = z.strictObject({
  subject: z.strictObject({ kind: z.literal('receipt'), id: z.string() }),
  outcome: MatchOutcomeSchema,
  transactionId: z.string().nullable(),
  candidateIds: z.array(z.string()),
  nearCandidateIds: z.array(z.string()),
  heldIds: z.array(z.string()),
  competingReceiptIds: z.array(z.string()),
  flags: z.array(ReviewFlagSchema),
  explanation: z.string(),
  ruleRefs: z.array(RuleRefSchema),
  policyRef: PolicyRefSchema,
  engineVersion: z.literal(ENGINE_VERSION),
  category: z.strictObject({ categoryId: CategoryIdSchema.nullable(), ruleRef: RuleRefSchema.nullable() }),
  receiptKey: z.string(),
  fingerprint: z.string(),
  trace: z.array(TraceStepSchema),
});
export type MatchProposal = z.infer<typeof MatchProposalSchema>;

export const ConfirmedMatchSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^M-\d{4,}$/),
  subject: z.strictObject({ kind: z.enum(['receipt', 'payable']), id: z.string().min(1) }),
  transactionId: z.string().min(1),
  activeTxnKey: z.string().min(1).optional(),
  activeSubjectKey: z.string().min(1).optional(),
  status: z.enum(['active', 'released']),
  method: z.enum(['confirmed_proposal', 'manual_resolution']),
  reason: z.string().min(LIMITS.reasonMinChars).max(LIMITS.reasonMaxChars).nullable(),
  proposalSnapshot: z.strictObject({
    candidateIds: z.array(z.string()),
    ruleRefs: z.array(RuleRefSchema),
    policyRef: PolicyRefSchema,
    engineVersion: z.literal(ENGINE_VERSION),
    trace: z.array(TraceStepSchema),
  }),
  ledgerEntryId: z.string().regex(/^L-\d{4,}$/),
  confirmedAt: IsoDateTimeSchema,
  confirmedBy: LocalOwnerSchema,
  releasedAt: IsoDateTimeSchema.optional(),
  releaseReason: z.string().min(LIMITS.reasonMinChars).max(LIMITS.reasonMaxChars).optional(),
});
export type ConfirmedMatch = z.infer<typeof ConfirmedMatchSchema>;

// ---------------------------------------------------------------------------
// Review decisions and audit events

export const ReviewDecisionSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^D-\d{4,}$/),
  kind: z.enum(['duplicate_resolution', 'historical_recheck']),
  subjectIds: z.array(z.string().min(1)).min(1),
  choice: z.enum(['distinct', 'set_aside', 'keep', 'void']),
  reason: z.string().max(LIMITS.reasonMaxChars).nullable(),
  at: IsoDateTimeSchema,
});
export type ReviewDecision = z.infer<typeof ReviewDecisionSchema>;

export const AUDIT_ACTIONS = [
  'capture.receipt_added',
  'capture.fields_confirmed',
  'capture.fields_extracted',
  'capture.duplicate_upload_rejected',
  'capture.duplicate_resolved',
  'capture.payable_added',
  'import.statement_committed',
  'import.duplicate_file_rejected',
  'import.row_set_aside',
  'import.rows_kept',
  'demo.batch_loaded',
  'match.confirmed',
  'match.released',
  'ledger.recorded',
  'ledger.evidence_attached',
  'ledger.evidence_detached',
  'ledger.voided',
  'ledger.category_changed',
  'category.confirmed',
  'rule.draft_created',
  'rule.draft_updated',
  'rule.draft_discarded',
  'rule.activated',
  'rule.suspended',
  'rule.reactivated',
  'proposals.invalidated',
  'knowledge.imported',
  'recheck.kept',
  'payable.paid',
  'payable.reopened',
] as const;
/** Closed list of audit actions (design §4.1). */
export const AuditActionSchema = z.enum(AUDIT_ACTIONS);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditEventSchema = z.strictObject({
  ...stored,
  id: z.string().regex(/^A-\d{6,}$/),
  seq: z.number().int().min(1),
  at: IsoDateTimeSchema,
  actor: z.enum(['local-owner', 'system']),
  action: AuditActionSchema,
  affected: z.array(z.strictObject({ kind: z.string().min(1).max(40), id: z.string().min(1) })),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  evidenceRefs: z.array(EvidenceRefSchema),
  ruleRefs: z.array(RuleRefSchema),
  reason: z.string().max(LIMITS.reasonMaxChars).nullable(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

// ---------------------------------------------------------------------------
// Workspace meta

export const DemoStateSchema = z.strictObject({
  loadedBatches: z.array(z.union([z.literal(1), z.literal(2), z.literal(3)])),
  tourStep: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  clockTick: z.number().int().min(0),
});
export type DemoState = z.infer<typeof DemoStateSchema>;

/**
 * Workspace currency (brief §26 A, REQ-20): My files can use HKD (default) or
 * MYR; the demo is always HKD. Amounts in any other currency are flagged as
 * unsupported and never converted.
 */
export const WORKSPACE_CURRENCIES = ['HKD', 'MYR'] as const;
export const WorkspaceCurrencySchema = z.enum(WORKSPACE_CURRENCIES);
export type WorkspaceCurrency = z.infer<typeof WorkspaceCurrencySchema>;

export const MetaRecordSchema = z.discriminatedUnion('key', [
  z.strictObject({ key: z.literal('schema'), version: z.number().int().min(1) }),
  z.strictObject({ key: z.literal('counters'), values: z.record(z.string(), z.number().int().min(0)) }),
  z.strictObject({ key: z.literal('demoState'), value: DemoStateSchema }),
  z.strictObject({ key: z.literal('settings'), currency: WorkspaceCurrencySchema }),
]);
export type MetaRecord = z.infer<typeof MetaRecordSchema>;
