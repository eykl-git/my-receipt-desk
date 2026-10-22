/**
 * Test builders with validated defaults. Every builder runs the record through
 * its zod schema, so tests never use shapes the app would reject.
 */
import { normalizeLabel, accountId as toAccountId, canonicalMerchantId } from '../src/domain/normalize';
import { ledgerId as toLedgerId, matchId as toMatchId, sourceRowId, transactionId } from '../src/domain/ids';
import {
  ConfirmedMatchSchema,
  LedgerEntrySchema,
  ReceiptSchema,
  ReviewDecisionSchema,
  RuleHeadSchema,
  RuleVersionSchema,
  StatementTransactionSchema,
  type ConfirmedMatch,
  type FieldName,
  type LedgerEntry,
  type Receipt,
  type ReviewDecision,
  type RuleHead,
  type RuleVersion,
  type StatementTransaction,
} from '../src/domain/schemas';
import type { CategoryId } from '../src/domain/categories';
import type { IsoDate } from '../src/domain/dates';
import type { EvaluationInput } from '../src/domain/matching/types';
import { aliasPlainEnglish, categoryPlainEnglish, exclusionsFor, policyPlainEnglish } from '../src/domain/knowledge/plainEnglish';

export const T0 = '2026-03-31T09:00:00.000Z';
export const DEMO_ACCOUNT = 'Demo Card ••1234';
export const DEMO_ACCOUNT_ID = toAccountId(DEMO_ACCOUNT);

