/**
 * Pure, deterministic matching engine (S8 rules 1–10, design §6).
 *
 * Receipts and transactions are processed in sorted ID order and the result is
 * a set computation, so output does not depend on input order. Aliases are
 * consulted only for merchant identity (step 6); they never relax amount,
 * currency, date, duplicate or ambiguity checks. Category preferences are
 * evaluated after matching and never feed back.
 */
import { captureStatus, effectiveFields, fieldIssues } from '../capture/fields';
import { categoryName } from '../categories';
import type { IsoDate } from '../dates';
import { deriveCategory } from '../knowledge/resolve';
import { formatMoney } from '../money';
import { canonicalMerchantId, normalizeLabel } from '../normalize';
import { formatRuleRef, type EvidenceRef, type ReviewFlag, type RuleRef } from '../primitives';
import { ENGINE_VERSION, type MatchOutcome, type MatchProposal, type Receipt, type StatementTransaction, type TraceStep } from '../schemas';
import { bucketKey, buildContext, DEFAULT_CURRENCY, hasLabelConflict, identityOf, isFreeCandidate, type EvalContext } from './context';
import { storeNumberStem } from '../normalize';
import { canonicalJson } from './fingerprint';
import { byId, displayRef, inWindow, isHeldForDuplicateReview, joinRefs, plural, postingLag, sortRefs } from './helpers';
import type { EvaluationInput, EvaluationResult, TransactionFlags } from './types';

const ev = (kind: EvidenceRef['kind'], ref: string): EvidenceRef => ({ kind, ref });
const txEv = (t: StatementTransaction): EvidenceRef => ev('transaction', t.id);

interface Working {
  receipt: Receipt;
  trace: TraceStep[];
  flags: ReviewFlag[];
  outcome: MatchOutcome;
  explanation: string;
  candidates: StatementTransaction[];
  near: StatementTransaction[];
  held: StatementTransaction[];
  aliasRefs: RuleRef[];
  /** Receipts reaching step 7 claim their identity-confirmed candidates. */
  claims: boolean;
}

/** Why a receipt or row in another currency can't match (S-1: never converted). */
export function unsupportedCurrencyMessage(currency: string, workspaceCurrency: string): string {
  return workspaceCurrency === DEFAULT_CURRENCY
    ? `${currency} is not supported in this prototype. Nothing was converted.`
    : `${currency} is not supported in this workspace, which uses ${workspaceCurrency}. Nothing was converted.`;
}

function windowText(ctx: EvalContext): string {
  return `0–${ctx.policy.postingLagMaxDays} days`;
}

/** Same-merchant rows outside the amount or date filter are reported as info, never as candidates. */
function differenceSteps(
  ctx: EvalContext,
  r: { date: IsoDate; amountMinor: number; currency: string },
  merchantNorm: string,
  merchantId: string,
  inBase: Set<string>,
): TraceStep[] {
  const labels = new Set<string>([merchantNorm]);
  for (const a of ctx.aliasesByTarget.get(merchantId) ?? []) {
    labels.add(a.condition.observedLabel);
    if (a.condition.match === 'exact_ignoring_store_number') {
      const stem = storeNumberStem(a.condition.observedLabel);
      for (const label of ctx.byLabel.keys()) if (storeNumberStem(label) === stem) labels.add(label);
    }
  }
  const steps: TraceStep[] = [];
  for (const label of [...labels].sort()) {
    for (const t of ctx.byLabel.get(label) ?? []) {
      if (inBase.has(t.id) || identityOf(ctx, t, merchantNorm, merchantId).kind === 'unrecognised') continue;
      if (steps.length >= 10) return steps;
      let message: string;
      if (t.currency !== r.currency || t.amountMinor !== r.amountMinor) {
        message = `${displayRef(t)} is ${formatMoney(t.amountMinor, t.currency)}, not ${formatMoney(r.amountMinor, r.currency)}.`;
      } else {
        const lag = postingLag(r.date, t);
        message =
          lag < 0
            ? `${displayRef(t)} was posted before the receipt date, outside the demo date policy (${windowText(ctx)}).`
            : `${displayRef(t)} was posted ${lag} days after the receipt, outside the demo date policy (${windowText(ctx)}).`;
      }
      steps.push({ check: 'difference', result: 'info', message, evidence: [txEv(t)] });
    }
  }
  return steps;
}

