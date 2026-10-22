/**
 * Impact preview (design §7.4): a pure before/after re-evaluation of the same
 * workspace state with the current active rules and with the rules after the
 * change. Nothing is written; recorded entries are only listed, never changed.
 */
import { deriveCaseView, type CaseGroup } from '../matching/caseView';
import { evaluateWorkspace } from '../matching/evaluate';
import { canonicalJson } from '../matching/fingerprint';
import type { EvaluationInput } from '../matching/types';
import type { CategoryId } from '../categories';
import type {
  ConfirmedMatch,
  LedgerEntry,
  Payable,
  Receipt,
  ReviewDecision,
  StatementTransaction,
} from '../schemas';
import { activeRulesFrom } from './resolve';
import { toDraftContent, type RuleDraft, type RuleHead, type RuleVersion } from './schema';

export interface WorkspaceState {
  receipts: readonly Receipt[];
  transactions: readonly StatementTransaction[];
  matches: readonly ConfirmedMatch[];
  ledger: readonly LedgerEntry[];
  decisions: readonly ReviewDecision[];
  payables: readonly Payable[];
  ruleHeads: readonly RuleHead[];
  ruleVersions: readonly RuleVersion[];
  /** Workspace currency (REQ-20); HKD when omitted. */
  currency?: string;
}

export type RuleChange =
  | { kind: 'activate'; version: RuleVersion }
  | { kind: 'suspend'; ruleId: string }
  | { kind: 'reactivate'; ruleId: string; version: RuleVersion };

export interface CaseSummary {
  group: CaseGroup;
  explanation: string;
  category: { categoryId: CategoryId | null; status: 'unassigned' | 'suggested' | 'confirmed' };
}

export interface ImpactPreview {
  change: RuleChange;
  pendingChanges: Array<{ caseId: string; before: CaseSummary; after: CaseSummary }>;
  recordedDifferences: Array<{ ledgerEntryId: string; note: string }>;
  unchangedCount: number;
  stateFingerprint: string;
}

export const RECORDED_NOT_CHANGED = 'Recorded entries are not changed by this rule.';
export const RECORDED_USING_RULE = 'Recorded using this rule — not changed';

export function activeRulesOf(state: WorkspaceState): RuleVersion[] {
  return activeRulesFrom(state.ruleHeads, state.ruleVersions);
}

export function rulesAfter(current: readonly RuleVersion[], change: RuleChange): RuleVersion[] {
  const ruleId = change.kind === 'activate' ? change.version.ruleId : change.ruleId;
  const rest = current.filter((r) => r.ruleId !== ruleId);
  if (change.kind === 'suspend') return rest;
  return [...rest, change.version];
}

export function evaluationInput(state: WorkspaceState, activeRules: readonly RuleVersion[]): EvaluationInput {
  return {
    receipts: state.receipts,
    transactions: state.transactions,
    matches: state.matches,
    ledgerEntries: state.ledger,
    activeRules,
    decisions: state.decisions,
    workspaceCurrency: state.currency,
  };
}

function changedRule(state: WorkspaceState, change: RuleChange): RuleVersion | null {
  if (change.kind !== 'suspend') return change.version;
  const head = state.ruleHeads.find((h) => h.ruleId === change.ruleId);
  const v = head?.activeVersion ?? head?.lastApprovedVersion ?? null;
  return state.ruleVersions.find((x) => x.ruleId === change.ruleId && x.version === v) ?? null;
}

function summaries(state: WorkspaceState, rules: readonly RuleVersion[]): Map<string, CaseSummary> {
  const evaluation = evaluateWorkspace(evaluationInput(state, rules));
  const out = new Map<string, CaseSummary>();
  for (const r of state.receipts) {
    const v = deriveCaseView(r, evaluation, state.matches, state.ledger, rules);
    if (v.group === null || v.group === 'recorded') continue;
    out.set(r.id, {
      group: v.group,
      explanation: v.explanation,
      category: { categoryId: v.category.categoryId, status: v.category.status },
    });
  }
  return out;
}