/** Deterministic 64-hex "SHA-256" for a named test file. */
export function fakeSha(tag: string): string {
  // Eight seeded FNV-1a hashes → 64 hex chars; distinct tags differ in the first 12.
  let hex = '';
  for (let seed = 0; seed < 8; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (const ch of `${seed}:${tag}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
    hex += h.toString(16).padStart(8, '0');
  }
  return hex;
}

const iso = (s: string) => s as IsoDate;

export interface ReceiptOpts {
  id: string;
  merchant: string | null;
  date: string | null;
  amount: number | null;
  currency?: string | null;
  doc?: string;
  /** Fields whose original value is unclear (value null, raw kept). */
  unclear?: Partial<Record<FieldName, string>>;
  adapter?: 'demo-fixture' | 'manual';
  /** For manual receipts: whether the user confirmed the fields. */
  confirmed?: boolean;
  printedText?: string | null;
  category?: { categoryId: CategoryId | null; status: 'unassigned' | 'suggested' | 'confirmed' };
  disposition?: 'active' | 'set_aside_duplicate';
  updatedAt?: string;
}

export function receipt(o: ReceiptOpts): Receipt {
  const kind = o.adapter ?? 'demo-fixture';
  const provenance = { adapterId: kind === 'demo-fixture' ? 'demo-fixture' : 'manual', kind } as const;
  const confirmedAt = o.confirmed ? T0 : null;
  const field = <T>(name: FieldName, value: T | null) => {
    const unclearRaw = o.unclear?.[name];
    return {
      original: {
        value: unclearRaw !== undefined ? null : value,
        raw: unclearRaw !== undefined ? unclearRaw : value === null ? null : String(value),
        clarity: unclearRaw !== undefined ? ('unclear' as const) : value === null ? ('missing' as const) : ('clear' as const),
        provenance,
      },
      correction: null,
      confirmedAt,
    };
  };
  const currency = o.currency === undefined ? 'HKD' : o.currency;
  return ReceiptSchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    id: o.id,
    sourceDocumentId: o.doc ?? `DOC-${o.id}`,
    adapter: { id: provenance.adapterId, kind },
    fields: {
      merchant: field('merchant', o.merchant),
      date: field('date', o.date === null ? null : iso(o.date)),
      amountMinor: field('amountMinor', o.amount),
      currency: field('currency', currency),
    },
    printedText: o.printedText ?? null,
    canonicalMerchantId: o.merchant ? canonicalMerchantId(o.merchant) : null,
    disposition: o.disposition ?? 'active',
    category: o.category ?? { categoryId: null, status: 'unassigned' },
    createdAt: T0,
    updatedAt: o.updatedAt ?? T0,
  });
}

export interface TxOpts {
  ref: string | null;
  label: string;
  posting: string;
  txnDate?: string | null;
  amount: number;
  currency?: string;
  direction?: 'debit' | 'credit';
  account?: string;
  file?: string;
  row: number;
  intake?: StatementTransaction['intake'];
  duplicateSuspected?: boolean;
  duplicateOf?: string | null;
  duplicateResolution?: 'kept' | null;
}

export function tx(o: TxOpts): StatementTransaction {
  const sha = fakeSha(o.file ?? 'batch-1.csv');
  const account = o.account ?? DEMO_ACCOUNT;
  const currency = o.currency ?? 'HKD';
  const direction = o.direction ?? 'debit';
  return StatementTransactionSchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    id: transactionId(sha, o.row),
    sourceDocumentId: `DOC-${(o.file ?? 'batch-1.csv').replace(/[^A-Za-z0-9]/g, '')}`,
    sourceRowId: sourceRowId(sha, o.row),
    rowNumber: o.row,
    reference: o.ref,
    accountId: toAccountId(account),
    accountLabel: account,
    rawLabel: o.label,
    normalizedLabel: normalizeLabel(o.label),
    transactionDate: o.txnDate === undefined ? null : o.txnDate,
    postingDate: o.posting,
    currency,
    direction,
    amountMinor: o.amount,
    intake: o.intake ?? (currency !== 'HKD' ? 'quarantined_currency' : direction === 'credit' ? 'credit_not_supported' : 'available'),
    duplicateSuspected: o.duplicateSuspected ?? false,
    duplicateOf: o.duplicateOf ?? null,
    duplicateResolution: o.duplicateResolution ?? null,
    rawCells: [],
  });
}

interface RuleMeta {
  ruleId?: string;
  version?: number;
  approved?: boolean;
}

function meta(m: RuleMeta, fallbackId: string) {
  const approved = m.approved ?? true;
  return {
    ruleId: m.ruleId ?? fallbackId,
    version: m.version ?? 1,
    ownerId: 'local-owner' as const,
    createdAt: T0,
    ...(approved ? { approvedBy: 'local-owner' as const, approvedAt: T0 } : {}),
  };
}

export function aliasRule(
  o: RuleMeta & { label?: string; accountId?: string | null; merchant?: string; merchantId?: string; match?: 'exact' | 'exact_ignoring_store_number' } = {},
): RuleVersion {
  const label = o.label ?? 'MC COFFEE HK';
  const merchant = o.merchant ?? 'Morning Cup';
  const match = o.match ?? 'exact';
  return RuleVersionSchema.parse({
    type: 'merchant_alias',
    scope: { accountId: o.accountId === undefined ? DEMO_ACCOUNT_ID : o.accountId },
    condition: { observedLabel: label, match },
    action: { canonicalMerchantId: o.merchantId ?? canonicalMerchantId(merchant), canonicalMerchantName: merchant },
    plainEnglish: aliasPlainEnglish(label, DEMO_ACCOUNT, merchant, match),
    exclusions: exclusionsFor('merchant_alias', match),
    evidenceRefs: [{ kind: 'receipt', ref: 'R-102' }],
    ...meta(o, 'K-ALIAS-0001'),
  });
}

export function categoryRule(o: RuleMeta & { merchant?: string; category?: CategoryId } = {}): RuleVersion {
  const merchant = o.merchant ?? 'Morning Cup';
  const category = o.category ?? 'dining';
  return RuleVersionSchema.parse({
    type: 'category_preference',
    scope: { workspace: true },
    condition: { canonicalMerchantId: canonicalMerchantId(merchant) },
    action: { suggestCategoryId: category },
    plainEnglish: categoryPlainEnglish(merchant, category),
    exclusions: exclusionsFor('category_preference'),
    evidenceRefs: [{ kind: 'receipt', ref: 'R-102' }],
    ...meta(o, 'K-CAT-0001'),
  });
}

export function policyRule(o: RuleMeta & { days?: number } = {}): RuleVersion {
  const days = o.days ?? 3;
  return RuleVersionSchema.parse({
    type: 'posting_window',
    scope: { workspace: true },
    condition: {},
    action: { postingLagMaxDays: days },
    plainEnglish: policyPlainEnglish(days),
    exclusions: exclusionsFor('posting_window'),
    evidenceRefs: [],
    ...meta(o, 'K-POLICY-0001'),
  });
}

export function head(v: RuleVersion, status: RuleHead['status'] = 'active'): RuleHead {
  return RuleHeadSchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    ruleId: v.ruleId,
    type: v.type,
    status,
    currentVersion: v.version,
    activeVersion: status === 'active' ? v.version : null,
    lastApprovedVersion: status === 'draft_only' ? null : v.version,
    draftVersion: status === 'draft_only' ? v.version : null,
    updatedAt: T0,
  });
}

/** A confirmed match and its ledger entry, as a commit would write them. */
export function recorded(o: {
  n: number;
  receipt: Receipt;
  transaction: StatementTransaction;
  method?: 'confirmed_proposal' | 'manual_resolution';
  ruleRefs?: Array<{ ruleId: string; version: number }>;
  categoryId?: CategoryId | null;
}): { match: ConfirmedMatch; entry: LedgerEntry } {
  const mId = toMatchId(o.n);
  const lId = toLedgerId(o.n);
  const method = o.method ?? 'manual_resolution';
  const ruleRefs = o.ruleRefs ?? [];
  const match = ConfirmedMatchSchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    id: mId,
    subject: { kind: 'receipt', id: o.receipt.id },
    transactionId: o.transaction.id,
    activeTxnKey: o.transaction.id,
    activeSubjectKey: `receipt:${o.receipt.id}`,
    status: 'active',
    method,
    reason: method === 'manual_resolution' ? 'Receipt and card transaction show the same amount and date' : null,
    proposalSnapshot: { candidateIds: [o.transaction.id], ruleRefs, policyRef: { ruleId: 'P-BASE', version: 0 }, engineVersion: 'match-engine/1', trace: [] },
    ledgerEntryId: lId,
    confirmedAt: T0,
    confirmedBy: 'local-owner',
  });
  const entry = LedgerEntrySchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    id: lId,
    origin: 'receipt_match',
    identityKey: o.transaction.id,
    activeIdentityKey: o.transaction.id,
    status: 'recorded',
    expenseDate: o.receipt.fields.date.original.value,
    merchantName: o.receipt.fields.merchant.original.value,
    canonicalMerchantId: o.receipt.canonicalMerchantId,
    amountMinor: o.transaction.amountMinor,
    currency: o.transaction.currency,
    category: { categoryId: o.categoryId ?? null, status: o.categoryId ? 'confirmed' : 'unassigned' },
    evidence: {
      receiptIds: [o.receipt.id],
      transactionIds: [o.transaction.id],
      payableIds: [],
      sourceDocumentIds: [o.receipt.sourceDocumentId],
      matchIds: [mId],
    },
    ruleRefs,
    recordedAt: T0,
    updatedAt: T0,
  });
  return { match, entry };
}

export function distinctDecision(n: number, a: string, b: string): ReviewDecision {
  return ReviewDecisionSchema.parse({
    schemaVersion: 1,
    workspaceId: 'demo',
    id: `D-${String(n).padStart(4, '0')}`,
    kind: 'duplicate_resolution',
    subjectIds: [a, b],
    choice: 'distinct',
    reason: null,
    at: T0,
  });
}

export function input(parts: Partial<EvaluationInput>): EvaluationInput {
  return {
    receipts: parts.receipts ?? [],
    transactions: parts.transactions ?? [],
    matches: parts.matches ?? [],
    ledgerEntries: parts.ledgerEntries ?? [],
    activeRules: parts.activeRules ?? [],
    decisions: parts.decisions ?? [],
    ...(parts.workspaceCurrency ? { workspaceCurrency: parts.workspaceCurrency } : {}),
  };
}

/** Recursively freeze test inputs so any mutation by the engine throws. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}
