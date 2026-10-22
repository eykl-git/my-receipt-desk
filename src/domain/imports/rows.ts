/**
 * Intake rules shared by real imports and demo batches (design §10.2, §12.1,
 * review-3 amendments M1 and N6).
 */
import { LIMITS } from '../limits';
import { accountId as toAccountId, accountSlug } from '../normalize';
import type { StatementTransaction } from '../schemas';

/**
 * Flags possible duplicate rows on the incoming file only (M1): a row matches
 * an existing row from a different file in the same account when both carry
 * the same non-empty reference, or (both without reference) the same posting
 * date, amount, direction and normalised label. Existing rows are never
 * rewritten, and rows inside one file are never flagged against each other.
 */
export function flagIncomingDuplicates(
  incoming: readonly StatementTransaction[],
  existing: readonly StatementTransaction[],
): StatementTransaction[] {
  return incoming.map((t) => {
    const other = existing.find(
      (e) =>
        e.sourceDocumentId !== t.sourceDocumentId &&
        e.accountId === t.accountId &&
        e.intake !== 'set_aside_duplicate' &&
        (t.reference !== null && e.reference !== null
          ? t.reference === e.reference
          : t.reference === null &&
            e.reference === null &&
            e.postingDate === t.postingDate &&
            e.amountMinor === t.amountMinor &&
            e.direction === t.direction &&
            e.normalizedLabel === t.normalizedLabel),
    );
    return other ? { ...t, duplicateSuspected: true, duplicateOf: other.id } : t;
  });
}

export type AccountChoice =
  | { ok: true; accountId: string; accountLabel: string; existing: boolean }
  | { ok: false; message: string };

/**
 * Card account for an import (N6): the same slug with the same label reuses the
 * account; the same slug with a different label is refused.
 */
export function resolveAccount(name: string, existing: readonly Pick<StatementTransaction, 'accountId' | 'accountLabel'>[]): AccountChoice {
  const label = name.trim();
  if (label.length < LIMITS.accountNameMinChars) return { ok: false, message: 'Enter a card account name.' };
  if (label.length > LIMITS.accountNameMaxChars) return { ok: false, message: `Card account name must be at most ${LIMITS.accountNameMaxChars} characters.` };
  if (accountSlug(label) === '') return { ok: false, message: 'Use letters or numbers in the account name.' };
  const id = toAccountId(label);
  const same = existing.find((t) => t.accountId === id);
  if (same && same.accountLabel !== label) {
    return {
      ok: false,
      message: `A card account with a similar name already exists: “${same.accountLabel}”. Choose it from the list or use a different name.`,
    };
  }
  return { ok: true, accountId: id, accountLabel: label, existing: same !== undefined };
}

/** Distinct card accounts present in a workspace, sorted by label. */
export function accountsOf(transactions: readonly Pick<StatementTransaction, 'accountId' | 'accountLabel'>[]): Array<{ accountId: string; accountLabel: string }> {
  const m = new Map<string, string>();
  for (const t of transactions) if (!m.has(t.accountId)) m.set(t.accountId, t.accountLabel);
  return [...m.entries()].map(([accountId, accountLabel]) => ({ accountId, accountLabel })).sort((a, b) => (a.accountLabel < b.accountLabel ? -1 : 1));
}
