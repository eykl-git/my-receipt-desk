/**
 * Rule draft validation (design §7.1, §7.3). Activation requires zero errors.
 * Schema failures are reported alone (semantic checks are skipped); otherwise
 * every applicable semantic code is reported, not just the first.
 */
import type { z } from 'zod';
import { effectiveFields } from '../capture/fields';
import { canonicalMerchantId, isCanonicalMerchantId, normalizeLabel, storeNumberStem } from '../normalize';
import type { Payable, Receipt, StatementTransaction } from '../schemas';
import { canonicalJson } from '../matching/fingerprint';
import { LIMITS } from '../limits';
import { aliasCoversLabel, aliasesOf, categoryPreferencesOf, policiesOf } from './resolve';

/** The name left after removing a store number must have at least this many normalised characters (brief §25 D). */
export const STORE_NUMBER_STEM_MIN_CHARS = 6;
import { isGenericLabel, MAX_POSTING_LAG } from './safety';
import { RuleDraftSchema, toDraftContent, type RuleDraft, type RuleHead, type RuleVersion } from './schema';

export type FindingCode =
  | 'INVALID_SCHEMA'
  | 'UNSUPPORTED_ACTION'
  | 'NO_EVIDENCE'
  | 'OVERBROAD'
  | 'ALIAS_CYCLE'
  | 'CONFLICT'
  | 'DUPLICATE'
  | 'UNSAFE_POLICY'
  | 'STALE_PREVIEW'
  | 'NO_PENDING_EFFECT';

export interface Finding {
  code: FindingCode;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
}

export interface DraftValidation {
  errors: Finding[];
  warnings: Finding[];
  /** The parsed draft, or null when the schema check failed. */
  draft: RuleDraft | null;
}

export interface ValidationContext {
  receipts: readonly Receipt[];
  transactions: readonly StatementTransaction[];
  payables: readonly Payable[];
  activeRules: readonly RuleVersion[];
  ruleHeads: readonly RuleHead[];
  /** The rule this draft belongs to (an edit): its own active version is not a conflict. */
  ruleId?: string | null;
  /** Present when activation is requested: the preview shown and the current state fingerprint. */
  activation?: { preview: { stateFingerprint: string } | null; currentFingerprint: string };
  /** The impact preview, when one exists (drives the NO_PENDING_EFFECT warning). */
  preview?: { pendingChanges: readonly unknown[] } | null;
}

export const VALIDATION_MESSAGES = Object.freeze({
  previewFirst: 'Preview the impact first',
  previewStale: 'The data changed since the preview. Preview the impact again.',
});

const WILDCARD_OR_REGEX = /[*%?_.^$+()[\]{}|\\]/;

function mapZodIssues(issues: readonly z.core.$ZodIssue[]): Finding[] {
  const out: Finding[] = [];
  for (const issue of issues) {
    const path = issue.path.map(String).join('.');
    if (issue.code === 'unrecognized_keys') {
      out.push({
        code: 'UNSUPPORTED_ACTION',
        severity: 'error',
        message: `Not a supported rule setting: ${issue.keys.join(', ')}.`,
        path,
      });
    } else if (issue.code === 'invalid_union') {
      out.push({
        code: 'UNSUPPORTED_ACTION',
        severity: 'error',
        message: 'Not a supported rule type. Supported: merchant name, category preference, posting window.',
        path,
      });
    } else {
      out.push({ code: 'INVALID_SCHEMA', severity: 'error', message: `${path || 'Rule'}: ${issue.message}`, path });
    }
  }
  return out;
}

/** Canonical merchants known in the workspace: canonical ID → normalised name. */
function knownMerchants(ctx: ValidationContext, otherAliases: readonly RuleVersion[]): Map<string, string> {
  const known = new Map<string, string>();
  for (const r of ctx.receipts) {
    if (r.disposition !== 'active') continue;
    const m = effectiveFields(r).merchant;
    if (m !== null) known.set(canonicalMerchantId(m), normalizeLabel(m));
  }
  for (const p of ctx.payables) known.set(p.canonicalMerchantId, normalizeLabel(p.supplierName));
  for (const a of aliasesOf(otherAliases)) known.set(a.action.canonicalMerchantId, normalizeLabel(a.action.canonicalMerchantName));
  return known;
}

