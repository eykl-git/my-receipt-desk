/**
 * Storage failure classification (design §11.5). Every write is one
 * transaction, so each of these means nothing was written; the UI maps the
 * kind to its message. Unknown errors are treated as "not saved".
 */
export type StorageFailure = 'quota' | 'aborted' | 'newer_version' | 'other';

function names(e: unknown): string[] {
  const out: string[] = [];
  let cur: unknown = e;
  for (let i = 0; i < 4 && cur instanceof Error; i++) {
    out.push(cur.name);
    cur = (cur as Error & { cause?: unknown }).cause;
  }
  if (typeof DOMException !== 'undefined' && e instanceof DOMException) out.push(e.name);
  return out;
}

export function classifyStorageError(e: unknown): StorageFailure {
  const n = names(e);
  if (n.includes('QuotaExceededError')) return 'quota';
  if (n.includes('VersionError')) return 'newer_version';
  if (n.includes('AbortError') || n.includes('TransactionInactiveError') || n.includes('InvalidStateError')) return 'aborted';
  return 'other';
}