/** Recorded receipts re-evaluated as if they were unmatched (read-only, for listing only). */
function asIfUnmatchedOutcomes(state: WorkspaceState, rules: readonly RuleVersion[]): Map<string, string> {
  const evaluation = evaluateWorkspace({
    ...evaluationInput(state, rules),
    matches: state.matches.filter((m) => !(m.status === 'active' && m.subject.kind === 'receipt')),
    ledgerEntries: state.ledger.filter((e) => e.evidence.receiptIds.length === 0),
  });
  const out = new Map<string, string>();
  for (const [id, p] of evaluation.proposals) {
    out.set(id, canonicalJson({ o: p.outcome, t: p.transactionId, c: p.candidateIds, r: p.ruleRefs.filter((x) => !x.ruleId.startsWith('K-CAT-')), pol: p.policyRef }));
  }
  return out;
}

export function previewImpact(state: WorkspaceState, change: RuleChange): ImpactPreview {
  const before = activeRulesOf(state);
  const after = rulesAfter(before, change);
  const b = summaries(state, before);
  const a = summaries(state, after);

  const pendingChanges: ImpactPreview['pendingChanges'] = [];
  let unchangedCount = 0;
  for (const caseId of [...b.keys()].sort()) {
    const sb = b.get(caseId)!;
    const sa = a.get(caseId);
    if (!sa) continue;
    if (canonicalJson(sb) !== canonicalJson(sa)) pendingChanges.push({ caseId, before: sb, after: sa });
    else unchangedCount++;
  }

  const recorded = state.ledger.filter((e) => e.status === 'recorded');
  const notes = new Map<string, string>();
  const rule = changedRule(state, change);
  if (rule && change.kind === 'suspend') {
    for (const e of recorded) if (e.ruleRefs.some((r) => r.ruleId === rule.ruleId)) notes.set(e.id, RECORDED_USING_RULE);
  }
  if (rule && rule.type === 'category_preference') {
    if (change.kind !== 'suspend') {
      for (const e of recorded) {
        if (e.canonicalMerchantId === rule.condition.canonicalMerchantId && e.category.status === 'unassigned' && !notes.has(e.id)) {
          notes.set(e.id, RECORDED_NOT_CHANGED);
        }
      }
    }
  } else if (rule) {
    const ob = asIfUnmatchedOutcomes(state, before);
    const oa = asIfUnmatchedOutcomes(state, after);
    for (const e of recorded) {
      if (notes.has(e.id)) continue;
      if (e.evidence.receiptIds.some((rid) => ob.get(rid) !== oa.get(rid))) notes.set(e.id, RECORDED_NOT_CHANGED);
    }
  }
  const recordedDifferences = [...notes.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([ledgerEntryId, note]) => ({ ledgerEntryId, note }));

  const draft = change.kind === 'activate' ? toDraftContent(change.version) : null;
  return { change, pendingChanges, recordedDifferences, unchangedCount, stateFingerprint: stateFingerprint(state, draft) };
}

/**
 * Fingerprint of everything a preview depends on (§7.4). Activation compares
 * the preview's fingerprint with the current one (STALE_PREVIEW).
 */
export function stateFingerprint(state: WorkspaceState, draft: RuleDraft | null): string {
  const sorted = (xs: string[]) => [...xs].sort();
  return canonicalJson({
    receipts: sorted(state.receipts.map((r) => `${r.id}@${r.updatedAt}`)),
    transactions: sorted(state.transactions.map((t) => `${t.id}:${t.intake}:${t.duplicateResolution ?? '-'}`)),
    matches: sorted(state.matches.filter((m) => m.status === 'active').map((m) => m.id)),
    ledger: sorted(state.ledger.map((e) => `${e.id}:${e.status}`)),
    decisions: sorted(state.decisions.map((d) => d.id)),
    payables: sorted(state.payables.map((p) => `${p.id}:${p.state}`)),
    heads: [...state.ruleHeads]
      .sort((x, y) => (x.ruleId < y.ruleId ? -1 : x.ruleId > y.ruleId ? 1 : 0))
      .map((h) => ({ ruleId: h.ruleId, status: h.status, activeVersion: h.activeVersion, draftVersion: h.draftVersion })),
    draft,
  });
}
