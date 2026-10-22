/** Small pure helpers shared by the matching modules. */
import { daysBetween, type IsoDate } from '../dates';
import type { RuleRef } from '../primitives';
import type { StatementTransaction } from '../schemas';

export const byId = <T extends { id: string }>(a: T, b: T): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function sortRefs(refs: readonly RuleRef[]): RuleRef[] {
  const seen = new Map<string, RuleRef>();
  for (const r of refs) seen.set(`${r.ruleId}@${r.version}`, { ruleId: r.ruleId, version: r.version });
  return [...seen.values()].sort((a, b) =>
    a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.version - b.version,
  );
}

/** The reference users see (the CSV Reference, else the internal ID). */
export function displayRef(t: Pick<StatementTransaction, 'reference' | 'id'>): string {
  return t.reference ?? t.id;
}

export function joinRefs(txns: readonly Pick<StatementTransaction, 'reference' | 'id'>[]): string {
  return txns.map(displayRef).join(', ');
}

/** Posting lag in calendar days from the receipt date (transaction date is not used). */
export function postingLag(receiptDate: IsoDate, t: Pick<StatementTransaction, 'postingDate'>): number {
  return daysBetween(receiptDate, t.postingDate);
}

export function inWindow(receiptDate: IsoDate, t: Pick<StatementTransaction, 'postingDate'>, maxLag: number): boolean {
  const lag = postingLag(receiptDate, t);
  return lag >= 0 && lag <= maxLag;
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function isHeldForDuplicateReview(t: Pick<StatementTransaction, 'duplicateSuspected' | 'duplicateResolution'>): boolean {
  return t.duplicateSuspected && t.duplicateResolution === null;
}
