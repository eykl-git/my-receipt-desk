/**
 * OCR receipt text parser (brief §27, ocr-design.md §2.2). Pure and
 * deterministic. Receipt text is untrusted data: it is matched against fixed
 * patterns to propose four field values and nothing else. The result holds
 * data only (fields, locale, notes); there is no action type and no callback,
 * so instruction-like lines change nothing. Every field carries provenance
 * 'ocr' and stays unconfirmed until the user saves it (A3).
 */
import type { ExtractedField } from './adapter';
import { isDateInSupportedRange, isRealDate, type IsoDate } from '../dates';
import { LIMITS } from '../limits';
import { formatMinor, isAmountInRange, parseAmount } from '../money';
import { detectedRegions, detectReceiptLocale, type ReceiptLocale } from './ocrLocale';

export interface OcrWord {
  readonly text: string;
  /** 0–100, as reported by the engine. */
  readonly confidence: number;
}
export interface OcrLine {
  readonly text: string;
  readonly words: readonly OcrWord[];
}
export interface OcrParseHints {
  /** Written into every field's provenance, e.g. OCR_ADAPTER_ID. */
  readonly adapterId: string;
  /** Words below this are "hard to read" and make their field unclear. Default OCR_MIN_WORD_CONFIDENCE. */
  readonly minWordConfidence?: number;
}
export const OCR_MIN_WORD_CONFIDENCE = 70;

export interface ParsedReceiptFields {
  readonly merchant: ExtractedField<string>;
  readonly date: ExtractedField<IsoDate>;
  readonly amountMinor: ExtractedField<number>;
  readonly currency: ExtractedField<string>;
}
export interface ParsedReceipt {
  readonly fields: ParsedReceiptFields;
  readonly locale: ReceiptLocale;
  /** Plain-English notes for display, e.g. both readings of an ambiguous date. Never actions. */
  readonly notes: readonly string[];
}

/** `ExtractedField.raw` must fit `extractedFieldSchema` (≤ 200 chars). */
const RAW_MAX_CHARS = 200;
const MERCHANT_TOP_LINES = 5;
const MASK_CHAR = '\u2588';

// ---------------------------------------------------------------------------
// Canonical lines: words joined by single spaces (none between two CJK
// characters), with a char → word map so a matched span knows which words it
// touches.

interface Canon {
  readonly text: string;
  /** owner[i] = index into `scores` of the word that produced char i, or -1 for a separator. */
  readonly owner: readonly number[];
  readonly scores: readonly number[];
}

const CJK = /[\p{Script=Han}\u3000-\u303f]/u;
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0x2060, 0xfeff]);

/** Drops control and zero-width characters (they are never part of a field). */
function dropInvisible(text: string): string {
  return Array.from(text)
    .filter((ch) => {
      const cp = ch.codePointAt(0) ?? 0;
      return cp >= 0x20 && cp !== 0x7f && !ZERO_WIDTH.has(cp);
    })
    .join('');
}

function firstChar(s: string): string {
  return Array.from(s)[0] ?? '';
}
function lastChar(s: string): string {
  const chars = Array.from(s);
  return chars[chars.length - 1] ?? '';
}

function tokensOf(line: OcrLine): { text: string; score: number }[] {
  // A line without word data is still read, but every word counts as hard to read.
  const source = line.words.length > 0 ? line.words : [{ text: line.text, confidence: 0 }];
  const out: { text: string; score: number }[] = [];
  for (const w of source) {
    const score = Number.isFinite(w.confidence) ? w.confidence : 0;
    for (const piece of dropInvisible(w.text.normalize('NFKC').replace(/\s+/g, ' ')).split(' ')) {
      if (piece !== '') out.push({ text: piece, score });
    }
  }
  return out;
}

function canonLine(line: OcrLine): Canon {
  const tokens = tokensOf(line);
  let text = '';
  const owner: number[] = [];
  tokens.forEach((t, i) => {
    const prev = tokens[i - 1];
    if (prev && !(CJK.test(lastChar(prev.text)) && CJK.test(firstChar(t.text)))) {
      text += ' ';
      owner.push(-1);
    }
    for (let k = 0; k < t.text.length; k++) owner.push(i);
    text += t.text;
  });
  return { text, owner, scores: tokens.map((t) => t.score) };
}

/** Lowest word score among the words that the span [start, end) touches (0 when it touches none). */
function spanScore(c: Canon, start: number, end: number): number {
  let min = Infinity;
  for (let i = start; i < end; i++) {
    const w = c.owner[i];
    if (w !== undefined && w >= 0) min = Math.min(min, c.scores[w] ?? 0);
  }
  return min === Infinity ? 0 : min;
}

