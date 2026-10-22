/**
 * "Save fields" (design §10.1): validate the four values, then confirm all of
 * them. Originals are never overwritten; a correction is stored only where the
 * value differs from the original (and entering the original again clears it).
 */
import { isDateInSupportedRange, toIsoDate, type IsoDate } from '../dates';
import { LIMITS } from '../limits';
import { parseAmount } from '../money';
import { canonicalMerchantId } from '../normalize';
import { LOCAL_OWNER } from '../primitives';
import { FIELD_NAMES, type FieldName, type Receipt } from '../schemas';
import { effectiveFields, type EffectiveFields } from './fields';

export interface FieldInput {
  merchant: string;
  date: string;
  amount: string;
  currency: string;
}

export interface ValidFields {
  merchant: string;
  date: IsoDate;
  amountMinor: number;
  currency: string;
}

export type FieldErrors = Partial<Record<FieldName, string>>;

export function validateFieldInput(input: FieldInput): { ok: true; values: ValidFields } | { ok: false; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const merchant = input.merchant.trim();
  if (merchant.length < LIMITS.merchantMinChars || merchant.length > LIMITS.merchantMaxChars) {
    errors.merchant = `Merchant must be ${LIMITS.merchantMinChars}–${LIMITS.merchantMaxChars} characters.`;
  }
  const date = toIsoDate(input.date.trim());
  if (date === null || !isDateInSupportedRange(date)) errors.date = `Enter a real date between ${LIMITS.dateMin} and ${LIMITS.dateMax}.`;
  const amountText = input.amount.trim();
  const amountMinor = /^\d{1,7}(\.\d{1,2})?$/.test(amountText) ? parseAmount(amountText) : null;
  if (amountMinor === null || amountMinor < LIMITS.amountMinMinor || amountMinor > LIMITS.amountMaxMinor) {
    errors.amountMinor = 'Enter the amount as a number such as 48.00 (0.01 to 9999999.99).';
  }
  const currency = input.currency.trim();
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = 'Use a three-letter currency code such as HKD.';
  if (Object.keys(errors).length > 0 || date === null || amountMinor === null) return { ok: false, errors };
  return { ok: true, values: { merchant, date, amountMinor, currency } };
}

export interface FieldConfirmation {
  receipt: Receipt;
  /** Fields whose effective value changed. */
  changed: FieldName[];
  before: Partial<EffectiveFields>;
  after: Partial<EffectiveFields>;
}

export function applyFieldConfirmation(receipt: Receipt, values: ValidFields, at: string): FieldConfirmation {
  const current = effectiveFields(receipt);
  const next = structuredClone(receipt);
  const changed: FieldName[] = [];
  const before: Partial<EffectiveFields> = {};
  const after: Partial<EffectiveFields> = {};
  for (const name of FIELD_NAMES) {
    const field = next.fields[name] as { original: { value: unknown }; correction: { value: unknown; at: string; by: typeof LOCAL_OWNER } | null; confirmedAt: string | null };
    const value = values[name];
    if (value === field.original.value) field.correction = null;
    else if (value !== current[name]) field.correction = { value, at, by: LOCAL_OWNER };
    field.confirmedAt = at;
    if (value !== current[name]) {
      changed.push(name);
      (before as Record<string, unknown>)[name] = current[name];
      (after as Record<string, unknown>)[name] = value;
    }
  }
  next.canonicalMerchantId = canonicalMerchantId(values.merchant);
  next.updatedAt = at;
  return { receipt: next, changed, before, after };
}
