/**
 * Structured rule form ↔ draft content (design §7.2 b, §9.3). The form is the
 * editor for every draft source (case, "Propose rule", reopened draft); it
 * produces the same draft object, which goes through the same validator.
 */
import type { CategoryId } from '../domain/categories';
import { isCategoryId } from '../domain/categories';
import { aliasPlainEnglish, categoryPlainEnglish, exclusionsFor, merchantNameFor as domainMerchantNameFor, policyPlainEnglish } from '../domain/knowledge/plainEnglish';
import type { RuleDraft, RuleType, RuleVersion } from '../domain/knowledge/schema';
import { aliasCoversLabel } from '../domain/knowledge/resolve';
import { canonicalMerchantId, normalizeLabel } from '../domain/normalize';
import { effectiveFields } from '../domain/capture/fields';
import type { EvidenceRef } from '../domain/primitives';
import type { WorkspaceSnapshot } from '../persistence/repository';

export interface DraftForm {
  type: RuleType;
  accountId: string;
  observedLabel: string;
  merchantName: string;
  categoryId: CategoryId | '';
  days: string;
  /** Merchant names only: also match the label with a different store number at the end (brief §25 D). */
  ignoreStoreNumber: boolean;
}

export const EMPTY_FORM: DraftForm = { type: 'merchant_alias', accountId: '', observedLabel: '', merchantName: '', categoryId: '', days: '3', ignoreStoreNumber: false };

const WILDCARD_OR_REGEX = /[*%?_.^$+()[\]{}|\\]/;

export function formFromDraft(d: RuleDraft | RuleVersion, s: WorkspaceSnapshot): DraftForm {
  if (d.type === 'merchant_alias') {
    return {
      ...EMPTY_FORM,
      type: d.type,
      accountId: d.scope.accountId ?? '',
      observedLabel: d.condition.observedLabel,
      merchantName: d.action.canonicalMerchantName,
      ignoreStoreNumber: d.condition.match === 'exact_ignoring_store_number',
    };
  }
  if (d.type === 'category_preference') {
    const name = merchantNameFor(s, d.condition.canonicalMerchantId) ?? d.condition.canonicalMerchantId.replace(/^m:/, '');
    return { ...EMPTY_FORM, type: d.type, merchantName: name, categoryId: d.action.suggestCategoryId };
  }
  return { ...EMPTY_FORM, type: d.type, days: String(d.action.postingLagMaxDays) };
}

/** Merchant display name for a canonical ID, from receipts in the workspace. */
export function merchantNameFor(s: WorkspaceSnapshot, merchantId: string): string | null {
  return domainMerchantNameFor(s.receipts, merchantId);
}

/** Known merchants (from receipts), for the category preference select. */
export function knownMerchants(s: WorkspaceSnapshot): string[] {
  const names = new Map<string, string>();
  for (const r of s.receipts) {
    const m = effectiveFields(r).merchant;
    if (m !== null && r.disposition === 'active' && !names.has(canonicalMerchantId(m))) names.set(canonicalMerchantId(m), m);
  }
  return [...names.values()].sort();
}

function evidenceFor(s: WorkspaceSnapshot, form: DraftForm, label: string): EvidenceRef[] {
  if (form.type === 'merchant_alias') {
    const condition = { observedLabel: label, match: form.ignoreStoreNumber ? ('exact_ignoring_store_number' as const) : ('exact' as const) };
    return s.transactions
      .filter((t) => t.accountId === form.accountId && t.normalizedLabel !== '' && aliasCoversLabel(condition, t.normalizedLabel))
      .slice(0, 10)
      .map((t) => ({ kind: 'transaction' as const, ref: t.id }));
  }
  if (form.type === 'category_preference') {
    const id = canonicalMerchantId(form.merchantName);
    return s.receipts
      .filter((r) => {
        const m = effectiveFields(r).merchant;
        return m !== null && canonicalMerchantId(m) === id;
      })
      .slice(0, 10)
      .map((r) => ({ kind: 'receipt' as const, ref: r.id }));
  }
  return [];
}

export function sameForm(a: DraftForm, b: DraftForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Builds draft content. `seed` keeps the evidence from the originating case
 * while the form still says what the case said. Returns raw values where the
 * input is invalid, so the validator reports the problem instead of hiding it.
 */
export function draftFromForm(s: WorkspaceSnapshot, form: DraftForm, seed: { form: DraftForm; evidence: EvidenceRef[] } | null): unknown {
  const accountLabel = s.transactions.find((t) => t.accountId === form.accountId)?.accountLabel ?? null;
  if (form.type === 'merchant_alias') {
    const raw = form.observedLabel.trim();
    const label = WILDCARD_OR_REGEX.test(raw) ? raw : normalizeLabel(raw);
    const merchant = form.merchantName.trim();
    const match = form.ignoreStoreNumber ? 'exact_ignoring_store_number' : 'exact';
    const evidence = seed && sameForm(seed.form, form) ? seed.evidence : evidenceFor(s, form, label);
    return {
      type: 'merchant_alias',
      scope: { accountId: form.accountId === '' ? null : form.accountId },
      condition: { observedLabel: label, match },
      action: { canonicalMerchantId: canonicalMerchantId(merchant), canonicalMerchantName: merchant },
      plainEnglish: aliasPlainEnglish(label || '…', accountLabel, merchant || '…', match),
      exclusions: exclusionsFor('merchant_alias', match),
      evidenceRefs: evidence,
    };
  }
  if (form.type === 'category_preference') {
    const merchant = form.merchantName.trim();
    const evidence = seed && sameForm(seed.form, form) ? seed.evidence : evidenceFor(s, form, '');
    return {
      type: 'category_preference',
      scope: { workspace: true },
      condition: { canonicalMerchantId: canonicalMerchantId(merchant) },
      action: { suggestCategoryId: form.categoryId === '' ? null : form.categoryId },
      plainEnglish: isCategoryId(form.categoryId) ? categoryPlainEnglish(merchant || '…', form.categoryId) : 'Choose a category.',
      exclusions: exclusionsFor('category_preference'),
      evidenceRefs: evidence,
    };
  }
  const days = /^\d{1,3}$/.test(form.days.trim()) ? Number(form.days.trim()) : form.days;
  return {
    type: 'posting_window',
    scope: { workspace: true },
    condition: {},
    action: { postingLagMaxDays: days },
    plainEnglish: typeof days === 'number' ? policyPlainEnglish(days) : 'Enter a number of days.',
    exclusions: exclusionsFor('posting_window'),
    evidenceRefs: [],
  };
}