function canonLines(lines: readonly OcrLine[]): Canon[] {
  return lines.map(canonLine).filter((c) => c.text !== '');
}

/** NFKC-normalised receipt text (lines joined with "\n", spaces between CJK characters removed), as passed to detectReceiptLocale. */
export function receiptText(lines: readonly OcrLine[]): string {
  return canonLines(lines)
    .map((c) => c.text)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Masking: phone numbers, registration numbers, times and document numbers are
// blanked out (same length, so positions still line up) before any date or
// amount is matched.

type MaskKind = 'phone' | 'registration' | 'time' | 'document-number';

const MASKS: readonly { kind: MaskKind; re: RegExp }[] = [
  { kind: 'phone', re: /\+\s?\d{1,3}(?:[\s-]?\(?\d\)?){6,12}/g },
  { kind: 'phone', re: /(?<![A-Za-z])(?:Tel|Telefon|Phone|Fax|H\/P)\.?\s*(?:No\.?)?\s*:?\s*[\d\s()+-]{6,}\d/gi },
  { kind: 'phone', re: /(?:電話|电话|傳真|传真)\s*:?\s*[\d\s()+-]{6,}\d/g },
  { kind: 'registration', re: /(?<!\d)(?:19|20)\d{10}(?!\d)/g },
  { kind: 'registration', re: /(?<![\dA-Za-z])\d{6,7}-[A-Z](?![A-Za-z\d])/g },
  { kind: 'time', re: /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?(?!\d)/g },
  {
    kind: 'document-number',
    re: /(?:(?<![A-Za-z])(?:Invoice|Invois|Inv|Receipt|Resit|Bill|Order|Txn|Trans|Ref|Doc)\.?\s*(?:No|Number|Num|#)\.?|(?<![A-Za-z])No\.?(?:\s*(?:Resit|Invois|Bil|Receipt|Invoice))?|#|單號|单号|發票號碼|发票号码|收據號碼|收据号码|單據號碼|单据号码|編號|编号)\s*[:.]?\s*[A-Za-z0-9][A-Za-z0-9/-]*/gi,
  },
];

interface Masked {
  readonly text: string;
  readonly kinds: ReadonlySet<MaskKind>;
}

function mask(text: string): Masked {
  const chars = text.split('');
  const kinds = new Set<MaskKind>();
  for (const { kind, re } of MASKS) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m[0].trim() === '') continue;
      kinds.add(kind);
      for (let i = m.index; i < m.index + m[0].length; i++) chars[i] = MASK_CHAR;
    }
  }
  return { text: chars.join(''), kinds };
}

// ---------------------------------------------------------------------------
// Shared helpers

type Provenance = ExtractedField<unknown>['provenance'];

function clip(text: string, max = RAW_MAX_CHARS): string {
  return text.length <= max ? text : text.slice(0, max);
}
function clear<T>(value: T, raw: string, provenance: Provenance): ExtractedField<T> {
  return { value, raw: clip(raw), clarity: 'clear', provenance };
}
function unclear<T>(raw: string, provenance: Provenance): ExtractedField<T> {
  return { value: null, raw: clip(raw), clarity: 'unclear', provenance };
}
function missing<T>(provenance: Provenance): ExtractedField<T> {
  return { value: null, raw: null, clarity: 'missing', provenance };
}

interface Line {
  readonly canon: Canon;
  readonly masked: Masked;
}

// ---------------------------------------------------------------------------
// Merchant

const MERCHANT_SUFFIX = /(?<![A-Za-z])(?:Sdn\.?\s*Bhd|Bhd|Berhad)(?![A-Za-z])|有限公司|商行|餐廳|餐厅|酒樓|酒楼|茶室/i;
const REG_NO = '(?:(?:19|20)\\d{10}|\\d{6,7}-[A-Z])';
const TRAILING_REGISTRATION = new RegExp(
  `\\s*[(\\[（]\\s*(?:No\\.?\\s*)?${REG_NO}(?:\\s*[/,]\\s*${REG_NO})?\\s*[)\\]）]\\s*$`,
);
const HEADING =
  /^(?:Resit(?:\s+Rasmi)?|(?:Official\s+)?Receipt|(?:Tax\s+)?Invoice|Cash\s+(?:Bill|Sale)|Bil\s+Tunai|收據|收据|發票|发票|收銀單|收银单)[\s.:]*$/i;
