/** Generated plain-English meaning and exclusions for each rule type (design §7.1). */
import { effectiveFields } from '../capture/fields';
import { categoryName, type CategoryId } from '../categories';
import { canonicalMerchantId, storeNumberStem } from '../normalize';
import type { Receipt, StatementTransaction } from '../schemas';
import type { AliasMatch } from './resolve';
import type { RuleDraft, RuleType } from './schema';

/** Merchant display name for a canonical merchant ID, from receipts in the workspace. */
export function merchantNameFor(receipts: readonly Receipt[], merchantId: string): string | null {
  for (const r of receipts) {
    const m = effectiveFields(r).merchant;
    if (m !== null && canonicalMerchantId(m) === merchantId) return m;
  }
  return null;
}

/**
 * Regenerates a draft's `plainEnglish` and `exclusions` from its structured
 * fields, the way the draft panel does. Text that arrives with a draft (for
 * example from an imported knowledge file) is untrusted and never kept.
 */
export function withGeneratedText(
  draft: RuleDraft,
  workspace: { receipts: readonly Receipt[]; transactions: readonly Pick<StatementTransaction, 'accountId' | 'accountLabel'>[] },
): RuleDraft {
  switch (draft.type) {
    case 'merchant_alias': {
      const accountLabel = workspace.transactions.find((t) => t.accountId === draft.scope.accountId)?.accountLabel ?? null;
      return {
        ...draft,
        plainEnglish: aliasPlainEnglish(draft.condition.observedLabel, accountLabel, draft.action.canonicalMerchantName, draft.condition.match),
        exclusions: exclusionsFor('merchant_alias', draft.condition.match),
      };
    }
    case 'category_preference': {
      const id = draft.condition.canonicalMerchantId;
      const name = merchantNameFor(workspace.receipts, id) ?? id.replace(/^m:/, '');
      return { ...draft, plainEnglish: categoryPlainEnglish(name, draft.action.suggestCategoryId), exclusions: exclusionsFor('category_preference') };
    }
    case 'posting_window':
      return { ...draft, plainEnglish: policyPlainEnglish(draft.action.postingLagMaxDays), exclusions: exclusionsFor('posting_window') };
  }
}

export function aliasPlainEnglish(observedLabel: string, accountLabel: string | null, merchantName: string, match: AliasMatch = 'exact'): string {
  const where = accountLabel ? `On card ${accountLabel}, the` : 'The';
  if (match === 'exact_ignoring_store_number') {
    return `${where} statement label “${storeNumberStem(observedLabel)}”, alone or followed by one store number such as #042, means the merchant ${merchantName}. Amount, currency, date, duplicate and ambiguity checks still apply.`;
  }
  return `${where} statement label “${observedLabel}” means the merchant ${merchantName}. Amount, currency, date, duplicate and ambiguity checks still apply.`;
}

export function categoryPlainEnglish(merchantName: string, categoryId: CategoryId): string {
  return `Receipts from ${merchantName} get the suggested category ${categoryName(categoryId)}. You still confirm the category, and matching is not affected.`;
}

export function policyPlainEnglish(postingLagMaxDays: number): string {
  return `A card transaction can be posted 0–${postingLagMaxDays} days after the receipt date (demo policy). Amount, currency, name, duplicate and ambiguity checks still apply.`;
}

/** Generated, not user-editable. */
export function exclusionsFor(type: RuleType, match: AliasMatch = 'exact'): string[] {
  switch (type) {
    case 'merchant_alias':
      return match === 'exact_ignoring_store_number'
        ? ['Other card accounts', 'Labels with other words, such as a longer name before the store number', 'Amount, currency, date and ambiguity checks']
        : ['Other card accounts', 'Labels that only contain this text', 'Amount, currency, date and ambiguity checks'];
    case 'category_preference':
      return ['Other merchants', 'Matching decisions', 'Recorded entries keep their category'];
    case 'posting_window':
      return ['Amount, currency, name, duplicate and ambiguity checks', 'Windows longer than 7 days'];
  }
}
