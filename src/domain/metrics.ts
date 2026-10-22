/**
 * Counters derived from state only (S13, design §14). Nothing is stored or
 * hard-coded. "Newly ready because of a rule" compares the current evaluation
 * with an actual baseline-only evaluation (no approved rules).
 */
import type { WorkspaceState } from './knowledge/preview';
import type { WorkspaceView } from './views';

export interface Metrics {
  /** The workspace currency every total is in (REQ-20). */
  currency: string;
  uniqueReceipts: number;
  ready: number;
  needsDecision: number;
  recorded: number;
  receiptsWithConfirmedMatches: number;
  linkedTransactions: number;
  cardRowsNeedingAttention: number;
  activeRules: number;
  /** Pending case IDs ready now but not under baseline-only rules. */
  newlyReady: string[];
  rulesUsedInRecorded: Array<{ ruleId: string; ledgerEntryIds: string[]; matchIds: string[] }>;
  safeProposals: { x: number; y: number };
  recordedPaidMinor: number;
  cardSpendingWithoutRecordMinor: number;
  unpaidInvoicesMinor: number;
  /** Card rows in other currencies, listed by currency and never converted or added in. */
  notIncluded: Array<{ currency: string; totalMinor: number }>;
}

export function deriveMetrics(state: WorkspaceState, current: WorkspaceView, baseline: WorkspaceView): Metrics {
  const currency = state.currency ?? 'HKD';
  const active = current.cases.filter((c) => c.group !== null);
  const activeMatches = state.matches.filter((m) => m.status === 'active');
  const receiptMatches = activeMatches.filter((m) => m.subject.kind === 'receipt');
  const activeReceiptIds = new Set(active.map((c) => c.receiptId));
  const recordedEntries = state.ledger.filter((e) => e.status === 'recorded');
  const recordedIdentities = new Set(recordedEntries.map((e) => e.identityKey));
  const matchedTxns = new Set(activeMatches.map((m) => m.transactionId));

  const newlyReady = current.groups.ready
    .filter((c) => baseline.caseById.get(c.receiptId)?.group !== 'ready')
    .map((c) => c.receiptId);

  const usage = new Map<string, { ledger: Set<string>; matches: Set<string> }>();
  for (const e of recordedEntries) {
    for (const ref of e.ruleRefs) {
      const u = usage.get(ref.ruleId) ?? { ledger: new Set<string>(), matches: new Set<string>() };
      u.ledger.add(e.id);
      for (const m of e.evidence.matchIds) u.matches.add(m);
      usage.set(ref.ruleId, u);
    }
  }

  const other = new Map<string, number>();
  for (const t of state.transactions) {
    if (t.intake === 'quarantined_currency' && t.direction === 'debit') other.set(t.currency, (other.get(t.currency) ?? 0) + t.amountMinor);
  }

  return {
    currency,
    uniqueReceipts: active.length,
    ready: current.groups.ready.length,
    needsDecision: current.groups.needs_decision.length,
    recorded: current.groups.recorded.length,
    receiptsWithConfirmedMatches: receiptMatches.filter((m) => activeReceiptIds.has(m.subject.id)).length,
    linkedTransactions: matchedTxns.size,
    cardRowsNeedingAttention: current.transactionCases.length,
    activeRules: state.ruleHeads.filter((h) => h.status === 'active').length,
    newlyReady,
    rulesUsedInRecorded: [...usage.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([ruleId, u]) => ({ ruleId, ledgerEntryIds: [...u.ledger].sort(), matchIds: [...u.matches].sort() })),
    safeProposals: {
      x: current.groups.ready.length + receiptMatches.filter((m) => m.method === 'confirmed_proposal' && activeReceiptIds.has(m.subject.id)).length,
      y: active.length,
    },
    recordedPaidMinor: recordedEntries.reduce((n, e) => n + e.amountMinor, 0),
    cardSpendingWithoutRecordMinor: state.transactions
      .filter((t) => t.intake === 'available' && t.direction === 'debit' && t.currency === currency && !matchedTxns.has(t.id) && !recordedIdentities.has(t.id))
      .reduce((n, t) => n + t.amountMinor, 0),
    // Unpaid invoices in the workspace currency; others are never converted or added in.
    unpaidInvoicesMinor: state.payables.filter((p) => p.state === 'unpaid' && p.currency === currency).reduce((n, p) => n + p.amountMinor, 0),
    notIncluded: [...other.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, totalMinor]) => ({ currency, totalMinor })),
  };
}
