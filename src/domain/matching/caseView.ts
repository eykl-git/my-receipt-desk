/**
 * Case derivation with separate status dimensions (S7, design §5). There is no
 * single overloaded status: capture, category, reconciliation and ledger are
 * independent, plus a set of review flags. A confirmed category does not prove
 * a match and a confirmed match does not prove the category.
 */
import { captureStatus } from '../capture/fields';
import { deriveCategory, type DerivedCategory } from '../knowledge/resolve';
import type { RuleVersion } from '../knowledge/schema';
import type { CaptureStatus, LedgerCaseStatus, ReconciliationStatus, ReviewFlag } from '../primitives';
import type { ConfirmedMatch, LedgerEntry, MatchProposal, Receipt, StatementTransaction } from '../schemas';
import { byId } from './helpers';
import type { EvaluationResult } from './types';

export type CaseGroup = 'ready' | 'needs_decision' | 'recorded';

export interface CaseView {
  receiptId: string;
  capture: CaptureStatus;
  category: DerivedCategory;
  reconciliation: ReconciliationStatus;
  ledger: LedgerCaseStatus;
  flags: ReviewFlag[];
  /** null for receipts set aside as duplicates (listed in a separate footnote). */
  group: CaseGroup | null;
  explanation: string;
  proposal: MatchProposal | null;
  matchId: string | null;
  ledgerEntryId: string | null;
  voidedEntryIds: string[];
}

export function deriveCaseView(
  receipt: Receipt,
  evaluation: EvaluationResult,
  matches: readonly ConfirmedMatch[],
  ledger: readonly LedgerEntry[],
  activeRules: readonly RuleVersion[],
): CaseView {
  const capture = captureStatus(receipt);
  const category = deriveCategory(receipt, activeRules);
  const match = matches.find((m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === receipt.id);
  const withReceipt = ledger.filter((e) => e.evidence.receiptIds.includes(receipt.id));
  const recordedEntry = withReceipt.find((e) => e.status === 'recorded');
  const voidedEntryIds = withReceipt.filter((e) => e.status === 'voided').map((e) => e.id).sort();
  const ledgerStatus: LedgerCaseStatus = recordedEntry ? 'recorded' : voidedEntryIds.length > 0 ? 'voided' : 'draft';

  if (receipt.disposition === 'set_aside_duplicate') {
    return {
      receiptId: receipt.id,
      capture,
      category,
      reconciliation: 'not_applicable',
      ledger: ledgerStatus,
      flags: [],
      group: null,
      explanation: 'Set aside as a duplicate (not recorded).',
      proposal: null,
      matchId: null,
      ledgerEntryId: recordedEntry?.id ?? null,
      voidedEntryIds,
    };
  }

  const proposal = match ? null : (evaluation.proposals.get(receipt.id) ?? null);
  const reconciliation: ReconciliationStatus = match
    ? 'confirmed'
    : proposal === null || proposal.outcome === 'blocked'
      ? 'unmatched'
      : proposal.outcome;
  const flags = proposal ? [...proposal.flags] : [];

  let group: CaseGroup;
  if (ledgerStatus === 'recorded') group = 'recorded';
  else if (reconciliation === 'unique_candidate' && capture === 'validated' && flags.length === 0) group = 'ready';
  else group = 'needs_decision';

  const explanation =
    group === 'recorded' && recordedEntry
      ? `Recorded as ${recordedEntry.id}.`
      : (proposal?.explanation ?? 'Not evaluated yet.');

  return {
    receiptId: receipt.id,
    capture,
    category,
    reconciliation,
    ledger: ledgerStatus,
    flags,
    group,
    explanation,
    proposal,
    matchId: match?.id ?? null,
    ledgerEntryId: recordedEntry?.id ?? null,
    voidedEntryIds,
  };
}

export interface TransactionCase {
  transactionId: string;
  flags: ReviewFlag[];
  explanation: string;
}

/** Card transactions needing attention (§5.1): no receipt yet, not supported, possible duplicate. */
export function deriveTransactionCases(
  evaluation: EvaluationResult,
  transactions: readonly StatementTransaction[],
): TransactionCase[] {
  return [...transactions]
    .sort(byId)
    .flatMap((t) => {
      const f = evaluation.transactionFlags.get(t.id);
      return f ? [{ transactionId: t.id, flags: [...f.flags], explanation: f.explanation }] : [];
    });
}

export interface GroupedCases {
  ready: CaseView[];
  needs_decision: CaseView[];
  recorded: CaseView[];
  /** "Set aside as duplicates (not recorded)" footnote. */
  setAside: CaseView[];
}

export function groupCases(views: readonly CaseView[]): GroupedCases {
  const out: GroupedCases = { ready: [], needs_decision: [], recorded: [], setAside: [] };
  for (const v of [...views].sort((a, b) => (a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0))) {
    if (v.group === null) out.setAside.push(v);
    else out[v.group].push(v);
  }
  return out;
}
