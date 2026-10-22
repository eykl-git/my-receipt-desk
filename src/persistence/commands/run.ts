/**
 * "Record all ready" (design §6.3, §9.3, S11 bounded batch processing). A run
 * records at most `LIMITS.recordAllReadyMaxCases` ready proposals, in receipt
 * ID order, each in its own unit of work that revalidates the proposal first.
 * The run object can be paused: the check happens before each case and again
 * as the first step inside its unit of work, so pausing stops before the next
 * record and never undoes one already written. There are no retries.
 */
import { AlreadyLinkedError, StaleProposalError } from '../../domain/errors';
import { LIMITS } from '../../domain/limits';
import type { MatchProposal } from '../../domain/matching/types';
import type { Repository } from '../repository';
import { runCommand } from './context';
import { commitShownProposal, type RecordResult } from './match';

export interface RecordRun {
  paused: boolean;
}

export interface RecordAllResult {
  recorded: Array<{ receiptId: string } & RecordResult>;
  /** Proposals that were no longer valid when their turn came (nothing written for them). */
  skipped: Array<{ receiptId: string; reason: string }>;
  /** Not attempted: after a pause, or beyond the per-run limit. */
  remaining: string[];
  paused: boolean;
}

export function newRecordRun(): RecordRun {
  return { paused: false };
}

export async function recordAllReady(
  repo: Repository,
  run: RecordRun,
  shown: readonly MatchProposal[],
  opts: { onCommitted?: (receiptId: string, result: RecordResult) => unknown } = {},
): Promise<RecordAllResult> {
  const sorted = [...shown].sort((a, b) => (a.subject.id < b.subject.id ? -1 : a.subject.id > b.subject.id ? 1 : 0));
  const queue = sorted.slice(0, LIMITS.recordAllReadyMaxCases);
  const result: RecordAllResult = {
    recorded: [],
    skipped: [],
    remaining: sorted.slice(LIMITS.recordAllReadyMaxCases).map((p) => p.subject.id),
    paused: false,
  };
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i]!;
    if (run.paused) {
      result.paused = true;
      result.remaining = [...queue.slice(i).map((x) => x.subject.id), ...result.remaining];
      break;
    }
    try {
      const committed = await runCommand(repo, (c) => {
        if (run.paused) {
          c.markNoop();
          return null;
        }
        return commitShownProposal(c, p);
      });
      if (committed === null) {
        result.paused = true;
        result.remaining = [...queue.slice(i).map((x) => x.subject.id), ...result.remaining];
        break;
      }
      result.recorded.push({ receiptId: p.subject.id, ...committed });
      // Called right after the commit; a returned promise (a progress pause) is awaited before the next case.
      const wait = opts.onCommitted?.(p.subject.id, committed);
      if (wait instanceof Promise) await wait;
    } catch (e) {
      if (e instanceof StaleProposalError || e instanceof AlreadyLinkedError) result.skipped.push({ receiptId: p.subject.id, reason: e.message });
      else throw e;
    }
  }
  return result;
}
