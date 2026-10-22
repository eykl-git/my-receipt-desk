/**
 * Revalidate before commit (rule 10, design §6.1). Runs inside the write
 * transaction on the state read there; any difference from the proposal the
 * user saw aborts the commit.
 */
import type { StaleReason } from '../errors';
import { canonicalJson } from './fingerprint';
import { evaluateWorkspace } from './evaluate';
import type { EvaluationInput, MatchProposal } from './types';

export type RevalidationResult = { ok: true; proposal: MatchProposal } | { ok: false; reason: StaleReason };

export function revalidate(inputNow: EvaluationInput, shown: MatchProposal): RevalidationResult {
  const receiptId = shown.subject.id;
  const txnId = shown.transactionId;
  if (shown.outcome !== 'unique_candidate' || txnId === null) return { ok: false, reason: 'now_ambiguous' };

  const taken =
    inputNow.matches.some((m) => m.status === 'active' && m.transactionId === txnId) ||
    inputNow.ledgerEntries.some(
      (e) =>
        e.status === 'recorded' &&
        e.identityKey === txnId &&
        (e.evidence.receiptIds.length > 0 || e.evidence.payableIds.length > 0),
    );
  if (taken) return { ok: false, reason: 'transaction_taken' };

  const now = evaluateWorkspace(inputNow).proposals.get(receiptId);
  if (!now || now.receiptKey !== shown.receiptKey) return { ok: false, reason: 'receipt_changed' };
  if (canonicalJson(now.ruleRefs) !== canonicalJson(shown.ruleRefs) || canonicalJson(now.policyRef) !== canonicalJson(shown.policyRef)) {
    return { ok: false, reason: 'rule_changed' };
  }
  if (now.outcome !== 'unique_candidate' || now.transactionId !== txnId || now.fingerprint !== shown.fingerprint) {
    return { ok: false, reason: 'now_ambiguous' };
  }
  return { ok: true, proposal: now };
}
