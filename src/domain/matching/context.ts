/**
 * Indexes built once per evaluation (design §6 step 5: currency|amount buckets
 * keep a 500 × 2,000 evaluation near-linear).
 */
import { detectDuplicatePurchases } from '../capture/duplicates';
import { aliasesOf, aliasKey, categoryPreferencesOf, policyFromRules, type EffectivePolicy } from '../knowledge/resolve';
import type { AliasRuleVersion } from '../knowledge/schema';
import { isGenericLabel } from '../knowledge/safety';
import type { ConfirmedMatch, LedgerEntry, StatementTransaction } from '../schemas';
import { storeNumberStem } from '../normalize';
import { byId, isHeldForDuplicateReview } from './helpers';
import type { EvaluationInput } from './types';

export type Identity =
  | { kind: 'exact' }
  | { kind: 'alias'; rule: AliasRuleVersion }
  | { kind: 'unrecognised' };

/** Default workspace currency (the demo and a new My files workspace). */
export const DEFAULT_CURRENCY = 'HKD';

export interface EvalContext {
  policy: EffectivePolicy;
  /** The only currency that can match in this workspace (S-1). */
  currency: string;
  activeMatches: ConfirmedMatch[];
  /** transactionId → subject ID of its active match. */
  matchedTxn: Map<string, string>;
  matchedReceipts: Set<string>;
  /** Transactions that are the identity of a recorded entry that already has a receipt or payable. */
  ledgerTaken: Map<string, LedgerEntry>;
  /** identityKey of every recorded (non-voided) entry. */
  recordedIdentities: Set<string>;
  /** account|label → active exact aliases. */
  aliasIndex: Map<string, AliasRuleVersion[]>;
  /** account|store-number stem → active "ignoring store number" aliases (brief §25 D). */
  stemIndex: Map<string, AliasRuleVersion[]>;
  conflictingAliasKeys: Set<string>;
  conflictingStemKeys: Set<string>;
  conflictingMerchants: Set<string>;
  duplicates: ReadonlyMap<string, readonly string[]>;
  transactions: StatementTransaction[];
  txById: Map<string, StatementTransaction>;
  /** currency|amount → free available debit transactions (held rows included). */
  buckets: Map<string, StatementTransaction[]>;
  /** normalisedLabel → free available debit transactions (held rows included). */
  byLabel: Map<string, StatementTransaction[]>;
  /** canonical merchant → alias versions targeting it. */
  aliasesByTarget: Map<string, AliasRuleVersion[]>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export const bucketKey = (currency: string, amountMinor: number): string => `${currency}|${amountMinor}`;

export function buildContext(input: EvaluationInput): EvalContext {
  const policy = policyFromRules(input.activeRules);
  const activeMatches = input.matches.filter((m) => m.status === 'active');
  const matchedTxn = new Map<string, string>();
  const matchedReceipts = new Set<string>();
  for (const m of activeMatches) {
    matchedTxn.set(m.transactionId, m.subject.id);
    if (m.subject.kind === 'receipt') matchedReceipts.add(m.subject.id);
  }

  const ledgerTaken = new Map<string, LedgerEntry>();
  const recordedIdentities = new Set<string>();
  for (const e of input.ledgerEntries) {
    if (e.status !== 'recorded') continue;
    recordedIdentities.add(e.identityKey);
    if (e.evidence.receiptIds.length > 0 || e.evidence.payableIds.length > 0) ledgerTaken.set(e.identityKey, e);
  }

  const aliasIndex = new Map<string, AliasRuleVersion[]>();
  const stemIndex = new Map<string, AliasRuleVersion[]>();
  const aliasesByTarget = new Map<string, AliasRuleVersion[]>();
  for (const a of aliasesOf(input.activeRules)) {
    if (a.scope.accountId === null) continue;
    if (a.condition.match === 'exact_ignoring_store_number') push(stemIndex, aliasKey(a.scope.accountId, storeNumberStem(a.condition.observedLabel)), a);
    else push(aliasIndex, aliasKey(a.scope.accountId, a.condition.observedLabel), a);
    push(aliasesByTarget, a.action.canonicalMerchantId, a);
  }
  // Two active aliases covering one label in one account are a conflict
  // (activation prevents CONFLICT and DUPLICATE, so this only arises from bad storage).
  const conflictingAliasKeys = new Set<string>();
  const conflictingStemKeys = new Set<string>();
  const conflictingMerchants = new Set<string>();
  for (const [key, list] of aliasIndex) {
    if (list.length > 1) {
      conflictingAliasKeys.add(key);
      for (const a of list) conflictingMerchants.add(a.action.canonicalMerchantId);
    }
  }
  const targets = (list: readonly AliasRuleVersion[]) => new Set(list.map((a) => a.action.canonicalMerchantId)).size;
  for (const [key, list] of stemIndex) {
    if (targets(list) > 1) {
      conflictingStemKeys.add(key);
      for (const a of list) conflictingMerchants.add(a.action.canonicalMerchantId);
    }
  }
  for (const list of aliasIndex.values()) {
    for (const a of list) {
      const stemKey = aliasKey(a.scope.accountId!, storeNumberStem(a.condition.observedLabel));
      const overlapping = stemIndex.get(stemKey) ?? [];
      if (targets([a, ...overlapping]) > 1) {
        conflictingAliasKeys.add(aliasKey(a.scope.accountId!, a.condition.observedLabel));
        conflictingStemKeys.add(stemKey);
        for (const b of [a, ...overlapping]) conflictingMerchants.add(b.action.canonicalMerchantId);
      }
    }
  }
  const prefsByMerchant = new Map<string, number>();
  for (const p of categoryPreferencesOf(input.activeRules)) {
    prefsByMerchant.set(p.condition.canonicalMerchantId, (prefsByMerchant.get(p.condition.canonicalMerchantId) ?? 0) + 1);
  }
  for (const [m, n] of prefsByMerchant) if (n > 1) conflictingMerchants.add(m);

  const transactions = [...input.transactions].sort(byId);
  const txById = new Map(transactions.map((t) => [t.id, t] as const));
  const buckets = new Map<string, StatementTransaction[]>();
  const byLabel = new Map<string, StatementTransaction[]>();
  for (const t of transactions) {
    if (t.intake !== 'available' || t.direction !== 'debit') continue;
    if (matchedTxn.has(t.id) || ledgerTaken.has(t.id)) continue;
    push(buckets, bucketKey(t.currency, t.amountMinor), t);
    push(byLabel, t.normalizedLabel, t);
  }

  return {
    policy,
    currency: input.workspaceCurrency ?? DEFAULT_CURRENCY,
    activeMatches,
    matchedTxn,
    matchedReceipts,
    ledgerTaken,
    recordedIdentities,
    aliasIndex,
    stemIndex,
    conflictingAliasKeys,
    conflictingStemKeys,
    conflictingMerchants,
    duplicates: detectDuplicatePurchases(input.receipts, input.matches, input.ledgerEntries, input.decisions),
    transactions,
    txById,
    buckets,
    byLabel,
    aliasesByTarget,
  };
}

/**
 * Merchant identity of a card transaction for a receipt (rule 3, §6 step 6).
 * Exact normalised label, or exactly one active alias in the transaction's
 * account that maps this label to the receipt's canonical merchant. Generic
 * processor labels never establish identity, and neither do empty normalised
 * labels: two different non-Latin or punctuation-only names both normalise to
 * '' and must not count as "same name".
 */
export function identityOf(
  ctx: EvalContext,
  t: StatementTransaction,
  merchantNorm: string,
  merchantId: string,
): Identity {
  if (t.normalizedLabel === '' || merchantNorm === '') return { kind: 'unrecognised' };
  if (isGenericLabel(t.normalizedLabel)) return { kind: 'unrecognised' };
  if (t.normalizedLabel === merchantNorm) return { kind: 'exact' };
  const exact = ctx.aliasIndex.get(aliasKey(t.accountId, t.normalizedLabel)) ?? [];
  if (exact.length > 1 || hasLabelConflict(ctx, t)) return { kind: 'unrecognised' };
  // An exact alias wins over a store-number alias with the same target.
  const rule = exact[0] ?? coveringAliases(ctx, t)[0];
  if (rule && rule.action.canonicalMerchantId === merchantId) return { kind: 'alias', rule };
  return { kind: 'unrecognised' };
}

/** Active aliases covering this card row's label in its account (exact, then store-number stem). */
export function coveringAliases(ctx: EvalContext, t: StatementTransaction): AliasRuleVersion[] {
  return [
    ...(ctx.aliasIndex.get(aliasKey(t.accountId, t.normalizedLabel)) ?? []),
    ...(ctx.stemIndex.get(aliasKey(t.accountId, storeNumberStem(t.normalizedLabel))) ?? []),
  ];
}

/** Two active rules disagree about this row's label (step 4). */
export function hasLabelConflict(ctx: EvalContext, t: StatementTransaction): boolean {
  return ctx.conflictingAliasKeys.has(aliasKey(t.accountId, t.normalizedLabel)) || ctx.conflictingStemKeys.has(aliasKey(t.accountId, storeNumberStem(t.normalizedLabel)));
}

export function isFreeCandidate(ctx: EvalContext, t: StatementTransaction): boolean {
  return (
    t.intake === 'available' &&
    t.direction === 'debit' &&
    !ctx.matchedTxn.has(t.id) &&
    !ctx.ledgerTaken.has(t.id) &&
    !isHeldForDuplicateReview(t)
  );
}