function evaluateReceipt(ctx: EvalContext, receipt: Receipt): Working {
  const w: Working = {
    receipt,
    trace: [],
    flags: [],
    outcome: 'blocked',
    explanation: '',
    candidates: [],
    near: [],
    held: [],
    aliasRefs: [],
    claims: false,
  };
  const policyRef = ctx.policy.ref;
  const f = effectiveFields(receipt);
  const recEv = ev('receipt', receipt.id);

  // Step 1 (rules 1, 8): required fields validated.
  const issues = fieldIssues(receipt);
  if (captureStatus(receipt) !== 'validated' || f.merchant === null || f.date === null || f.amountMinor === null || f.currency === null) {
    w.flags.push('missing_fields');
    w.explanation = issues.map((i) => i.message).join(' ');
    w.trace.push({ check: 'fields', result: 'fail', message: w.explanation, evidence: [recEv] });
    // Near candidates for display only: same name (or active in-scope alias) and posting date in window.
    // The amount is not compared and the statement amount is never copied into the receipt.
    if (f.merchant !== null && f.date !== null) {
      const merchantNorm = normalizeLabel(f.merchant);
      const merchantId = canonicalMerchantId(f.merchant);
      const date = f.date;
      w.near = ctx.transactions.filter(
        (t) =>
          isFreeCandidate(ctx, t) &&
          inWindow(date, t, ctx.policy.postingLagMaxDays) &&
          identityOf(ctx, t, merchantNorm, merchantId).kind !== 'unrecognised',
      );
      if (w.near.length > 0) {
        w.trace.push({
          check: 'candidates',
          result: 'info',
          message: `Possible card transaction${plural(w.near.length, '', 's')}: ${joinRefs(w.near)}. Not compared: the receipt amount is not validated.`,
          evidence: w.near.map(txEv),
          ruleRef: policyRef,
        });
      }
    }
    return w;
  }
  w.trace.push({ check: 'fields', result: 'pass', message: 'Merchant, date, amount and currency are validated.', evidence: [recEv] });

  const merchant = f.merchant;
  const date = f.date;
  const amountMinor = f.amountMinor;
  const currency = f.currency;
  const merchantNorm = normalizeLabel(merchant);
  const merchantId = canonicalMerchantId(merchant);

  // Step 2 (rules 2, 8): currency support. Only the workspace currency
  // (HKD unless My files uses MYR); nothing is converted.
  if (currency !== ctx.currency) {
    w.flags.push('unsupported_input');
    w.trace.push({
      check: 'currency',
      result: 'fail',
      message: unsupportedCurrencyMessage(currency, ctx.currency),
      evidence: [recEv],
    });
  } else {
    w.trace.push({ check: 'currency', result: 'pass', message: `Currency is ${ctx.currency}.`, evidence: [recEv] });
  }

  // Step 3 (rule 8): unresolved suspected duplicate purchase.
  const dupOf = ctx.duplicates.get(receipt.id);
  if (dupOf && dupOf.length > 0) {
    w.flags.push('duplicate_suspected');
    w.trace.push({
      check: 'duplicate',
      result: 'fail',
      message: `Possible duplicate of ${dupOf.join(', ')} from another file. Choose “These are different purchases” or set this one aside.`,
      evidence: [recEv, ...dupOf.map((id) => ev('receipt', id))],
    });
  } else {
    w.trace.push({ check: 'duplicate', result: 'pass', message: 'No suspected duplicate purchase.', evidence: [recEv] });
  }

  // Step 5 (rules 2, 4, 5): base candidates — same currency, exact minor-unit
  // amount, posting date 0…N days on/after the receipt date, available, debit,
  // not linked. Held duplicate rows are tracked separately and never candidates.
  const bucket = ctx.buckets.get(bucketKey(currency, amountMinor)) ?? [];
  const inRange = bucket.filter((t) => inWindow(date, t, ctx.policy.postingLagMaxDays));
  const base = inRange.filter((t) => !isHeldForDuplicateReview(t));
  const heldPool = inRange.filter((t) => isHeldForDuplicateReview(t));

  // Step 4 (rule 8): conflicting active rules touching this receipt's merchant or candidates.
  const conflict =
    ctx.conflictingMerchants.has(merchantId) ||
    inRange.some((t) => hasLabelConflict(ctx, t));
  if (conflict) {
    w.flags.push('rule_conflict');
    w.trace.push({
      check: 'rule_conflict',
      result: 'fail',
      message: 'Two active rules disagree about this merchant or card label. Review the Knowledge Space.',
      evidence: [recEv],
    });
  } else {
    w.trace.push({ check: 'rule_conflict', result: 'pass', message: 'No conflicting rules.', evidence: [] });
  }

  // Step 6 (rule 3): merchant identity.
  const identitySteps: TraceStep[] = [];
  const C: StatementTransaction[] = [];
  const N: StatementTransaction[] = [];
  for (const t of base) {
    const id = identityOf(ctx, t, merchantNorm, merchantId);
    if (id.kind === 'exact') {
      C.push(t);
      identitySteps.push({ check: 'merchant_identity', result: 'pass', message: `${displayRef(t)} “${t.rawLabel}” has the same name as the receipt.`, evidence: [txEv(t)] });
    } else if (id.kind === 'alias') {
      C.push(t);
      const ref = { ruleId: id.rule.ruleId, version: id.rule.version };
      w.aliasRefs.push(ref);
      identitySteps.push({
        check: 'merchant_identity',
        result: 'pass',
        message: `${displayRef(t)} “${t.rawLabel}” is ${id.rule.action.canonicalMerchantName}: matched name using ${formatRuleRef(ref)}.`,
        evidence: [txEv(t)],
        ruleRef: ref,
      });
    } else {
      N.push(t);
      identitySteps.push({ check: 'merchant_identity', result: 'fail', message: `${displayRef(t)} “${t.rawLabel}” is not a known name for ${merchant}.`, evidence: [txEv(t)] });
    }
  }
  const H = heldPool.filter((t) => identityOf(ctx, t, merchantNorm, merchantId).kind !== 'unrecognised');

  if (w.flags.length > 0) {
    // Blocked by currency, duplicate or conflict: related rows are listed for display only.
    w.near = [...C, ...N, ...H].sort(byId);
    w.explanation = w.trace.filter((s) => s.result === 'fail').map((s) => s.message).join(' ');
    w.aliasRefs = [];
    return w;
  }

  if (inRange.length > 0) {
    w.trace.push({
      check: 'candidates',
      result: 'pass',
      message: `${inRange.length} card transaction${plural(inRange.length, '', 's')} with ${formatMoney(amountMinor, currency)} posted ${windowText(ctx)} after ${date} (demo policy): ${joinRefs(inRange)}.`,
      evidence: inRange.map(txEv),
      ruleRef: policyRef,
    });
  } else {
    w.trace.push({ check: 'candidates', result: 'fail', message: 'No card transaction with this amount and date yet', evidence: [], ruleRef: policyRef });
  }
  w.trace.push(...identitySteps);
  w.trace.push(...differenceSteps(ctx, { date, amountMinor, currency }, merchantNorm, merchantId, new Set(inRange.map((t) => t.id))));

  // Step 7 (rule 7): per-receipt outcome. Never picks the first row.
  w.candidates = C;
  w.near = N;
  w.held = H;
  w.claims = true;
  for (const t of H) {
    w.trace.push({ check: 'held', result: 'info', message: `${displayRef(t)} matches but is held for duplicate review.`, evidence: [txEv(t)] });
  }
  if (H.length > 0) {
    if (C.length === 0) {
      w.outcome = 'unmatched';
      w.explanation = `${joinRefs(H)} matches but is held for duplicate review. Resolve the card transaction first.`;
    } else {
      w.outcome = 'ambiguous';
      w.explanation = `${joinRefs(C)} matches, and ${joinRefs(H)} also matches but is held for duplicate review. Choose one after resolving it.`;
    }
  } else if (C.length === 1) {
    const t = C[0]!;
    w.outcome = 'unique_candidate';
    const aliasRef = w.aliasRefs[0];
    w.explanation = aliasRef
      ? `Matches ${displayRef(t)}. Matched name using ${formatRuleRef(aliasRef)}.`
      : `Matches ${displayRef(t)}: same name, amount and currency, posted ${postingLag(date, t)} ${plural(postingLag(date, t), 'day', 'days')} after the receipt.`;
  } else if (C.length > 1) {
    w.outcome = 'ambiguous';
    w.explanation = `${C.length} card transactions match equally: ${joinRefs(C)}. Choose one.`;
  } else if (N.length > 0) {
    w.outcome = 'unmatched';
    const labels = [...new Set(N.map((t) => t.rawLabel))];
    const head =
      labels.length === 1
        ? `Card label “${labels[0]}” is not a known name for ${merchant}.`
        : `Card labels ${labels.map((l) => `“${l}”`).join(', ')} are not known names for ${merchant}.`;
    w.explanation = `${head} Amount, currency and date match ${joinRefs(N)}.`;
  } else {
    w.outcome = 'unmatched';
    w.explanation = 'No card transaction with this amount and date yet';
  }
  w.trace.push({
    check: 'outcome',
    result: w.outcome === 'unique_candidate' ? 'pass' : 'fail',
    message: w.explanation,
    evidence: [...C, ...H].map(txEv),
  });
  return w;
}

