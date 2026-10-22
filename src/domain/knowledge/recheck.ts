/**
 * Explicit historical re-evaluation (design §7.7, REQ-8.6). Read-only: it
 * re-evaluates each recorded receipt as if it were not matched, under the
 * current rules, and lists the entries that would not be recorded the same
 * way now. Nothing is changed in bulk or automatically; the user decides per
 * entry ("Keep as recorded" or "Void and return to review").
 *
 * An entry is listed when a rule version it relied on is no longer the active
 * version (suspended or superseded), or when it was recorded from a proposal
 * and the receipt would no longer get a unique proposal on the same card
 * transaction. A "Keep as recorded" decision made after the last change to
 * those rules takes it off the list.
 */
import { evaluateWorkspace } from '../matching/evaluate';
import type { MatchOutcome } from '../schemas';
import type { RuleRef } from '../primitives';
import { evaluationInput, activeRulesOf, type WorkspaceState } from './preview';

export interface StaleRuleRef {
  ref: RuleRef;
  state: 'suspended' | 'superseded' | 'inactive';
  /** The version now active, when superseded. */
  activeVersion: number | null;
}

export interface RecheckItem {
  ledgerEntryId: string;
  receiptId: string;
  matchId: string;
  transactionId: string;
  method: 'confirmed_proposal' | 'manual_resolution';
  staleRefs: StaleRuleRef[];
  now: { outcome: MatchOutcome | null; transactionId: string | null; explanation: string };
}

export function recheckRecorded(state: WorkspaceState): RecheckItem[] {
  const rules = activeRulesOf(state);
  const heads = new Map(state.ruleHeads.map((h) => [h.ruleId, h]));
  const out: RecheckItem[] = [];
  const entries = [...state.ledger].filter((e) => e.status === 'recorded').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const entry of entries) {
    for (const receiptId of [...entry.evidence.receiptIds].sort()) {
      const match = state.matches.find(
        (m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === receiptId && entry.evidence.matchIds.includes(m.id),
      );
      if (!match) continue;
      const refs = match.proposalSnapshot.ruleRefs.filter((r) => !r.ruleId.startsWith('K-CAT-'));
      if (match.proposalSnapshot.policyRef.ruleId !== 'P-BASE') refs.push({ ruleId: match.proposalSnapshot.policyRef.ruleId, version: match.proposalSnapshot.policyRef.version });
      const staleRefs: StaleRuleRef[] = [];
      for (const ref of refs) {
        const h = heads.get(ref.ruleId);
        if (h?.status === 'active' && h.activeVersion === ref.version) continue;
        staleRefs.push({
          ref,
          state: h?.status === 'suspended' ? 'suspended' : h?.status === 'active' ? 'superseded' : 'inactive',
          activeVersion: h?.status === 'active' ? h.activeVersion : null,
        });
      }
      // As if unmatched: this receipt's link and the entries holding it are left out.
      const evaluation = evaluateWorkspace({
        ...evaluationInput(state, rules),
        matches: state.matches.filter((m) => m.id !== match.id),
        ledgerEntries: state.ledger.filter((e) => !e.evidence.receiptIds.includes(receiptId)),
      });
      const p = evaluation.proposals.get(receiptId) ?? null;
      const same = p !== null && p.outcome === 'unique_candidate' && p.transactionId === match.transactionId;
      const differs = staleRefs.length > 0 || (match.method === 'confirmed_proposal' && !same);
      if (!differs) continue;

      // Kept after the last change to the rules it relied on?
      const lastChange = refs.reduce((max, r) => {
        const at = heads.get(r.ruleId)?.updatedAt ?? '';
        return at > max ? at : max;
      }, '');
      const kept = state.decisions.some(
        (d) => d.kind === 'historical_recheck' && d.choice === 'keep' && d.subjectIds.includes(entry.id) && d.at >= lastChange,
      );
      if (kept) continue;
      out.push({
        ledgerEntryId: entry.id,
        receiptId,
        matchId: match.id,
        transactionId: match.transactionId,
        method: match.method,
        staleRefs,
        now: { outcome: p?.outcome ?? null, transactionId: p?.transactionId ?? null, explanation: p?.explanation ?? '' },
      });
    }
  }
  return out;
}
