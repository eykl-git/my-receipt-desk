/** Label normalisation and derived identities (design §4). */

/** NFKC → uppercase → anything outside [A-Z0-9&' ] becomes a space → collapse → trim. */
export function normalizeLabel(text: string): string {
  return text
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[^A-Z0-9&' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Store-number stem (brief §25 D): a normalised label without at most ONE
 * trailing token of 1–6 digits. Normalisation already turned a `#` into a
 * space, so "PACIFIC COFFEE #042" → "PACIFIC COFFEE 042" → "PACIFIC COFFEE".
 * A label that is only digits, or whose last token has letters, is unchanged.
 */
export function storeNumberStem(normalizedLabel: string): string {
  return normalizedLabel.replace(/ \d{1,6}$/, '');
}

/**
 * A canonical merchant ID with at least one comparable character. Names with no
 * Latin letters or digits (for example "大家樂") normalise to an empty label and
 * the ID "m:"; such names can never establish identity or carry a preference.
 */
export const CANONICAL_MERCHANT_ID = /^m:[a-z0-9&'-]+$/;

export function isCanonicalMerchantId(id: string): boolean {
  return CANONICAL_MERCHANT_ID.test(id);
}

function slug(text: string): string {
  return normalizeLabel(text).toLowerCase().replace(/ /g, '-');
}

/** e.g. "Morning Cup" → "m:morning-cup". */
export function canonicalMerchantId(name: string): string {
  return `m:${slug(name)}`;
}

/** e.g. "Demo Card ••1234" → "demo-card-1234". */
export function accountSlug(name: string): string {
  return slug(name);
}

/** e.g. "Demo Card ••1234" → "acct:demo-card-1234". */
export function accountId(name: string): string {
  return `acct:${accountSlug(name)}`;
}