function receiptKey(receipt: Receipt, flags: readonly ReviewFlag[]): string {
  return canonicalJson({
    id: receipt.id,
    disposition: receipt.disposition,
    capture: captureStatus(receipt),
    fields: effectiveFields(receipt),
    flags: [...flags].sort(),
  });
}

export function evaluateWorkspace(input: EvaluationInput): EvaluationResult {
  const ctx = buildContext(input);
  const receipts = [...input.receipts].sort(byId);
  const working: Working[] = [];
  for (const r of receipts) {
    if (r.disposition !== 'active' || ctx.matchedReceipts.has(r.id)) continue;
    working.push(evaluateReceipt(ctx, r));
  }

  // Step 8 (rule 6): batch-wide collisions. Two receipts competing for one
  // transaction never both become proposals.
  const claims = new Map<string, Set<string>>();
  for (const w of working) {
    if (!w.claims) continue;
    for (const t of w.candidates) {
      const s = claims.get(t.id) ?? new Set<string>();
      s.add(w.receipt.id);
      claims.set(t.id, s);
    }
  }

  const proposals = new Map<string, MatchProposal>();
  for (const w of working) {
    const competing = new Set<string>();
    for (const t of w.candidates) for (const id of claims.get(t.id) ?? []) if (id !== w.receipt.id) competing.add(id);
    const competingIds = [...competing].sort();

    if (w.claims) {
      if (w.outcome === 'unique_candidate' && competingIds.length > 0) {
        const t = w.candidates[0]!;
        w.outcome = 'ambiguous';
        w.explanation =
          competingIds.length === 1
            ? `Another receipt (${competingIds[0]}) also matches ${displayRef(t)}. Choose which one it belongs to.`
            : `Other receipts (${competingIds.join(', ')}) also match ${displayRef(t)}. Choose which one it belongs to.`;
        w.trace.push({ check: 'collision', result: 'fail', message: w.explanation, evidence: [txEv(t), ...competingIds.map((id) => ev('receipt', id))] });
      } else if (competingIds.length > 0) {
        w.trace.push({ check: 'collision', result: 'info', message: `Other receipts also match these card transactions: ${competingIds.join(', ')}.`, evidence: competingIds.map((id) => ev('receipt', id)) });
      } else {
        w.trace.push({ check: 'collision', result: 'pass', message: 'No other receipt competes for these card transactions.', evidence: [] });
      }
    }

    // Step 9: refs and category (a separate section; never changes the outcome).
    const category = deriveCategory(w.receipt, input.activeRules);
    const categoryRef = category.status === 'suggested' ? category.ruleRef : null;
    w.trace.push({
      check: 'category',
      result: 'info',
      message:
        category.status === 'suggested' && category.categoryId && categoryRef
          ? `Suggested category ${categoryName(category.categoryId)} from ${formatRuleRef(categoryRef)}. It does not affect matching.`
          : category.status === 'confirmed' && category.categoryId
            ? `Category confirmed: ${categoryName(category.categoryId)}.`
            : 'No category yet. Matching does not depend on it.',
      evidence: [],
      ...(categoryRef ? { ruleRef: categoryRef } : {}),
    });
    const ruleRefs = sortRefs([...w.aliasRefs, ...(categoryRef ? [categoryRef] : [])]);
    const transactionId = w.outcome === 'unique_candidate' ? w.candidates[0]!.id : null;
    const candidateIds = w.candidates.map((t) => t.id).sort();
    const key = receiptKey(w.receipt, w.flags);

    // Step 10: fingerprint (canonical JSON string).
    const fingerprint = canonicalJson({
      engineVersion: ENGINE_VERSION,
      policyRef: ctx.policy.ref,
      receipt: key,
      outcome: w.outcome,
      transactionId,
      candidateIds,
      ruleRefs,
      competing: competingIds,
    });

    proposals.set(w.receipt.id, {
      subject: { kind: 'receipt', id: w.receipt.id },
      outcome: w.outcome,
      transactionId,
      candidateIds,
      nearCandidateIds: w.near.map((t) => t.id).sort(),
      heldIds: w.held.map((t) => t.id).sort(),
      competingReceiptIds: competingIds,
      flags: [...w.flags],
      explanation: w.explanation,
      ruleRefs,
      policyRef: { ...ctx.policy.ref },
      engineVersion: ENGINE_VERSION,
      category: { categoryId: category.categoryId, ruleRef: category.ruleRef },
      receiptKey: key,
      fingerprint,
      trace: w.trace,
    });
  }

  return {
    proposals,
    transactionFlags: deriveTransactionFlags(ctx, proposals),
    duplicateReceipts: ctx.duplicates,
    policy: ctx.policy,
  };
}

