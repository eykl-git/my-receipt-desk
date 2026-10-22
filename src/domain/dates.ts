/**
 * Date-only values (S7). Dates are `YYYY-MM-DD` strings that must be real
 * calendar dates. Nothing here calls `new Date(text)` or `Date.parse`, so an
 * ambiguous date is never silently guessed: non-ISO text needs an explicit
 * format.
 */
import { LIMITS } from './limits';

declare const isoDateBrand: unique symbol;
export type IsoDate = string & { readonly [isoDateBrand]: true };

export type DateFormat = 'YYYY-MM-DD' | 'DD/MM/YYYY' | 'MM/DD/YYYY';
export const DATE_FORMATS: readonly DateFormat[] = Object.freeze(['YYYY-MM-DD', 'DD/MM/YYYY', 'MM/DD/YYYY']);

const STRICT_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
const MS_PER_DAY = 86_400_000;

export function isRealDate(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  return day <= daysInMonth(year, month);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** Type guard: strict `YYYY-MM-DD` that is a real calendar date. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string') return false;
  const m = STRICT_ISO.exec(value);
  if (!m) return false;
  return isRealDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/** Strict ISO parse; returns null for anything else. */
export function toIsoDate(value: string): IsoDate | null {
  return isIsoDate(value) ? value : null;
}

function makeIso(year: number, month: number, day: number): IsoDate | null {
  if (!isRealDate(year, month, day)) return null;
  const s = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return s as IsoDate;
}

/**
 * Parse text with an explicitly chosen format. There is no default format and
 * no fallback: `03/04/2026` means 3 April with DD/MM/YYYY and 4 March with
 * MM/DD/YYYY, so the caller must choose.
 */
export function parseDateWithFormat(text: string, format: DateFormat): IsoDate | null {
  const t = text.trim();
  if (format === 'YYYY-MM-DD') return toIsoDate(t);
  const m = SLASHED.exec(t);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const year = Number(m[3]);
  return format === 'DD/MM/YYYY' ? makeIso(year, b, a) : makeIso(year, a, b);
}

/** True iff every non-empty cell is a strict ISO real date (the only case where a format may be pre-selected). */
export function allStrictIso(cells: readonly string[]): boolean {
  const nonEmpty = cells.map((c) => c.trim()).filter((c) => c !== '');
  return nonEmpty.length > 0 && nonEmpty.every((c) => isIsoDate(c));
}

function utcDay(date: IsoDate): number {
  const m = STRICT_ISO.exec(date);
  if (!m) throw new RangeError(`Not an ISO date: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / MS_PER_DAY;
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return utcDay(to) - utcDay(from);
}

/** Supported date range for user-entered and imported dates (design §13). */
export function isDateInSupportedRange(date: IsoDate): boolean {
  return date >= LIMITS.dateMin && date <= LIMITS.dateMax;
}
