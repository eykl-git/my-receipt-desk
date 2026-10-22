/**
 * Knowledge-gap discovery (brief §25 A, task 3.6). Deterministic pattern
 * detection over the current state, not machine learning: it groups pending
 * receipts that are blocked only because a near-candidate card label is not a
 * known name, keyed by (card account, normalised label, receipt merchant).
 *
 * It writes nothing and never drafts a rule. Its only action is to open the
 * lowest-ID receipt of a gap, because a rule needs a human-confirmed case as
 * evidence ("Correct once"). "Would become ready" comes from a real
 * `previewImpact` of the hypothetical alias, which is itself read-only.
 */
import { effectiveFields } from '../capture/fields';
import type { CaseView } from '../matching/caseView';
import { canonicalMerchantId } from '../normalize';
import { LOCAL_OWNER } from '../primitives';
import type { StatementTransaction } from '../schemas';
import type { WorkspaceView } from '../views';
import { aliasDraft } from './prefill';
import { previewImpact, type WorkspaceState } from './preview';
import { isGenericLabel } from './safety';
import type { RuleVersion } from './schema';
import { validateDraft } from './validate';

export interface KnowledgeGap {
  accountId: string;
  accountLabel: string;
  /** Normalised card label, exactly as an alias would store it. */
  observedLabel: string;
  merchantId: string;
  merchantName: string;
  /** Pending receipts blocked only by this unknown label, sorted. */
  receiptIds: string[];
  /** Receipts that a scoped alias would make ready now (from a real preview). */
  wouldBecomeReady: string[];
  /** Active manual confirmations of this label for this merchant ("Confirm this case only"). */
  confirmedTimes: number;
  /** The case the "Review" action opens (lowest receipt ID). */
  reviewReceiptId: string;
}

/** Pending only because the card label is not a known name (unmatched, near candidates only, no flags). */
export function isUnknownLabelCase(c: CaseView): boolean {
  const p = c.proposal;
  return (
    c.group === 'needs_decision' &&
    p !== null &&
    p.outcome === 'unmatched' &&
    p.flags.length === 0 &&
    p.nearCandidateIds.length > 0 &&
    p.heldIds.length === 0
  );
}

/** Placeholder identity for the hypothetical alias; it is never stored and the counter never allocates 0000. */
const HYPOTHETICAL_ID = 'K-ALIAS-0000';
const HYPOTHETICAL_AT = '2000-01-01T00:00:00.000Z';

export function discoverKnowledgeGaps(state: WorkspaceState, view: WorkspaceView): KnowledgeGap[] {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const groups = new Map<string, { t: StatementTransaction; merchantName: string; merchantId: string; receiptIds: Set<string> }>();

  for (const c of view.cases) {
    if (!isUnknownLabelCase(c)) continue;
    const receipt = state.receipts.find((r) => r.id === c.receiptId);
    const merchantName = receipt ? effectiveFields(receipt).merchant : null;
    if (!receipt || merchantName === null) continue;
    const merchantId = canonicalMerchantId(merchantName);
    for (const id of c.proposal!.nearCandidateIds) {
      const t = txById.get(id);
      if (!t || isGenericLabel(t.normalizedLabel)) continue;
      const key = JSON.stringify([t.accountId, t.normalizedLabel, merchantId]);
      const g = groups.get(key) ?? { t, merchantName, merchantId, receiptIds: new Set<string>() };
      g.receiptIds.add(c.receiptId);
      groups.set(key, g);
    }
  }

  const gaps: KnowledgeGap[] = [];
  for (const g of groups.values()) {
    const receiptIds = [...g.receiptIds].sort();
    const evidence = [
      ...receiptIds.map((ref) => ({ kind: 'receipt' as const, ref })),
      ...state.transactions
        .filter((t) => t.accountId === g.t.accountId && t.normalizedLabel === g.t.normalizedLabel)
        .map((t) => ({ kind: 'transaction' as const, ref: t.id })),
    ].slice(0, 50);
    const draft = aliasDraft(g.t, g.merchantName, evidence);
    const check = validateDraft(draft, {
      receipts: state.receipts,
      transactions: state.transactions,
      payables: state.payables,
      activeRules: view.activeRules,
      ruleHeads: state.ruleHeads,
    });
    // A label that could never become a safe alias is not offered as a gap.
    if (check.errors.some((f) => f.code === 'OVERBROAD' || f.code === 'ALIAS_CYCLE')) continue;

    const hypothetical = { ...draft, ruleId: HYPOTHETICAL_ID, version: 1, ownerId: LOCAL_OWNER, createdAt: HYPOTHETICAL_AT } as RuleVersion;
    const preview = previewImpact(state, { kind: 'activate', version: hypothetical });
    const wouldBecomeReady = preview.pendingChanges
      .filter((p) => p.before.group !== 'ready' && p.after.group === 'ready')
      .map((p) => p.caseId)
      .sort();

    const confirmedTimes = state.matches.filter((m) => {
      if (m.status !== 'active' || m.method !== 'manual_resolution' || m.subject.kind !== 'receipt') return false;
      const t = txById.get(m.transactionId);
      const r = state.receipts.find((x) => x.id === m.subject.id);
      const name = r ? effectiveFields(r).merchant : null;
      return (
        t !== undefined &&
        t.accountId === g.t.accountId &&
        t.normalizedLabel === g.t.normalizedLabel &&
        name !== null &&
        canonicalMerchantId(name) === g.merchantId
      );
    }).length;

    gaps.push({
      accountId: g.t.accountId,
      accountLabel: g.t.accountLabel,
      observedLabel: g.t.normalizedLabel,
      merchantId: g.merchantId,
      merchantName: g.merchantName,
      receiptIds,
      wouldBecomeReady,
      confirmedTimes,
      reviewReceiptId: receiptIds[0]!,
    });
  }
  return gaps.sort(
    (a, b) =>
      b.wouldBecomeReady.length - a.wouldBecomeReady.length ||
      (a.observedLabel < b.observedLabel ? -1 : a.observedLabel > b.observedLabel ? 1 : 0) ||
      (a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : 0) ||
      (a.merchantId < b.merchantId ? -1 : a.merchantId > b.merchantId ? 1 : 0),
  );
}

/** Card text (brief §25 A). Counts are digits, as in the brief's example. */
export function gapText(g: KnowledgeGap): string {
  const n = g.receiptIds.length;
  const base = `${n} receipt${n === 1 ? ' is' : 's are'} waiting on one unknown card name: “${g.observedLabel}” (${g.accountLabel}) for ${g.merchantName}. Check one to teach it.`;
  return g.confirmedTimes > 0 ? `${base} You've confirmed it ${g.confirmedTimes} time${g.confirmedTimes === 1 ? '' : 's'}.` : base;
}
