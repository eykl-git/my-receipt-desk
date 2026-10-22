/**
 * Label similarity (brief §25 C, task 4.5). Pure and deterministic: token
 * overlap plus character-bigram Dice over normalised labels. It is used only to
 * ORDER near candidates in the case view and the manual picker. It never feeds
 * `evaluateWorkspace`, outcomes, groups or fingerprints, and no number from it
 * is ever shown: the only visible output is the hint "Shares the word “X”".
 */
import { normalizeLabel } from '../normalize';

function tokens(label: string): string[] {
  return normalizeLabel(label).split(' ').filter((t) => t.length > 0);
}

function bigrams(label: string): string[] {
  const s = normalizeLabel(label).replace(/ /g, '');
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice coefficient over character bigrams (multiset), 0…1. */
function dice(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.length === 0 || y.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of x) counts.set(g, (counts.get(g) ?? 0) + 1);
  let common = 0;
  for (const g of y) {
    const n = counts.get(g) ?? 0;
    if (n > 0) {
      common++;
      counts.set(g, n - 1);
    }
  }
  return (2 * common) / (x.length + y.length);
}

/** Share of distinct tokens in common (Jaccard), 0…1. */
function tokenOverlap(a: string, b: string): number {
  const x = new Set(tokens(a));
  const y = new Set(tokens(b));
  if (x.size === 0 || y.size === 0) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / (x.size + y.size - common);
}

/**
 * Ordering key for two labels, higher = more alike. Symmetric and
 * deterministic. Internal only: never displayed (brief §25 C).
 */
export function labelSimilarity(a: string, b: string): number {
  return tokenOverlap(a, b) + dice(a, b);
}

/** Words of three or more characters both labels share, longest first, then alphabetical. */
export function sharedWords(a: string, b: string): string[] {
  const y = new Set(tokens(b));
  return [...new Set(tokens(a))]
    .filter((t) => t.length >= 3 && y.has(t))
    .sort((p, q) => q.length - p.length || (p < q ? -1 : p > q ? 1 : 0));
}

/** "Shares the word “COFFEE”", or null when no word of 3+ characters is shared. */
export function sharedWordHint(a: string, b: string): string | null {
  const w = sharedWords(a, b)[0];
  return w ? `Shares the word “${w}”` : null;
}

/** Order near candidates: most similar label to the receipt merchant first, ties by ID. */
export function rankBySimilarity<T extends { id: string; rawLabel: string }>(items: readonly T[], merchant: string): T[] {
  return [...items]
    .map((t) => ({ t, s: labelSimilarity(t.rawLabel, merchant) }))
    .sort((p, q) => q.s - p.s || (p.t.id < q.t.id ? -1 : p.t.id > q.t.id ? 1 : 0))
    .map(({ t }) => t);
}
