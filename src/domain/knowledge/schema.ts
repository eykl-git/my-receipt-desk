/**
 * Knowledge rule schemas (design §4, §7.1). Strict objects at every level: an
 * unknown key (for example `amountTolerance` or `disableAmbiguityCheck`) fails
 * parsing, so a rule can never carry an action the engine does not support.
 */
import { z } from 'zod';
import {
  CategoryIdSchema,
  EvidenceRefSchema,
  IsoDateTimeSchema,
  LocalOwnerSchema,
  RuleIdSchema,
  SchemaVersionSchema,
  WorkspaceIdSchema,
} from '../primitives';

export const RULE_TYPES = ['merchant_alias', 'category_preference', 'posting_window'] as const;
export type RuleType = (typeof RULE_TYPES)[number];

const aliasShape = {
  type: z.literal('merchant_alias'),
  // Nullable so a draft without an account parses and is reported as OVERBROAD.
  scope: z.strictObject({ accountId: z.string().max(80).nullable() }),
  // 'exact_ignoring_store_number' (brief §25 D) compares labels without one trailing store number.
  condition: z.strictObject({ observedLabel: z.string().min(1).max(200), match: z.enum(['exact', 'exact_ignoring_store_number']) }),
  action: z.strictObject({
    canonicalMerchantId: z.string().min(1).max(200),
    canonicalMerchantName: z.string().min(1).max(120),
  }),
};

const categoryShape = {
  type: z.literal('category_preference'),
  scope: z.strictObject({ workspace: z.literal(true) }),
  condition: z.strictObject({ canonicalMerchantId: z.string().min(1).max(200) }),
  action: z.strictObject({ suggestCategoryId: CategoryIdSchema }),
};

const policyShape = {
  type: z.literal('posting_window'),
  scope: z.strictObject({ workspace: z.literal(true) }),
  condition: z.strictObject({}),
  // Bounded only to 0…365 here; 8…365 parses and is rejected as UNSAFE_POLICY (§7.1).
  action: z.strictObject({ postingLagMaxDays: z.number().int().min(0).max(365) }),
};

const contentShape = {
  plainEnglish: z.string().min(1).max(1000),
  exclusions: z.array(z.string().min(1).max(200)).max(20),
  evidenceRefs: z.array(EvidenceRefSchema).max(50),
};

const versionShape = {
  ruleId: RuleIdSchema,
  version: z.number().int().min(1),
  ownerId: LocalOwnerSchema,
  createdAt: IsoDateTimeSchema,
  approvedBy: LocalOwnerSchema.optional(),
  approvedAt: IsoDateTimeSchema.optional(),
  discardedAt: IsoDateTimeSchema.optional(),
};

const storedShape = { schemaVersion: SchemaVersionSchema, workspaceId: WorkspaceIdSchema };

/** Draft content: what a user (or a future model adapter) proposes. No ID yet. */
export const RuleDraftSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...aliasShape, ...contentShape }),
  z.strictObject({ ...categoryShape, ...contentShape }),
  z.strictObject({ ...policyShape, ...contentShape }),
]);
export type RuleDraft = z.infer<typeof RuleDraftSchema>;

/** An immutable rule version (content + identity + approval metadata). */
export const RuleVersionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...aliasShape, ...contentShape, ...versionShape }),
  z.strictObject({ ...categoryShape, ...contentShape, ...versionShape }),
  z.strictObject({ ...policyShape, ...contentShape, ...versionShape }),
]);
export type RuleVersion = z.infer<typeof RuleVersionSchema>;
export type AliasRuleVersion = Extract<RuleVersion, { type: 'merchant_alias' }>;
export type CategoryRuleVersion = Extract<RuleVersion, { type: 'category_preference' }>;
export type PolicyRuleVersion = Extract<RuleVersion, { type: 'posting_window' }>;

/** A rule version as stored in a workspace. */
export const StoredRuleVersionSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...aliasShape, ...contentShape, ...versionShape, ...storedShape }),
  z.strictObject({ ...categoryShape, ...contentShape, ...versionShape, ...storedShape }),
  z.strictObject({ ...policyShape, ...contentShape, ...versionShape, ...storedShape }),
]);
export type StoredRuleVersion = z.infer<typeof StoredRuleVersionSchema>;

export const RuleStatusSchema = z.enum(['draft_only', 'active', 'suspended', 'discarded']);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

export const RuleHeadSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    workspaceId: WorkspaceIdSchema,
    ruleId: RuleIdSchema,
    type: z.enum(RULE_TYPES),
    status: RuleStatusSchema,
    currentVersion: z.number().int().min(1),
    activeVersion: z.number().int().min(1).nullable(),
    lastApprovedVersion: z.number().int().min(1).nullable(),
    draftVersion: z.number().int().min(1).nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .refine((h) => (h.status === 'active') === (h.activeVersion !== null), {
    message: 'activeVersion is set exactly when the rule is active',
  });
export type RuleHead = z.infer<typeof RuleHeadSchema>;

/** Strip identity and approval metadata, leaving the draft content of a version. */
export function toDraftContent(version: RuleVersion): RuleDraft {
  return {
    type: version.type,
    scope: version.scope,
    condition: version.condition,
    action: version.action,
    plainEnglish: version.plainEnglish,
    exclusions: version.exclusions,
    evidenceRefs: version.evidenceRefs,
  } as RuleDraft;
}

export function ruleKindForType(type: RuleType): 'ALIAS' | 'CAT' | 'POLICY' {
  return type === 'merchant_alias' ? 'ALIAS' : type === 'category_preference' ? 'CAT' : 'POLICY';
}
