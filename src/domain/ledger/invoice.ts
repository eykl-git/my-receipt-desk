/**
 * Received invoices (design §6.4, §10.3, REQ-17). An unpaid invoice is a
 * separate payable record, never a paid expense. One predicate decides which
 * card transactions can pay it; the "Link card payment" list and the
 * `attachPayment` write both use it, so the list can never offer a row the
 * write would refuse. An invoice alone is not proof of payment.
 */
import { isDateInSupportedRange, toIsoDate, type IsoDate } from '../dates';
import { LIMITS } from '../limits';
import { parseAmount } from '../money';
import { isHeldForDuplicateReview } from '../matching/helpers';
import type { ConfirmedMatch, LedgerEntry, Payable, StatementTransaction } from '../schemas';

export interface PaymentState {
  matches: readonly ConfirmedMatch[];
  ledger: readonly LedgerEntry[];
  /** Workspace currency (REQ-20); HKD when omitted. */
  currency?: string;
}

/**
 * Payable unpaid and in the workspace currency; transaction an available
 * debit in that currency with the exact amount, not linked, not held for
 * duplicate review, not the identity of a recorded entry that already has a
 * receipt or invoice, and posted on or after the invoice date (§6.4).
 */
export function isPaymentCandidate(payable: Payable, t: StatementTransaction, state: PaymentState): boolean {
  const currency = state.currency ?? 'HKD';
  if (payable.state !== 'unpaid' || payable.currency !== currency) return false;
  if (t.intake !== 'available' || t.direction !== 'debit' || t.currency !== currency) return false;
  if (t.amountMinor !== payable.amountMinor) return false;
  if (isHeldForDuplicateReview(t)) return false;
  if (state.matches.some((m) => m.status === 'active' && m.transactionId === t.id)) return false;
  const taken = state.ledger.some(
    (e) => e.status === 'recorded' && e.identityKey === t.id && (e.evidence.receiptIds.length > 0 || e.evidence.payableIds.length > 0),
  );
  if (taken) return false;
  return t.postingDate >= payable.invoiceDate;
}

/** The "Link card payment" list, sorted by posting date then ID. */
export function paymentCandidates(
  payable: Payable,
  transactions: readonly StatementTransaction[],
  state: PaymentState,
): StatementTransaction[] {
  return transactions
    .filter((t) => isPaymentCandidate(payable, t, state))
    .sort((a, b) => (a.postingDate < b.postingDate ? -1 : a.postingDate > b.postingDate ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export interface PayableInput {
  supplierName: string;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  currency: string;
}

export interface ValidPayable {
  supplierName: string;
  invoiceNumber: string | null;
  invoiceDate: IsoDate;
  amountMinor: number;
  currency: string;
}

export type PayableErrors = Partial<Record<keyof PayableInput, string>>;

/** Invoice fields (§10.3): same rules as receipt fields, plus an optional invoice number ≤40. */
export function validatePayableInput(input: PayableInput): { ok: true; values: ValidPayable } | { ok: false; errors: PayableErrors } {
  const errors: PayableErrors = {};
  const supplierName = input.supplierName.trim();
  if (supplierName.length < LIMITS.merchantMinChars || supplierName.length > LIMITS.merchantMaxChars) {
    errors.supplierName = `Supplier must be ${LIMITS.merchantMinChars}–${LIMITS.merchantMaxChars} characters.`;
  }
  const invoiceNumber = input.invoiceNumber.trim();
  if (invoiceNumber.length > LIMITS.invoiceNumberMaxChars) errors.invoiceNumber = `Invoice number must be at most ${LIMITS.invoiceNumberMaxChars} characters.`;
  const invoiceDate = toIsoDate(input.invoiceDate.trim());
  if (invoiceDate === null || !isDateInSupportedRange(invoiceDate)) errors.invoiceDate = `Enter a real date between ${LIMITS.dateMin} and ${LIMITS.dateMax}.`;
  const amountText = input.amount.trim();
  const amountMinor = /^\d{1,7}(\.\d{1,2})?$/.test(amountText) ? parseAmount(amountText) : null;
  if (amountMinor === null || amountMinor < LIMITS.amountMinMinor || amountMinor > LIMITS.amountMaxMinor) {
    errors.amount = 'Enter the amount as a number such as 48.00 (0.01 to 9999999.99).';
  }
  const currency = input.currency.trim();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a three-letter currency code such as HKD.';
  if (Object.keys(errors).length > 0 || invoiceDate === null || amountMinor === null) return { ok: false, errors };
  return { ok: true, values: { supplierName, invoiceNumber: invoiceNumber === '' ? null : invoiceNumber, invoiceDate, amountMinor, currency } };
}
