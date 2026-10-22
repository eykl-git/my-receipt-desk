/**
 * Manual resolution ("Confirm this case only", design §6.2). The user may
 * accept an unrecognised card label, choose between ambiguous candidates, or
 * accept a posting date outside the demo policy, with a recorded reason. A
 * different amount or currency, unvalidated fields, unresolved duplicates and
 * already-linked transactions are always refused. No rule is created.
 */
import { captureStatus, effectiveFields } from '../capture/fields';
import { AlreadyLinkedError, ValidationError } from '../errors';
import { LIMITS } from '../limits';
import { canonicalMerchantId, normalizeLabel } from '../normalize';
import type { StatementTransaction, TraceStep } from '../schemas';
import { buildContext, identityOf } from './context';
import { unsupportedCurrencyMessage } from './evaluate';
import { byId, displayRef, inWindow, isHeldForDuplicateReview, postingLag } from './helpers';
import { labelSimilarity, sharedWordHint } from './similarity';
import type { EvaluationInput } from './types';
import { err, ok, type Result } from '../result';

export interface ManualResolutionRequest {
  receiptId: string;
  transactionId: string;
  reason: string;
}

export interface ManualResolutionCheck {
  reason: string;
  outsideWindow: boolean;
  identity: 'exact' | 'alias' | 'unrecognised';
  trace: TraceStep[];
}

export const MANUAL_MESSAGES = Object.freeze({
  fieldsFirst: 'Check the receipt fields first',
  amountsDiffer: 'Amounts differ. Partial and split payments are not supported in this prototype.',
  duplicateFirst: 'Resolve the possible duplicate first.',
  reasonLength: `Reason must be ${LIMITS.reasonMinChars}–${LIMITS.reasonMaxChars} characters.`,
  noCandidate: 'No card transaction with this exact amount is available.',
  chooseOne: 'Choose a card transaction',
});

export function checkManualResolution(
  input: EvaluationInput,
  req: ManualResolutionRequest,
): Result<ManualResolutionCheck, ValidationError | AlreadyLinkedError> {
  const reason = req.reason.trim();
  if (reason.length < LIMITS.reasonMinChars || reason.length > LIMITS.reasonMaxChars) {
    return err(new ValidationError('REASON_LENGTH', MANUAL_MESSAGES.reasonLength));
  }
  const receipt = input.receipts.find((r) => r.id === req.receiptId);
  if (!receipt || receipt.disposition !== 'active') {
    return err(new ValidationError('RECEIPT_UNAVAILABLE', 'This receipt is not available for matching.'));
  }
  const ctx = buildContext(input);
  if (ctx.matchedReceipts.has(receipt.id)) {
    return err(new ValidationError('RECEIPT_MATCHED', 'This receipt is already recorded.'));
  }
  const t = input.transactions.find((x) => x.id === req.transactionId);
  if (!t) return err(new ValidationError('TRANSACTION_UNKNOWN', 'That card transaction does not exist.'));

  const linkedTo = ctx.matchedTxn.get(t.id) ?? null;
  if (linkedTo !== null) return err(new AlreadyLinkedError(t.id, linkedTo));
  const taken = ctx.ledgerTaken.get(t.id);
  if (taken) return err(new AlreadyLinkedError(t.id, taken.evidence.receiptIds[0] ?? taken.evidence.payableIds[0] ?? null));

  if (captureStatus(receipt) !== 'validated') return err(new ValidationError('FIELDS_UNVALIDATED', MANUAL_MESSAGES.fieldsFirst));
  const f = effectiveFields(receipt);
  if (f.merchant === null || f.date === null || f.amountMinor === null || f.currency === null) {
    return err(new ValidationError('FIELDS_UNVALIDATED', MANUAL_MESSAGES.fieldsFirst));
  }
  if (ctx.duplicates.has(receipt.id) || isHeldForDuplicateReview(t)) {
    return err(new ValidationError('DUPLICATE_UNRESOLVED', MANUAL_MESSAGES.duplicateFirst));
  }
  if (t.intake !== 'available' || t.direction !== 'debit') {
    return err(new ValidationError('TRANSACTION_UNSUPPORTED', 'This card transaction can’t be matched (not an available charge).'));
  }
  if (f.currency !== ctx.currency || t.currency !== ctx.currency) {
    const cur = f.currency !== ctx.currency ? f.currency : t.currency;
    return err(new ValidationError('CURRENCY_UNSUPPORTED', unsupportedCurrencyMessage(cur, ctx.currency)));
  }
  if (f.amountMinor !== t.amountMinor) return err(new ValidationError('AMOUNT_MISMATCH', MANUAL_MESSAGES.amountsDiffer));

  const identity = identityOf(ctx, t, normalizeLabel(f.merchant), canonicalMerchantId(f.merchant)).kind;
  const outsideWindow = !inWindow(f.date, t, ctx.policy.postingLagMaxDays);
  const tEv = { kind: 'transaction' as const, ref: t.id };
  const trace: TraceStep[] = [
    { check: 'manual', result: 'info', message: `Confirmed by you: ${displayRef(t)}. Reason: ${reason}`, evidence: [{ kind: 'receipt', ref: receipt.id }, tEv] },
  ];
  if (identity === 'unrecognised') {
    trace.push({ check: 'merchant_identity', result: 'info', message: `Card label “${t.rawLabel}” confirmed by you for this case only. No rule was created.`, evidence: [tEv] });
  }
  if (outsideWindow) {
    trace.push({ check: 'candidates', result: 'info', message: 'Outside the demo date policy; confirmed by you', evidence: [tEv], ruleRef: ctx.policy.ref });
  }
  return ok({ reason, outsideWindow, identity, trace });
}

