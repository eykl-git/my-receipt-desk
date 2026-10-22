/**
 * Workspace currency setting (brief §26 A, REQ-20). My files can use HKD
 * (default) or MYR, chosen while the workspace holds no receipts, card
 * transactions or invoices; afterwards a change is refused with a visible
 * reason. The demo workspace is locked to HKD. Nothing is ever converted.
 * Settings are not audited (the audit list in design §4.1 is closed); the
 * command is listed in COMMAND_AUDIT with an empty action list.
 */
import { ValidationError } from '../../domain/errors';
import { WorkspaceCurrencySchema, type WorkspaceCurrency } from '../../domain/schemas';
import type { Repository, WorkspaceSnapshot } from '../repository';
import { runCommand } from './context';

export const CURRENCY_MESSAGES = Object.freeze({
  locked: 'Currency can’t be changed after data is added. Delete My files data first.',
  demoLocked: 'The demo workspace always uses HKD.',
});

/** Why the currency can't be changed now, or null when it can. */
export function currencyLockReason(s: Pick<WorkspaceSnapshot, 'workspaceId' | 'receipts' | 'transactions' | 'payables'>): string | null {
  if (s.workspaceId === 'demo') return CURRENCY_MESSAGES.demoLocked;
  if (s.receipts.length > 0 || s.transactions.length > 0 || s.payables.length > 0) return CURRENCY_MESSAGES.locked;
  return null;
}

export function setWorkspaceCurrency(repo: Repository, currency: WorkspaceCurrency): Promise<{ changed: boolean }> {
  const value = WorkspaceCurrencySchema.parse(currency);
  return runCommand(repo, (c) => {
    if (c.state.currency === value) {
      c.markNoop();
      return { changed: false };
    }
    const locked = currencyLockReason(c.state);
    if (locked) throw new ValidationError('CURRENCY_LOCKED', locked);
    c.put('meta', { key: 'settings', currency: value });
    return { changed: true };
  });
}