const ADDRESS_LABEL = /^(?:(?:Address|Alamat)(?![A-Za-z])|地址)/i;
const ANY_DATE = /(?<!\d)\d{4}\s*年|(?<![\d/.-])\d{1,4}[-/]\d{1,2}[-/]\d{2,4}(?![\d/-])/;

function letterCount(text: string): number {
  return (text.match(/\p{L}/gu) ?? []).length;
}

/** The merchant text on a line: trimmed, with a trailing bracketed registration number removed. */
function merchantSpan(line: Line): { start: number; end: number } {
  const text = line.canon.text;
  const reg = TRAILING_REGISTRATION.exec(text);
  let end = reg ? reg.index : text.length;
  let start = 0;
  while (start < end && /\s/.test(text[start] ?? '')) start++;
  while (end > start && /\s/.test(text[end - 1] ?? '')) end--;
  return { start, end };
}

function isMeaningfulTopLine(line: Line, span: { start: number; end: number }): boolean {
  const own = line.canon.text.slice(span.start, span.end);
  if (HEADING.test(own) || ADDRESS_LABEL.test(own) || ANY_DATE.test(own)) return false;
  if (line.masked.kinds.size > 0) return false; // phone, registration, time or document number
  return letterCount(own) >= 2;
}

function parseMerchant(lines: readonly Line[], provenance: Provenance, minScore: number, notes: string[]): ExtractedField<string> {
  const chosen =
    lines.find((l) => MERCHANT_SUFFIX.test(l.canon.text)) ??
    lines.slice(0, MERCHANT_TOP_LINES).find((l) => isMeaningfulTopLine(l, merchantSpan(l)));
  if (!chosen) return missing(provenance);
  const span = merchantSpan(chosen);
  const value = chosen.canon.text.slice(span.start, span.end);
  if (value === '') return missing(provenance);
  if (value.length > LIMITS.merchantMaxChars) {
    notes.push(`Merchant name is longer than ${LIMITS.merchantMaxChars} characters. Check the receipt.`);
    return unclear(value, provenance);
  }
  if (spanScore(chosen.canon, span.start, span.end) < minScore) {
    notes.push('Merchant name is hard to read. Check the receipt.');
    return unclear(value, provenance);
  }
  return clear(value, value, provenance);
}

// ---------------------------------------------------------------------------
// Date

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const YMD_CJK = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
const YMD = /(?<![\d/.-])(\d{4})([-/])(\d{1,2})\2(\d{1,2})(?![\d/-])/g;
const DMY = /(?<![\d/.-])(\d{1,2})([-/])(\d{1,2})\2(\d{4}|\d{2})(?![\d/-])/g;

type DateReading =
  | { readonly kind: 'date'; readonly iso: IsoDate }
  | { readonly kind: 'ambiguous'; readonly note: string }
  | { readonly kind: 'problem'; readonly note: string };

interface DateCandidate {
  readonly raw: string;
  readonly score: number;
  readonly reading: DateReading;
}

