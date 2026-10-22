/** Display helpers. Untrusted values are returned as strings and rendered as React text only. */
import { effectiveFields } from '../domain/capture/fields';
import { categoryName } from '../domain/categories';
import { formatMoney } from '../domain/money';
import type { Receipt, StatementTransaction } from '../domain/schemas';
import { displayRef } from '../domain/matching/helpers';
import { COPY } from './copy';
import { store } from './store';
import { LIMITS } from '../domain/limits';

/** "MYR 12.50"; a currency other than the workspace's is marked "(not supported)" (never converted). */
export function receiptAmount(r: Receipt, workspaceCurrency: string = store.snapshot(r.workspaceId).currency): string {
  const f = effectiveFields(r);
  if (f.amountMinor === null) return r.fields.amountMinor.original.clarity === 'unclear' ? COPY.unclear : COPY.missing;
  const text = formatMoney(f.amountMinor, f.currency ?? '');
  return f.currency !== null && f.currency !== workspaceCurrency ? COPY.notSupported(text) : text;
}

export function receiptMerchant(r: Receipt): string {
  return effectiveFields(r).merchant ?? COPY.missing;
}

export function receiptDate(r: Receipt): string {
  return effectiveFields(r).date ?? (r.fields.date.original.clarity === 'unclear' ? COPY.unclear : COPY.missing);
}

export function txAmount(t: StatementTransaction): string {
  return formatMoney(t.amountMinor, t.currency);
}

/** The Reference, else "Row {n} of {file name}" for a card row without one (review-3 N4). */
export function txRef(t: StatementTransaction): string {
  if (t.reference !== null) return displayRef(t);
  const doc = store.snapshot(t.workspaceId).sourceDocuments.find((d) => d.id === t.sourceDocumentId);
  return doc ? COPY.txRow(t.rowNumber, doc.fileName.slice(0, LIMITS.fileNameDisplayChars)) : displayRef(t);
}

/**
 * Class for the reference slot of a list row. A "Row {n} of {file name}"
 * reference can be long, so it gets its own line below the card label instead
 * of squeezing the label out of the row (S4 review finding 1).
 */
export function txRefClass(t: StatementTransaction): string {
  return t.reference === null ? 'mono item-ref-line' : 'mono';
}

/** "2026-03-31 09:00 UTC" (ISO-based, no locale guessing). */
export function formatAt(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** A total in the workspace currency, e.g. "HKD 48.00" or "MYR 23.00". */
export function money(minor: number, currency: string): string {
  return formatMoney(minor, currency);
}

export function categoryLabel(id: string | null): string {
  return id === null ? '' : categoryName(id as never);
}
