/**
 * Possible duplicate purchases (design §10.2, review-3 amendments M1 and N10).
 *
 * Two active, validated receipts from different files with the same canonical
 * merchant, date, amount and currency are suspected duplicates. Suspicion only
 * flags for review; nothing is discarded. A receipt that already has an active
 * match or a non-voided ledger entry is never flagged (M1): only the unlinked
 * side of a collision is. Different dates are not duplicates (N10).
 */
import { canonicalMerchantId } from '../normalize';
import type { ConfirmedMatch, LedgerEntry, Receipt, ReviewDecision } from '../schemas';
import { captureStatus, effectiveFields } from './fields';

/** receiptId → the other receipt IDs it may duplicate (sorted). */
export type DuplicateFlags = ReadonlyMap<string, readonly string[]>;

export function linkedReceiptIds(matches: readonly ConfirmedMatch[], ledger: readonly LedgerEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const m of matches) if (m.status === 'active' && m.subject.kind === 'receipt') ids.add(m.subject.id);
  for (const e of ledger) if (e.status === 'recorded') for (const r of e.evidence.receiptIds) ids.add(r);
  return ids;
}

function resolvedAsDistinct(decisions: readonly ReviewDecision[], a: string, b: string): boolean {
  return decisions.some(
    (d) =>
      d.kind === 'duplicate_resolution' && d.choice === 'distinct' && d.subjectIds.includes(a) && d.subjectIds.includes(b),
  );
}

export function detectDuplicatePurchases(
  receipts: readonly Receipt[],
  matches: readonly ConfirmedMatch[],
  ledger: readonly LedgerEntry[],
  decisions: readonly ReviewDecision[],
): DuplicateFlags {
  const linked = linkedReceiptIds(matches, ledger);
  const groups = new Map<string, Receipt[]>();
  for (const r of receipts) {
    if (r.disposition !== 'active' || captureStatus(r) !== 'validated') continue;
    const f = effectiveFields(r);
    if (f.merchant === null || f.date === null || f.amountMinor === null || f.currency === null) continue;
    const key = [canonicalMerchantId(f.merchant), f.date, f.amountMinor, f.currency].join('|');
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }

  const flags = new Map<string, Set<string>>();
  const flag = (id: string, other: string) => {
    const s = flags.get(id) ?? new Set<string>();
    s.add(other);
    flags.set(id, s);
  };

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i]!;
        const b = sorted[j]!;
        if (a.sourceDocumentId === b.sourceDocumentId) continue;
        if (resolvedAsDistinct(decisions, a.id, b.id)) continue;
        if (!linked.has(a.id)) flag(a.id, b.id);
        if (!linked.has(b.id)) flag(b.id, a.id);
      }
    }
  }

  const out = new Map<string, readonly string[]>();
  for (const [id, others] of flags) out.set(id, [...others].sort());
  return out;
}