function isoOf(year: number, month: number, day: number): IsoDate | null {
  if (!isRealDate(year, month, day)) return null;
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` as IsoDate;
  return isDateInSupportedRange(iso) ? iso : null;
}

function spoken(year: number, month: number, day: number): string {
  return `${day} ${MONTH_NAMES[month - 1] ?? ''} ${year}`;
}

const NOT_A_DATE: DateReading = { kind: 'problem', note: "The date doesn't look like a real date. Check the receipt." };

function yearFirst(year: number, month: number, day: number): DateReading {
  const iso = isoOf(year, month, day);
  return iso ? { kind: 'date', iso } : NOT_A_DATE;
}

function dayFirst(a: number, b: number, yearText: string, regionKnown: boolean): DateReading {
  if (yearText.length !== 4) return { kind: 'problem', note: 'The date has a two-digit year. Check the receipt.' };
  if (!regionKnown) {
    return {
      kind: 'problem',
      note: "The date order (day first or month first) can't be told from this receipt. Check the receipt.",
    };
  }
  const year = Number(yearText);
  if (a <= 12 && b <= 12 && a !== b) {
    const asDayFirst = isoOf(year, b, a);
    const asMonthFirst = isoOf(year, a, b);
    if (asDayFirst && asMonthFirst) {
      return {
        kind: 'ambiguous',
        note: `Date could be ${spoken(year, b, a)} or ${spoken(year, a, b)}. Check the receipt.`,
      };
    }
  }
  const iso = isoOf(year, b, a);
  return iso ? { kind: 'date', iso } : NOT_A_DATE;
}

function dateCandidates(lines: readonly Line[], regionKnown: boolean): DateCandidate[] {
  const out: DateCandidate[] = [];
  for (const line of lines) {
    const found: { index: number; raw: string; score: number; reading: DateReading }[] = [];
    const add = (m: RegExpMatchArray, reading: DateReading) => {
      const index = m.index ?? 0;
      found.push({ index, raw: m[0], score: spanScore(line.canon, index, index + m[0].length), reading });
    };
    const t = line.masked.text;
    for (const m of t.matchAll(YMD_CJK)) add(m, yearFirst(Number(m[1]), Number(m[2]), Number(m[3])));
    for (const m of t.matchAll(YMD)) add(m, yearFirst(Number(m[1]), Number(m[3]), Number(m[4])));
    for (const m of t.matchAll(DMY)) add(m, dayFirst(Number(m[1]), Number(m[3]), m[4] ?? '', regionKnown));
    found.sort((x, y) => x.index - y.index);
    for (const f of found) out.push({ raw: f.raw, score: f.score, reading: f.reading });
  }
  return out;
}

function parseDate(
  lines: readonly Line[],
  regionKnown: boolean,
  provenance: Provenance,
  minScore: number,
  notes: string[],
): ExtractedField<IsoDate> {
  const candidates = dateCandidates(lines, regionKnown);
  if (candidates.length === 0) return missing(provenance);
  const raw = candidates.map((c) => c.raw).join(', ');
  for (const c of candidates) {
    if (c.reading.kind !== 'date') {
      notes.push(c.reading.note);
      return unclear(raw, provenance);
    }
  }
  const dates = new Set(candidates.map((c) => (c.reading.kind === 'date' ? c.reading.iso : '')));
  if (dates.size > 1) {
    notes.push(`Found more than one date (${raw}). Check the receipt.`);
    return unclear(raw, provenance);
  }
  const first = candidates[0];
  if (!first || first.reading.kind !== 'date') return missing(provenance);
  if (Math.min(...candidates.map((c) => c.score)) < minScore) {
    notes.push('The date is hard to read. Check the receipt.');
    return unclear(raw, provenance);
  }
  return clear(first.reading.iso, first.raw, provenance);
}

// ---------------------------------------------------------------------------
// Total

const TOTAL_KEYWORD =
  /(?<![A-Za-z])(?:Jumlah\s+Besar|Grand\s+Total|Jumlah|Total)(?![A-Za-z])|合計|合计|總計|总计|總額|总额|應付|应付|實收|实收|總數|总数/i;
const TOTAL_EXCLUDED =
  /(?<![A-Za-z])(?:Tunai|Cash|Baki|Change|Sub\s*-?\s*Total|Rounding|Pembundaran|Discount|Diskaun)(?![A-Za-z])|現金|现金|找續|找续|找零|找赎|找贖|小計|小计|折扣/i;
/** A total line that mentions a service charge counts only when no larger total remains. */
const SERVICE_CHARGE = /服務費|服务费|(?<![A-Za-z])Service\s+Charge(?![A-Za-z])/i;
const AMOUNT = /(?<![\d.,])(?:\d{1,3}(?:,\d{3})+|\d{1,9})\.\d{2}(?!\d)/g;
const AMOUNT_ONLY_LINE = /^\s*(?:RM|MYR|HK\s?\$|HKD|\$|马币|令吉)?\s*((?:\d{1,3}(?:,\d{3})+|\d{1,9})\.\d{2})\s*$/;

interface TotalCandidate {
  /** Integer minor units, or null when the amount text could not be used. */
  readonly minor: number | null;
  readonly raw: string;
  readonly score: number;
  readonly service: boolean;
}

function amountOn(line: Line): { text: string; start: number } | null {
  let last: { text: string; start: number } | null = null;
  for (const m of line.masked.text.matchAll(AMOUNT)) last = { text: m[0], start: m.index };
  return last;
}

function totalCandidates(lines: readonly Line[]): TotalCandidate[] {
  const out: TotalCandidate[] = [];
  lines.forEach((line, i) => {
    const t = line.masked.text;
    if (!TOTAL_KEYWORD.test(t) || TOTAL_EXCLUDED.test(t)) return;
    const service = SERVICE_CHARGE.test(t);
    let source: Line = line;
    let found = amountOn(line);
    if (!found) {
      const next = lines[i + 1];
      const m = next ? AMOUNT_ONLY_LINE.exec(next.masked.text) : null;
      if (next && m?.[1] !== undefined) {
        source = next;
        found = { text: m[1], start: next.masked.text.indexOf(m[1]) };
      }
    }
    if (!found) {
      out.push({ minor: null, raw: line.canon.text, score: 0, service });
      return;
    }
    const minor = parseAmount(found.text);
    const usable = minor !== null && isAmountInRange(minor) ? minor : null;
    const score = spanScore(source.canon, found.start, found.start + found.text.length);
    out.push({ minor: usable, raw: found.text, score, service });
  });
  return out;
}

function parseTotal(lines: readonly Line[], provenance: Provenance, minScore: number, notes: string[]): ExtractedField<number> {
  const all = totalCandidates(lines);
  const regular = all.filter((c) => !c.service);
  const largestRegular = Math.max(-1, ...regular.map((c) => c.minor ?? -1));
  const kept = [
    ...regular,
    ...all.filter((c) => c.service && (c.minor === null ? largestRegular < 0 : c.minor >= largestRegular)),
  ];
  if (kept.length === 0) return missing(provenance);
  const usable = kept.filter((c): c is TotalCandidate & { minor: number } => c.minor !== null);
  const distinct = [...new Set(usable.map((c) => c.minor))].sort((a, b) => a - b);
  if (distinct.length > 1) {
    const listed = distinct.map(formatMinor).join(', ');
    notes.push(`Found more than one total (${listed}). Check the receipt.`);
    return unclear(listed, provenance);
  }
  const unusable = kept.find((c) => c.minor === null);
  const only = distinct[0];
  if (unusable || only === undefined) {
    notes.push('The total is hard to read. Check the receipt.');
    return unclear((unusable ?? kept[0])?.raw ?? '', provenance);
  }
  const raw = usable[0]?.raw ?? formatMinor(only);
  if (Math.min(...usable.map((c) => c.score)) < minScore) {
    notes.push('The total is hard to read. Check the receipt.');
    return unclear(raw, provenance);
  }
  return clear(only, raw, provenance);
}

// ---------------------------------------------------------------------------
// Currency

const MYR_MARK = /(?<![A-Za-z])(?:RM|MYR)(?![A-Za-z])|马币|馬幣|令吉/g;
const HKD_MARK = /(?<![A-Za-z])HK\s?\$|(?<![A-Za-z])HKD(?![A-Za-z])/g;

function marks(lines: readonly Line[], re: RegExp): { text: string; score: number }[] {
  const out: { text: string; score: number }[] = [];
  for (const line of lines) {
    for (const m of line.canon.text.matchAll(re)) {
      out.push({ text: m[0], score: spanScore(line.canon, m.index, m.index + m[0].length) });
    }
  }
  return out;
}

function parseCurrency(lines: readonly Line[], provenance: Provenance, minScore: number, notes: string[]): ExtractedField<string> {
  const myr = marks(lines, MYR_MARK);
  const hkd = marks(lines, HKD_MARK);
  if (myr.length > 0 && hkd.length > 0) {
    notes.push('Both MYR and HKD appear on the receipt. Check the currency.');
    return unclear(`${myr[0]?.text ?? ''}, ${hkd[0]?.text ?? ''}`, provenance);
  }
  const found = myr.length > 0 ? { code: 'MYR', hits: myr } : hkd.length > 0 ? { code: 'HKD', hits: hkd } : null;
  if (!found) return missing(provenance);
  const best = found.hits.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score < minScore) {
    notes.push('The currency is hard to read. Check the receipt.');
    return unclear(best.text, provenance);
  }
  return clear(found.code, best.text, provenance);
}

// ---------------------------------------------------------------------------

export function parseReceiptText(lines: readonly OcrLine[], hints: OcrParseHints): ParsedReceipt {
  const provenance: Provenance = { adapterId: hints.adapterId, kind: 'ocr' };
  const minScore = hints.minWordConfidence ?? OCR_MIN_WORD_CONFIDENCE;
  const parsed: Line[] = canonLines(lines).map((canon) => ({ canon, masked: mask(canon.text) }));
  const locale = detectReceiptLocale(parsed.map((l) => l.canon.text).join('\n'));
  const regionKnown = detectedRegions(locale).length > 0;
  const notes: string[] = [];
  const fields: ParsedReceiptFields = {
    merchant: parseMerchant(parsed, provenance, minScore, notes),
    date: parseDate(parsed, regionKnown, provenance, minScore, notes),
    amountMinor: parseTotal(parsed, provenance, minScore, notes),
    currency: parseCurrency(parsed, provenance, minScore, notes),
  };
  return { fields, locale, notes };
}
