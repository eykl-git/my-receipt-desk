/**
 * Plain-English rule bar (brief §10 and §25 B, task 3.5, REQ-9.1). This is a
 * constrained sentence-pattern matcher, not general language understanding.
 * It recognises a few fixed patterns and fills the fields of the structured
 * form. The result is only a draft ("Rule draft—review required"): it goes
 * through the same panel, `validateDraft`, "Preview impact" and explicit
 * "Activate rule" as every other draft. It never writes, activates or records.
 *
 * Phrases asking to relax a built-in safety check are refused with the name
 * of that check. Anything else is "can't be interpreted" and the caller opens
 * the structured form.
 */
import { CATEGORIES, type CategoryId } from '../categories';

export const PHRASE_MAX_CHARS = 200;
export const PHRASE_UNRECOGNISED = "This phrase can't be interpreted. Use the form below.";

/** Examples shown under the input; each one parses to a draft. */
export const PHRASE_EXAMPLES: readonly string[] = Object.freeze([
  'Remember MC COFFEE HK as Morning Cup.',
  'Put Morning Cup purchases under Dining.',
  'Allow card posting up to 5 days after the receipt.',
  'Remember PACIFIC COFFEE #042 as Pacific Coffee, ignoring store numbers.',
]);

export type PhraseDraftFields =
  | { type: 'merchant_alias'; observedLabel: string; merchantName: string; ignoreStoreNumber?: true }
  | { type: 'category_preference'; merchantName: string; categoryId: CategoryId | '' }
  | { type: 'posting_window'; days: number };

export type PhraseResult =
  | { kind: 'draft'; fields: PhraseDraftFields }
  | { kind: 'refused'; check: string; invariantId: string | null; message: string }
  | { kind: 'unrecognised'; message: string };

/** Built-in checks a sentence cannot relax, tested in this order. */
const REFUSALS: ReadonlyArray<{ check: string; invariantId: string | null; pattern: RegExp }> = [
  {
    check: 'recording only after you confirm',
    invariantId: null,
    pattern:
      /\bmark\b.*\bpaid\b|\bauto(?:matically)?[\s-]*(?:approve|record|match|confirm|accept)\w*|\bskip\s+(?:the\s+)?(?:review|confirmation)\b|\bwithout\s+(?:review|reviewing|asking|checking|confirm\w*)\b|\b(?:approve|record|confirm|accept)\s+(?:everything|all)\b|\bignore\s+the\s+rules\b/i,
  },
  {
    check: 'exact amount',
    invariantId: 'S-2',
    pattern: /\b(?:ignore|skip)\b.*\bamounts?\b|\bamounts?\s+(?:differences?|tolerance|mismatch\w*)\b|\bwithin\s+(?:\$|hk\$|hkd\b|\d)|\btolerance\b|\bclose\s+enough\b|\bround(?:ing|ed)?\b/i,
  },
  {
    check: 'same currency with no conversion',
    invariantId: 'S-1',
    pattern: /\bconver(?:t|ts|ted|ting|sion)\b|\bexchange\s+rates?\b|\bfx\b|\b(?:any|other|all|foreign)\s+currenc(?:y|ies)\b|\bas\s+hkd\b/i,
  },
  {
    check: 'exact card labels',
    invariantId: 'S-9',
    pattern: /\*|\banything\b|\b(?:contains?|containing|starting\s+with|starts\s+with|ends?\s+with|begins?\s+with)\b|\bany\s+(?:label|name)\b/i,
  },
  {
    check: 'duplicate checks',
    invariantId: 'S-6',
    pattern: /\b(?:ignore|skip|disable|turn\s+off)\b.*\bduplicates?\b/i,
  },
  {
    check: 'sending more than one plausible match to you',
    invariantId: 'S-4',
    pattern: /\b(?:pick|choose|take)\s+(?:the\s+)?first\b|\b(?:ignore|skip|disable|turn\s+off)\b.*\bambigu\w*/i,
  },
];

const QUOTES = /^["'“”‘’]+|["'“”‘’]+$/g;

function clean(part: string): string {
  return part.replace(QUOTES, '').trim();
}

function category(text: string): CategoryId | '' {
  const t = text.trim().toLowerCase();
  const hit = CATEGORIES.find((c) => c.id === t || c.name.toLowerCase() === t || c.name.toLowerCase().split(/[\s&]+/)[0] === t);
  return hit ? hit.id : '';
}

export function parseRulePhrase(input: string): PhraseResult {
  const unrecognised: PhraseResult = { kind: 'unrecognised', message: PHRASE_UNRECOGNISED };
  const text = input.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').trim();
  if (text === '' || text.length > PHRASE_MAX_CHARS) return unrecognised;

  for (const r of REFUSALS) {
    if (r.pattern.test(text)) {
      return { kind: 'refused', check: r.check, invariantId: r.invariantId, message: `This can't become a rule: ${r.check} is a built-in safety check.` };
    }
  }

  // "…, ignoring store numbers" selects the store-number match type (brief §25 B, D).
  const storeSuffix = /,?\s+ignoring\s+(?:the\s+)?store\s+numbers?$/i;
  const ignoreStoreNumber = storeSuffix.test(text);
  const aliasText = text.replace(storeSuffix, '').trim();
  const alias = /^(?:remember|treat)\s+(.+?)\s+as\s+(.+)$/i.exec(aliasText);
  if (alias) {
    const observedLabel = clean(alias[1]!);
    const merchantName = clean(alias[2]!);
    if (observedLabel === '' || merchantName === '') return unrecognised;
    return { kind: 'draft', fields: { type: 'merchant_alias', observedLabel, merchantName, ...(ignoreStoreNumber ? { ignoreStoreNumber: true as const } : {}) } };
  }
  if (ignoreStoreNumber) return unrecognised;

  const cat = /^put\s+(.+?)\s+purchases\s+under\s+(.+)$/i.exec(text);
  if (cat) {
    const merchantName = clean(cat[1]!);
    const categoryText = clean(cat[2]!);
    if (merchantName === '' || categoryText === '') return unrecognised;
    return { kind: 'draft', fields: { type: 'category_preference', merchantName, categoryId: category(categoryText) } };
  }

  const window = /^allow\s+card\s+posting\s+up\s+to\s+(\d{1,3})\s+days?\s+after\s+the\s+receipt$/i.exec(text);
  if (window) return { kind: 'draft', fields: { type: 'posting_window', days: Number(window[1]) } };

  return unrecognised;
}
