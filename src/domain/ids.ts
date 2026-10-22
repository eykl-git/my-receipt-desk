/** Deterministic IDs from per-workspace counters (design §4, §8). No randomness. */

export type RuleKind = 'ALIAS' | 'CAT' | 'POLICY';

function pad(n: number, width: number): string {
  if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`Counter must be a positive integer, got ${String(n)}`);
  return String(n).padStart(width, '0');
}

export const matchId = (n: number): string => `M-${pad(n, 4)}`;
export const ledgerId = (n: number): string => `L-${pad(n, 4)}`;
export const auditId = (n: number): string => `A-${pad(n, 6)}`;
export const documentId = (n: number): string => `DOC-${pad(n, 4)}`;
export const payableId = (n: number): string => `INV-${pad(n, 4)}`;
export const decisionId = (n: number): string => `D-${pad(n, 4)}`;
export const ruleId = (kind: RuleKind, n: number): string => `K-${kind}-${pad(n, 4)}`;

/** `TX-<first 12 hex of the file SHA-256>-<row number>`. */
export function transactionId(sha256Hex: string, rowNumber: number): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new RangeError('Expected a lowercase SHA-256 hex digest');
  return `TX-${sha256Hex.slice(0, 12)}-${pad(rowNumber, 1)}`;
}

/** `<sha256>:<row>` — the unique source-row identity of a statement row. */
export function sourceRowId(sha256Hex: string, rowNumber: number): string {
  if (!/^[0-9a-f]{64}$/.test(sha256Hex)) throw new RangeError('Expected a lowercase SHA-256 hex digest');
  return `${sha256Hex}:${pad(rowNumber, 1)}`;
}

export const RULE_ID_PATTERN = /^K-(ALIAS|CAT|POLICY)-\d{4}$/;
