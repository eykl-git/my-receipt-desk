/**
 * Shared zod primitives and status dimensions (design §4, §5). Kept apart from
 * schemas.ts so the knowledge rule schema can use them without an import cycle.
 */
import { z } from 'zod';
import { CATEGORY_IDS } from './categories';
import { isIsoDate, type IsoDate } from './dates';
import { RULE_ID_PATTERN } from './ids';
import { LIMITS } from './limits';

export const SCHEMA_VERSION = 1 as const;
export const SchemaVersionSchema = z.literal(SCHEMA_VERSION);

export const WorkspaceIdSchema = z.enum(['demo', 'personal']);
export type WorkspaceId = z.infer<typeof WorkspaceIdSchema>;

export const IsoDateSchema = z.custom<IsoDate>((v) => isIsoDate(v), {
  message: 'Expected a real calendar date in YYYY-MM-DD form',
});
export const IsoDateTimeSchema = z.iso.datetime();

/** Item amounts: 1…999,999,999 minor units (HKD 0.01 to 9,999,999.99). */
export const MinorUnitsSchema = z.number().int().min(LIMITS.amountMinMinor).max(LIMITS.amountMaxMinor);
export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'Expected a three-letter currency code');
export const DirectionSchema = z.enum(['debit', 'credit']);
export type Direction = z.infer<typeof DirectionSchema>;

export const CategoryIdSchema = z.enum(CATEGORY_IDS);

export const RuleIdSchema = z.string().regex(RULE_ID_PATTERN, 'Expected a rule ID such as K-ALIAS-0001');
export const RuleRefSchema = z.strictObject({ ruleId: RuleIdSchema, version: z.number().int().min(1) });
export type RuleRef = z.infer<typeof RuleRefSchema>;

/** Policy in force: the built-in baseline `P-BASE v0` or an approved `K-POLICY-n vN`. */
export const PolicyRefSchema = z.union([
  z.strictObject({ ruleId: z.literal('P-BASE'), version: z.literal(0) }),
  z.strictObject({ ruleId: z.string().regex(/^K-POLICY-\d{4}$/), version: z.number().int().min(1) }),
]);
export type PolicyRef = z.infer<typeof PolicyRefSchema>;

export const EvidenceKindSchema = z.enum(['receipt', 'transaction', 'match', 'ledger', 'source_document', 'imported']);
export const EvidenceRefSchema = z.strictObject({ kind: EvidenceKindSchema, ref: z.string().min(1).max(200) });
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// Separate status dimensions (S7). There is deliberately no single "status".
export const CaptureStatusSchema = z.enum(['needs_review', 'validated']);
export type CaptureStatus = z.infer<typeof CaptureStatusSchema>;
export const CategoryStatusSchema = z.enum(['unassigned', 'suggested', 'confirmed']);
export type CategoryStatus = z.infer<typeof CategoryStatusSchema>;
export const ReconciliationStatusSchema = z.enum([
  'unmatched',
  'unique_candidate',
  'ambiguous',
  'confirmed',
  'not_applicable',
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;
export const LedgerCaseStatusSchema = z.enum(['draft', 'recorded', 'voided']);
export type LedgerCaseStatus = z.infer<typeof LedgerCaseStatusSchema>;
export const ReviewFlagSchema = z.enum([
  'duplicate_suspected',
  'missing_receipt',
  'missing_fields',
  'unsupported_input',
  'rule_conflict',
]);
export type ReviewFlag = z.infer<typeof ReviewFlagSchema>;

export const LOCAL_OWNER = 'local-owner' as const;
export const LocalOwnerSchema = z.literal(LOCAL_OWNER);

export function formatRuleRef(ref: { ruleId: string; version: number }): string {
  return `${ref.ruleId} v${ref.version}`;
}

export function sameRef(a: { ruleId: string; version: number }, b: { ruleId: string; version: number }): boolean {
  return a.ruleId === b.ruleId && a.version === b.version;
}
