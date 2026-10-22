/**
 * "Compare without this rule" (S12, design §9.2, review-3 amendment N8).
 *
 * The replay runs the same immutable fixture snapshot (the bundled fictional
 * receipts and parsed card rows of the loaded batches, with no live matches,
 * decisions or edits) through the same engine twice: with the current active
 * rules and with the same set minus the selected rule. It is pure and never
 * receives a repository, so it cannot change the live ledger, candidate
 * availability or approvals. It is an illustration, not a productivity measure.
 */
import type { CaseGroup } from '../domain/matching/caseView';
import type { RuleHead, RuleVersion } from '../domain/knowledge/schema';
import type { RuleRef } from '../domain/primitives';
import type { Receipt, StatementTransaction } from '../domain/schemas';
import { deriveWorkspaceView } from '../domain/views';

export const COMPARE_TITLE = 'Illustrative fixture replay—not measured productivity';

export interface FixtureSnapshot {
  readonly batches: readonly number[];
  readonly receipts: readonly Receipt[];
  readonly transactions: readonly StatementTransaction[];
  /** Re-uploads of an identical file: never a receipt in either replay. */
  readonly duplicateUploads: ReadonlyArray<{ readonly fixtureId: string; readonly matchedReceiptId: string }>;
}

export interface ReplayCell {
  group: CaseGroup;
  explanation: string;
  ruleRefs: RuleRef[];
}

export interface CompareRow {
  caseId: string;
  withRule: ReplayCell | null;
  withoutRule: ReplayCell | null;
  /** Set for a duplicate upload ("Duplicate upload — not added" in both columns). */
  duplicateOf: string | null;
}

export interface CompareResult {
  ruleRef: RuleRef;
  rows: CompareRow[];
  counts: { total: number; readyWith: number; readyWithout: number };
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

function replay(snapshot: FixtureSnapshot, rules: readonly RuleVersion[]): Map<string, ReplayCell> {
  const view = deriveWorkspaceView(
    {
      receipts: snapshot.receipts,
      transactions: snapshot.transactions,
      matches: [],
      ledger: [],
      decisions: [],
      payables: [],
      ruleHeads: [],
      ruleVersions: [],
    },
    rules,
  );
  const out = new Map<string, ReplayCell>();
  for (const c of view.cases) {
    if (c.group === null) continue;
    out.set(c.receiptId, { group: c.group, explanation: c.explanation, ruleRefs: [...(c.proposal?.ruleRefs ?? [])] });
  }
  return out;
}

/**
 * With = every current active rule. Without = the same set minus the selected
 * rule (for a posting-window rule, the engine then falls back to P-BASE v0).
 */
export function compareReplay(snapshot: FixtureSnapshot, activeRules: readonly RuleVersion[], ruleRef: RuleRef): CompareResult {
  const rules = activeRules.map((r) => structuredClone(r));
  const withRules = replay(snapshot, rules);
  const withoutRules = replay(
    snapshot,
    rules.filter((r) => r.ruleId !== ruleRef.ruleId),
  );
  const ids = [...new Set([...withRules.keys(), ...withoutRules.keys()])].sort();
  const rows: CompareRow[] = ids.map((caseId) => ({ caseId, withRule: withRules.get(caseId) ?? null, withoutRule: withoutRules.get(caseId) ?? null, duplicateOf: null }));
  for (const d of [...snapshot.duplicateUploads].sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : 1))) {
    rows.push({ caseId: d.fixtureId, withRule: null, withoutRule: null, duplicateOf: d.matchedReceiptId });
  }
  rows.sort((a, b) => (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  const ready = (m: Map<string, ReplayCell>) => [...m.values()].filter((c) => c.group === 'ready').length;
  return { ruleRef: { ruleId: ruleRef.ruleId, version: ruleRef.version }, rows, counts: { total: ids.length, readyWith: ready(withRules), readyWithout: ready(withoutRules) } };
}

/**
 * The tour-bar target (N8): the most recently activated active merchant-alias
 * or posting-window rule. Category preferences never change matching, so they
 * are not offered. Null when none is active.
 */
export function selectCompareTarget(heads: readonly RuleHead[], versions: readonly RuleVersion[]): RuleRef | null {
  const candidates = heads
    .filter((h) => h.status === 'active' && h.activeVersion !== null && (h.type === 'merchant_alias' || h.type === 'posting_window'))
    .map((h) => {
      const v = versions.find((x) => x.ruleId === h.ruleId && x.version === h.activeVersion);
      return { ref: { ruleId: h.ruleId, version: h.activeVersion! }, at: v?.approvedAt ?? '' };
    })
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.ref.ruleId > b.ref.ruleId ? -1 : 1));
  return candidates[0]?.ref ?? null;
}

/** True when the rule can be compared (an active alias or posting-window rule). */
export function isComparable(head: RuleHead): boolean {
  return head.status === 'active' && (head.type === 'merchant_alias' || head.type === 'posting_window');
}
