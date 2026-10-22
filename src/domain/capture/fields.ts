/**
 * Effective receipt values and the capture dimension (design §4, §5).
 * Effective value = correction?.value ?? original.value. The original is never overwritten.
 */
import type { IsoDate } from '../dates';
import { formatMoney } from '../money';
import { normalizeLabel } from '../normalize';
import { CurrencyCodeSchema, IsoDateSchema, MinorUnitsSchema, type CaptureStatus } from '../primitives';
import { FIELD_NAMES, MerchantValueSchema, type FieldName, type Receipt } from '../schemas';

export interface EffectiveFields {
  merchant: string | null;
  date: IsoDate | null;
  amountMinor: number | null;
  currency: string | null;
}

export const FIELD_LABELS: Readonly<Record<FieldName, string>> = Object.freeze({
  merchant: 'Merchant',
  date: 'Date',
  amountMinor: 'Amount',
  currency: 'Currency',
});

type AnyReceiptField = Receipt['fields'][FieldName];

function effective<T>(field: { original: { value: T | null }; correction: { value: T } | null }): T | null {
  return field.correction ? field.correction.value : field.original.value;
}

export function effectiveFields(receipt: Receipt): EffectiveFields {
  return {
    merchant: effective(receipt.fields.merchant),
    date: effective(receipt.fields.date),
    amountMinor: effective(receipt.fields.amountMinor),
    currency: effective(receipt.fields.currency),
  };
}

const VALUE_SCHEMAS = {
  merchant: MerchantValueSchema,
  date: IsoDateSchema,
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
} as const;

export type FieldIssueKind = 'missing' | 'unclear' | 'invalid' | 'unconfirmed';
export interface FieldIssue {
  field: FieldName;
  kind: FieldIssueKind;
  message: string;
}

function issueFor(name: FieldName, field: AnyReceiptField): FieldIssue | null {
  const value = effective<unknown>(field as { original: { value: unknown }; correction: { value: unknown } | null });
  const label = FIELD_LABELS[name];
  if (value === null || value === undefined) {
    if (field.original.clarity === 'unclear' && field.correction === null) {
      const raw = field.original.raw;
      const readAs = raw ? ` (read as “${raw}”)` : '';
      return { field: name, kind: 'unclear', message: `${label} is unclear on the receipt${readAs}. Check the image and enter it.` };
    }
    return { field: name, kind: 'missing', message: `${label} is missing. Enter it from the receipt.` };
  }
  if (!VALUE_SCHEMAS[name].safeParse(value).success) {
    return { field: name, kind: 'invalid', message: `${label} is not valid. Check the receipt and correct it.` };
  }
  const preReviewedFixture =
    field.correction === null && field.original.clarity === 'clear' && field.original.provenance.kind === 'demo-fixture';
  if (!preReviewedFixture && field.confirmedAt === null) {
    return { field: name, kind: 'unconfirmed', message: `${label} needs your confirmation.` };
  }
  return null;
}

/** Every field that keeps capture from being validated, in fixed field order. */
export function fieldIssues(receipt: Receipt): FieldIssue[] {
  const out: FieldIssue[] = [];
  for (const name of FIELD_NAMES) {
    const issue = issueFor(name, receipt.fields[name]);
    if (issue) out.push(issue);
  }
  return out;
}

/**
 * Capture is `validated` iff all four fields have an effective value that passes
 * its schema and each is either a clear demo-fixture value (pre-reviewed
 * fictional example, A3) or explicitly confirmed by the user. Output from any
 * OCR or model adapter always needs confirmation.
 */
export function captureStatus(receipt: Receipt): CaptureStatus {
  return fieldIssues(receipt).length === 0 ? 'validated' : 'needs_review';
}

export function normalizedMerchant(receipt: Receipt): string | null {
  const m = effectiveFields(receipt).merchant;
  return m === null ? null : normalizeLabel(m);
}

/** Short human summary of a receipt's amount ("HKD 48.00", "Unclear", "Missing"). */
export function amountSummary(receipt: Receipt): string {
  const f = effectiveFields(receipt);
  if (f.amountMinor === null) return receipt.fields.amountMinor.original.clarity === 'unclear' ? 'Unclear' : 'Missing';
  return formatMoney(f.amountMinor, f.currency ?? '???');
}