export interface PickerRow {
  transaction: StatementTransaction;
  lag: number;
  nameMatches: boolean;
  outsideWindow: boolean;
  tags: string[];
}

/**
 * "Choose the card transaction" list (§6.2): available debits in the workspace
 * currency with the receipt's exact amount, not linked, not held for duplicate
 * review. Ignores the date window and label checks; sorted by |posting lag|,
 * then label similarity (brief §25 C, ordering only), then reference.
 */
export function pickerCandidates(input: EvaluationInput, receiptId: string): PickerRow[] {
  const receipt = input.receipts.find((r) => r.id === receiptId);
  if (!receipt) return [];
  const f = effectiveFields(receipt);
  if (f.merchant === null || f.date === null || f.amountMinor === null) return [];
  const ctx = buildContext(input);
  const date = f.date;
  const merchantNorm = normalizeLabel(f.merchant);
  const merchantId = canonicalMerchantId(f.merchant);
  const rows: PickerRow[] = [];
  const similarity = new Map<string, number>();
  for (const t of ctx.transactions) {
    if (t.intake !== 'available' || t.direction !== 'debit' || t.currency !== ctx.currency) continue;
    if (t.amountMinor !== f.amountMinor || ctx.matchedTxn.has(t.id) || ctx.ledgerTaken.has(t.id)) continue;
    if (isHeldForDuplicateReview(t)) continue;
    const lag = postingLag(date, t);
    const nameMatches = identityOf(ctx, t, merchantNorm, merchantId).kind !== 'unrecognised';
    const outsideWindow = !inWindow(date, t, ctx.policy.postingLagMaxDays);
    const tags = [nameMatches ? 'Name matches' : 'Different card name'];
    // Similarity only orders rows and explains them in words (brief §25 C); it never decides anything.
    const hint = nameMatches ? null : sharedWordHint(t.rawLabel, f.merchant);
    if (hint) tags.push(hint);
    if (outsideWindow) tags.push('Outside the demo date policy');
    similarity.set(t.id, nameMatches ? Number.POSITIVE_INFINITY : labelSimilarity(t.rawLabel, f.merchant));
    rows.push({ transaction: t, lag, nameMatches, outsideWindow, tags });
  }
  return rows.sort((a, b) => {
    const d = Math.abs(a.lag) - Math.abs(b.lag);
    if (d !== 0) return d;
    const s = (similarity.get(b.transaction.id) ?? 0) - (similarity.get(a.transaction.id) ?? 0);
    if (s !== 0 && !Number.isNaN(s)) return s;
    const ra = displayRef(a.transaction);
    const rb = displayRef(b.transaction);
    return ra < rb ? -1 : ra > rb ? 1 : byId(a.transaction, b.transaction);
  });
}
