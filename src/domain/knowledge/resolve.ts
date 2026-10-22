/**
 * Resolution of active knowledge (design §4, §5, §6). Pure lookups over the
 * list of active rule versions; nothing here relaxes a matching check.
 */
import type { CategoryId } from '../categories';
import type { PolicyRef, RuleRef } from '../primitives';
import type { Receipt } from '../schemas';
import { canonicalMerchantId, isCanonicalMerchantId, storeNumberStem } from '../normalize';
import { effectiveFields } from '../capture/fields';
import type { AliasRuleVersion, CategoryRuleVersion, PolicyRuleVersion, RuleHead, RuleVersion } from './schema';
import { BASELINE_POLICY } from './safety';

export const refOf = (v: { ruleId: string; version: number }): RuleRef => ({ ruleId: v.ruleId, version: v.version });

export function aliasesOf(rules: readonly RuleVersion[]): AliasRuleVersion[] {
  return rules.filter((r): r is AliasRuleVersion => r.type === 'merchant_alias');
}

export function categoryPreferencesOf(rules: readonly RuleVersion[]): CategoryRuleVersion[] {
  return rules.filter((r): r is CategoryRuleVersion => r.type === 'category_preference');
}

export function policiesOf(rules: readonly RuleVersion[]): PolicyRuleVersion[] {
  return rules.filter((r): r is PolicyRuleVersion => r.type === 'posting_window');
}

export const aliasKey = (accountId: string, observedLabel: string): string => `${accountId}|${observedLabel}`;

export type AliasMatch = 'exact' | 'exact_ignoring_store_number';

/**
 * Whether an alias condition covers a normalised card label (S-9: exact labels
 * within one account; the store-number type also ignores one trailing store
 * number on both sides, brief §25 D). The account is checked by the caller.
 */
export function aliasCoversLabel(condition: { observedLabel: string; match: AliasMatch }, normalizedLabel: string): boolean {
  if (condition.match === 'exact') return condition.observedLabel === normalizedLabel;
  return storeNumberStem(condition.observedLabel) === storeNumberStem(normalizedLabel);
}

/** Distinct card labels in the alias's account that it would cover (shown in the draft preview). */
export function coveredLabels(
  draft: { scope: { accountId: string | null }; condition: { observedLabel: string; match: AliasMatch } },
  transactions: readonly { accountId: string; normalizedLabel: string; rawLabel: string }[],
): string[] {
  const out = new Set<string>();
  for (const t of transactions) {
    if (t.accountId === draft.scope.accountId && t.normalizedLabel !== '' && aliasCoversLabel(draft.condition, t.normalizedLabel)) out.add(t.rawLabel);
  }
  return [...out].sort();
}

export interface EffectivePolicy {
  ref: PolicyRef;
  postingLagMaxDays: number;
}

/**
 * The posting-window policy in force: the single active `K-POLICY` rule, or
 * the built-in `P-BASE v0` (3 days). With more than one active policy rule
 * (only possible through corrupted storage) the baseline is used, because
 * guessing between them would be unsafe.
 */
export function policyFromRules(rules: readonly RuleVersion[]): EffectivePolicy {
  const policies = policiesOf(rules);
  if (policies.length === 1) {
    const p = policies[0]!;
    return { ref: { ruleId: p.ruleId, version: p.version }, postingLagMaxDays: p.action.postingLagMaxDays };
  }
  return { ref: { ...BASELINE_POLICY.ref }, postingLagMaxDays: BASELINE_POLICY.postingLagMaxDays };
}

/** Active category preference for a canonical merchant (null when none or when preferences conflict). */
export function categorySuggestion(
  rules: readonly RuleVersion[],
  merchantId: string | null,
): { categoryId: CategoryId; ruleRef: RuleRef } | null {
  // "m:" (a name with no comparable characters) never carries a preference.
  if (merchantId === null || !isCanonicalMerchantId(merchantId)) return null;
  const prefs = categoryPreferencesOf(rules).filter((r) => r.condition.canonicalMerchantId === merchantId);
  if (prefs.length !== 1) return null;
  const p = prefs[0]!;
  return { categoryId: p.action.suggestCategoryId, ruleRef: refOf(p) };
}

export interface DerivedCategory {
  categoryId: CategoryId | null;
  status: 'unassigned' | 'suggested' | 'confirmed';
  ruleRef: RuleRef | null;
}

/**
 * Category dimension (§5): stored on the receipt; `suggested` is computed from
 * an active category preference only while the stored status is `unassigned`.
 * Never feeds back into matching.
 */
export function deriveCategory(receipt: Receipt, rules: readonly RuleVersion[]): DerivedCategory {
  const stored = receipt.category;
  if (stored.status !== 'unassigned') {
    return { categoryId: stored.categoryId, status: stored.status, ruleRef: stored.ruleRef ?? null };
  }
  const merchant = effectiveFields(receipt).merchant;
  const suggestion = categorySuggestion(rules, merchant === null ? null : canonicalMerchantId(merchant));
  if (!suggestion) return { categoryId: null, status: 'unassigned', ruleRef: null };
  return { categoryId: suggestion.categoryId, status: 'suggested', ruleRef: suggestion.ruleRef };
}

/** Active rule versions from heads + versions (one per active head). */
export function activeRulesFrom(heads: readonly RuleHead[], versions: readonly RuleVersion[]): RuleVersion[] {
  const out: RuleVersion[] = [];
  for (const h of heads) {
    if (h.status !== 'active' || h.activeVersion === null) continue;
    const v = versions.find((x) => x.ruleId === h.ruleId && x.version === h.activeVersion);
    if (v) out.push(v);
  }
  return out.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}
