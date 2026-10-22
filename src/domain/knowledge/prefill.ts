/**
 * "Propose reusable knowledge" pre-fill from a resolved case (design §7.2 a,
 * review-3 amendment N5). The draft is generalised no further than the case's
 * evidence: one exact observed label, in one card account, to the receipt's
 * canonical merchant.
 */
import { effectiveFields } from '../capture/fields';
import type { CategoryId } from '../categories';
import { canonicalMerchantId, normalizeLabel } from '../normalize';
import type { EvidenceRef } from '../primitives';
import type { ConfirmedMatch, MatchProposal, Receipt, StatementTransaction } from '../schemas';
import { aliasesOf, aliasKey } from './resolve';
import { aliasPlainEnglish, categoryPlainEnglish, exclusionsFor } from './plainEnglish';
import type { RuleDraft, RuleVersion } from './schema';

export type PrefillResult =
  | { kind: 'alias'; draft: RuleDraft }
  | {
      kind: 'choose_label';
      merchantName: string;
      options: Array<{ observedLabel: string; accountId: string; accountLabel: string; draft: RuleDraft }>;
    }
  | { kind: 'category_only'; merchantId: string; merchantName: string }
  | { kind: 'form'; merchantName: string | null };

export interface PrefillInput {
  receipt: Receipt;
  /** Current proposal for a pending receipt (null when recorded). */
  proposal: MatchProposal | null;
  matches: readonly ConfirmedMatch[];
  transactions: readonly StatementTransaction[];
  activeRules: readonly RuleVersion[];
}

export function aliasDraft(
  t: Pick<StatementTransaction, 'normalizedLabel' | 'accountId' | 'accountLabel'>,
  merchantName: string,
  evidenceRefs: EvidenceRef[],
): RuleDraft {
  return {
    type: 'merchant_alias',
    scope: { accountId: t.accountId },
    condition: { observedLabel: t.normalizedLabel, match: 'exact' },
    action: { canonicalMerchantId: canonicalMerchantId(merchantName), canonicalMerchantName: merchantName },
    plainEnglish: aliasPlainEnglish(t.normalizedLabel, t.accountLabel, merchantName),
    exclusions: exclusionsFor('merchant_alias'),
    evidenceRefs,
  };
}

export function categoryDraft(merchantName: string, categoryId: CategoryId, evidenceRefs: EvidenceRef[]): RuleDraft {
  return {
    type: 'category_preference',
    scope: { workspace: true },
    condition: { canonicalMerchantId: canonicalMerchantId(merchantName) },
    action: { suggestCategoryId: categoryId },
    plainEnglish: categoryPlainEnglish(merchantName, categoryId),
    exclusions: exclusionsFor('category_preference'),
    evidenceRefs,
  };
}

/** True when the label already identifies the merchant (same name or an active in-scope alias). */
function alreadyKnown(t: StatementTransaction, merchantName: string, activeRules: readonly RuleVersion[]): boolean {
  const norm = normalizeLabel(merchantName);
  if (norm !== '' && t.normalizedLabel === norm) return true;
  const id = canonicalMerchantId(merchantName);
  return aliasesOf(activeRules).some(
    (a) =>
      a.scope.accountId !== null &&
      aliasKey(a.scope.accountId, a.condition.observedLabel) === aliasKey(t.accountId, t.normalizedLabel) &&
      a.action.canonicalMerchantId === id,
  );
}

export function prefillDraftFromCase(input: PrefillInput): PrefillResult {
  const { receipt, proposal, matches, transactions, activeRules } = input;
  const merchantName = effectiveFields(receipt).merchant;
  if (merchantName === null) return { kind: 'form', merchantName: null };
  const merchantId = canonicalMerchantId(merchantName);
  const receiptEv: EvidenceRef = { kind: 'receipt', ref: receipt.id };

  // Matched: label and account come from the matched transaction.
  const match = matches.find((m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === receipt.id);
  if (match) {
    const t = transactions.find((x) => x.id === match.transactionId);
    if (!t) return { kind: 'form', merchantName };
    if (alreadyKnown(t, merchantName, activeRules)) return { kind: 'category_only', merchantId, merchantName };
    return {
      kind: 'alias',
      draft: aliasDraft(t, merchantName, [receiptEv, { kind: 'transaction', ref: t.id }, { kind: 'match', ref: match.id }]),
    };
  }

  // Pending: from near candidates (unrecognised labels). N5: if every near
  // candidate already carries the merchant's name, only a category draft applies.
  const near = (proposal?.nearCandidateIds ?? [])
    .map((id) => transactions.find((t) => t.id === id))
    .filter((t): t is StatementTransaction => t !== undefined);
  if (near.length === 0) return { kind: 'form', merchantName };
  const unknown = near.filter((t) => !alreadyKnown(t, merchantName, activeRules));
  if (unknown.length === 0) return { kind: 'category_only', merchantId, merchantName };

  const groups = new Map<string, StatementTransaction[]>();
  for (const t of unknown) {
    const k = aliasKey(t.accountId, t.normalizedLabel);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  const options = [...groups.values()]
    .map((ts) => {
      const t = ts[0]!;
      return {
        observedLabel: t.normalizedLabel,
        accountId: t.accountId,
        accountLabel: t.accountLabel,
        draft: aliasDraft(t, merchantName, [receiptEv, ...ts.map((x) => ({ kind: 'transaction' as const, ref: x.id }))]),
      };
    })
    .sort((x, y) => (x.observedLabel + x.accountId < y.observedLabel + y.accountId ? -1 : 1));
  if (options.length === 1) return { kind: 'alias', draft: options[0]!.draft };
  return { kind: 'choose_label', merchantName, options };
}