const sameContent = (a: RuleDraft | RuleVersion, b: RuleDraft | RuleVersion): boolean =>
  a.type === b.type &&
  canonicalJson({ s: a.scope, c: a.condition, a: a.action }) === canonicalJson({ s: b.scope, c: b.condition, a: b.action });

function semanticFindings(draft: RuleDraft, ctx: ValidationContext): Finding[] {
  const out: Finding[] = [];
  const add = (code: FindingCode, message: string) => out.push({ code, severity: 'error', message });
  // Validate against all active rules except the version this draft supersedes.
  const others = ctx.activeRules.filter((r) => r.ruleId !== ctx.ruleId);

  if (draft.type === 'merchant_alias') {
    const raw = draft.condition.observedLabel;
    const label = normalizeLabel(raw);
    const accountId = draft.scope.accountId;
    const target = draft.action;
    const hasWildcard = WILDCARD_OR_REGEX.test(raw);
    const accountKnown = accountId !== null && accountId !== '' && ctx.transactions.some((t) => t.accountId === accountId);

    // OVERBROAD: scope must be one existing card account and an exact, specific label.
    if (accountId === null || accountId === '') add('OVERBROAD', 'Choose the card account this name applies to.');
    else if (!accountKnown) add('OVERBROAD', 'That card account is not in this workspace.');
    if (hasWildcard) add('OVERBROAD', 'Use the exact card label. Wildcards and patterns are not allowed.');
    else if (raw !== label) {
      out.push({ code: 'INVALID_SCHEMA', severity: 'error', message: `Store the card label in normalised form: “${label}”.`, path: 'condition.observedLabel' });
    }
    if (label.length < LIMITS.aliasLabelMinChars) add('OVERBROAD', `The card label is too short (at least ${LIMITS.aliasLabelMinChars} characters).`);
    if (label.length > LIMITS.aliasLabelMaxChars) add('OVERBROAD', `The card label is too long (at most ${LIMITS.aliasLabelMaxChars} characters).`);
    if (isGenericLabel(label)) add('OVERBROAD', `“${label}” is a payment-processor label. It can’t identify one merchant.`);

    // Store-number type (brief §25 D): the name left after one trailing store number must still be specific.
    const ignoring = draft.condition.match === 'exact_ignoring_store_number';
    const stem = storeNumberStem(label);
    if (ignoring) {
      if (stem.length < STORE_NUMBER_STEM_MIN_CHARS) {
        add('OVERBROAD', `Without its store number the card label is too short (at least ${STORE_NUMBER_STEM_MIN_CHARS} characters).`);
      }
      if (isGenericLabel(stem)) add('OVERBROAD', `“${stem}” is a payment-processor label. It can’t identify one merchant.`);
    }

    // NO_EVIDENCE: the label (or, for the store-number type, its stem) must appear on a card row in that account.
    const covers = (normalized: string) => aliasCoversLabel({ observedLabel: label, match: draft.condition.match }, normalized);
    if (accountKnown && !hasWildcard && !ctx.transactions.some((t) => t.accountId === accountId && t.normalizedLabel !== '' && covers(t.normalizedLabel))) {
      add('NO_EVIDENCE', ignoring ? 'No card transaction in this account has this label, with or without a store number.' : 'No card transaction in this account has exactly this label.');
    }

    // ALIAS_CYCLE: map observed labels to a canonical merchant, never alias-to-alias.
    const targetNorm = normalizeLabel(target.canonicalMerchantName);
    const otherAliases = aliasesOf(others);
    if (label === targetNorm) add('ALIAS_CYCLE', 'The card label is already the merchant’s own name.');
    if (!isCanonicalMerchantId(target.canonicalMerchantId) || target.canonicalMerchantId !== canonicalMerchantId(target.canonicalMerchantName)) {
      add('ALIAS_CYCLE', 'The target must be a canonical merchant.');
    }
    if (otherAliases.some((a) => a.condition.observedLabel === targetNorm)) {
      add('ALIAS_CYCLE', `“${target.canonicalMerchantName}” is itself an alias label, not a canonical merchant.`);
    }
    for (const [id, name] of knownMerchants(ctx, others)) {
      if (id !== target.canonicalMerchantId && (name === label || (ignoring && name === stem))) {
        add('ALIAS_CYCLE', `“${name}” is already the name of another merchant.`);
        break;
      }
    }

    // CONFLICT / DUPLICATE against other active aliases whose labels overlap in this account.
    for (const a of otherAliases) {
      if (a.scope.accountId !== accountId) continue;
      // Some card label would be covered by both rules.
      const overlaps = aliasCoversLabel(a.condition, label) || covers(a.condition.observedLabel);
      if (!overlaps) continue;
      if (a.action.canonicalMerchantId !== target.canonicalMerchantId) {
        add('CONFLICT', `${a.ruleId} v${a.version} already maps this label to ${a.action.canonicalMerchantName}.`);
      }
    }
  }

  if (draft.type === 'category_preference') {
    const merchantId = draft.condition.canonicalMerchantId;
    // "m:" would cover every merchant whose name has no comparable characters.
    if (!isCanonicalMerchantId(merchantId)) {
      add('OVERBROAD', 'This merchant name has no letters or digits the app can compare, so the preference can’t be limited to one merchant.');
    }
    const hasReceipt = ctx.receipts.some((r) => {
      const m = effectiveFields(r).merchant;
      return r.disposition === 'active' && m !== null && canonicalMerchantId(m) === merchantId;
    });
    if (!hasReceipt) add('NO_EVIDENCE', 'No receipt from this merchant exists in this workspace.');
    for (const p of categoryPreferencesOf(others)) {
      if (p.condition.canonicalMerchantId === merchantId && p.action.suggestCategoryId !== draft.action.suggestCategoryId) {
        add('CONFLICT', `${p.ruleId} v${p.version} already suggests a different category for this merchant.`);
      }
    }
  }

  if (draft.type === 'posting_window') {
    const days = draft.action.postingLagMaxDays;
    if (!Number.isInteger(days) || days < 0 || days > MAX_POSTING_LAG) {
      add('UNSAFE_POLICY', `The posting window must be 0–${MAX_POSTING_LAG} days. This limit can’t be changed.`);
    }
    if (policiesOf(others).length > 0) add('CONFLICT', 'Another posting-window rule is already active.');
    else if (ctx.ruleHeads.some((h) => h.type === 'posting_window' && h.status !== 'discarded' && h.ruleId !== ctx.ruleId)) {
      add('CONFLICT', 'A matching-policy rule already exists here. Edit it instead.');
    }
  }

  for (const r of others) {
    if (sameContent(draft, r)) add('DUPLICATE', `${r.ruleId} v${r.version} already does exactly this. Nothing would change.`);
  }

  if (ctx.activation) {
    const { preview, currentFingerprint } = ctx.activation;
    if (preview === null) add('STALE_PREVIEW', VALIDATION_MESSAGES.previewFirst);
    else if (preview.stateFingerprint !== currentFingerprint) add('STALE_PREVIEW', VALIDATION_MESSAGES.previewStale);
  }
  return out;
}

function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    const k = `${f.code}|${f.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Validate draft content (no rule ID or approval metadata). */
export function validateDraft(draft: unknown, ctx: ValidationContext): DraftValidation {
  const parsed = RuleDraftSchema.safeParse(draft);
  if (!parsed.success) return { errors: dedupe(mapZodIssues(parsed.error.issues)), warnings: [], draft: null };
  const errors = dedupe(semanticFindings(parsed.data, ctx));
  const warnings: Finding[] = [];
  if (ctx.preview && ctx.preview.pendingChanges.length === 0) {
    warnings.push({ code: 'NO_PENDING_EFFECT', severity: 'warning', message: 'No pending case would change. You can still activate it for future receipts.' });
  }
  return { errors, warnings, draft: parsed.data };
}

/** Validate a stored version (its content) in the context of its own rule. */
export function validateVersion(version: RuleVersion, ctx: ValidationContext): DraftValidation {
  return validateDraft(toDraftContent(version), { ...ctx, ruleId: ctx.ruleId ?? version.ruleId });
}