/** Card-transaction case flags (design §5.1). */
function deriveTransactionFlags(ctx: EvalContext, proposals: ReadonlyMap<string, MatchProposal>): Map<string, TransactionFlags> {
  const related = new Set<string>();
  for (const p of proposals.values()) {
    for (const id of p.candidateIds) related.add(id);
    for (const id of p.nearCandidateIds) related.add(id);
    for (const id of p.heldIds) related.add(id);
  }
  const out = new Map<string, TransactionFlags>();
  for (const t of ctx.transactions) {
    if (t.intake === 'set_aside_duplicate') continue;
    if (t.intake === 'quarantined_currency') {
      out.set(t.id, { flags: ['unsupported_input'], explanation: `Not supported: ${t.currency} is not converted.` });
      continue;
    }
    if (t.intake === 'credit_not_supported' || t.direction === 'credit') {
      out.set(t.id, { flags: ['unsupported_input'], explanation: 'Not supported: credits and refunds are not handled in this prototype.' });
      continue;
    }
    if (ctx.matchedTxn.has(t.id) || ctx.recordedIdentities.has(t.id)) continue;
    if (isHeldForDuplicateReview(t)) {
      const other = t.duplicateOf ? ctx.txById.get(t.duplicateOf) : undefined;
      const name = other ? displayRef(other) : 'another row';
      out.set(t.id, {
        flags: ['duplicate_suspected'],
        explanation: `Possible duplicate of ${name} from another file. Keep both or set this row aside.`,
      });
      continue;
    }
    if (t.currency === ctx.currency && !related.has(t.id)) {
      out.set(t.id, { flags: ['missing_receipt'], explanation: 'No receipt yet' });
    }
  }
  return out;
}
