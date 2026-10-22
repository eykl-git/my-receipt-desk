/**
 * Money in integer minor units (S7). No binary floating-point arithmetic is
 * used for conversion: text is split on the decimal point and the parts are
 * combined as integers.
 */
import { LIMITS } from './limits';

const PLAIN = /^(-?)(\d{1,9})(?:\.(\d{1,2}))?$/;
const GROUPED = /^(-?)(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a decimal amount ("120.00", "-48", "1,234.5") into signed minor units.
 * Returns null for anything else (no exponent, no currency symbols, no spaces,
 * at most two decimals). The magnitude is not range-checked here; see
 * `isAmountInRange`.
 */
export function parseAmount(text: string): number | null {
  const m = PLAIN.exec(text) ?? GROUPED.exec(text);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const whole = (m[2] ?? '').replace(/,/g, '');
  const frac = (m[3] ?? '').padEnd(2, '0');
  if (whole.length > 9) return null;
  const minor = Number(whole) * 100 + Number(frac);
  if (!Number.isSafeInteger(minor)) return null;
  return minor === 0 ? 0 : sign * minor;
}

/** Format minor units as `-?\d+\.\d{2}` (no symbol, no thousands separator). */
export function formatMinor(minor: number): string {
  assertMinor(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${frac.toString().padStart(2, '0')}`;
}

/** Human display, e.g. "HKD 48.00". */
export function formatMoney(minor: number, currency: string): string {
  return `${currency} ${formatMinor(minor)}`;
}

/** Integer sum; throws if any value or the total is not a safe integer. */
export function sumMinor(values: readonly number[]): number {
  let total = 0;
  for (const v of values) {
    assertMinor(v);
    total += v;
    assertMinor(total);
  }
  return total;
}

/** True when an item amount is within the supported range (1…999,999,999 minor units). */
export function isAmountInRange(minor: number): boolean {
  return Number.isSafeInteger(minor) && minor >= LIMITS.amountMinMinor && minor <= LIMITS.amountMaxMinor;
}

function assertMinor(v: number): void {
  if (!Number.isSafeInteger(v)) throw new RangeError(`Not an integer number of minor units: ${String(v)}`);
}
