/**
 * Shared unit-of-work helper for commands (design §11.3). One command = one
 * unit of work: it reads the state, allocates IDs from `meta.counters`, stamps
 * one timestamp (demo clock tick +1, or the system clock), appends audit events
 * and writes everything together. A no-op command writes nothing at all.
 */
import { buildAuditEvent, type AuditEventInput } from '../../domain/audit/events';
import { activeRulesFrom } from '../../domain/knowledge/resolve';
import type { RuleVersion } from '../../domain/knowledge/schema';
import type { WorkspaceState } from '../../domain/knowledge/preview';
import type { EvaluationInput } from '../../domain/matching/types';
import type { DemoState } from '../../domain/schemas';
import { demoTime } from '../clock';
import { STORE_NAMES, type Repository, type StoreName, type StoreRecords, type WorkspaceSnapshot, type Writer } from '../repository';

export class CommandContext {
  readonly state: WorkspaceSnapshot;
  readonly at: string;
  private readonly writer: Writer;
  private readonly counters: Record<string, number>;
  private readonly tick: number | null;
  private demoPatch: Partial<DemoState> = {};
  private noop = false;

  constructor(state: WorkspaceSnapshot, writer: Writer, repo: Repository) {
    this.state = state;
    this.writer = writer;
    this.counters = { ...state.counters };
    if (state.workspaceId === 'demo') {
      this.tick = state.demoState.clockTick + 1;
      this.at = demoTime(this.tick);
    } else {
      this.tick = null;
      this.at = repo.systemNow();
    }
  }

  get workspaceId() {
    return this.state.workspaceId;
  }

  next(counter: string): number {
    const n = (this.counters[counter] ?? 0) + 1;
    this.counters[counter] = n;
    return n;
  }

  put<S extends StoreName>(store: S, record: StoreRecords[S]): void {
    this.writer.put(store, record);
  }

  audit(input: Omit<AuditEventInput, 'workspaceId' | 'seq' | 'at'>): void {
    this.writer.put('audit', buildAuditEvent({ ...input, workspaceId: this.workspaceId, seq: this.next('audit'), at: this.at }));
  }

  setDemoState(patch: Partial<DemoState>): void {
    this.demoPatch = { ...this.demoPatch, ...patch };
  }

  /** Mark the command as a no-op: nothing (not even the clock tick) is written. */
  markNoop(): void {
    this.noop = true;
  }

  get isNoop(): boolean {
    return this.noop;
  }

  activeRules(): RuleVersion[] {
    return activeRulesFrom(this.state.ruleHeads, this.state.ruleVersions);
  }

  evaluationInput(activeRules: readonly RuleVersion[] = this.activeRules()): EvaluationInput {
    return {
      receipts: this.state.receipts,
      transactions: this.state.transactions,
      matches: this.state.matches,
      ledgerEntries: this.state.ledger,
      activeRules,
      decisions: this.state.decisions,
      workspaceCurrency: this.state.currency,
    };
  }

  workspaceState(): WorkspaceState {
    return asWorkspaceState(this.state);
  }

  finish(): void {
    if (this.noop) return;
    this.writer.put('meta', { key: 'counters', values: this.counters });
    if (this.tick !== null || Object.keys(this.demoPatch).length > 0) {
      this.writer.put('meta', {
        key: 'demoState',
        value: { ...this.state.demoState, ...this.demoPatch, ...(this.tick !== null ? { clockTick: this.tick } : {}) },
      });
    }
  }
}

export function asWorkspaceState(s: WorkspaceSnapshot): WorkspaceState {
  return {
    receipts: s.receipts,
    transactions: s.transactions,
    matches: s.matches,
    ledger: s.ledger,
    decisions: s.decisions,
    payables: s.payables,
    ruleHeads: s.ruleHeads,
    ruleVersions: s.ruleVersions,
    currency: s.currency,
  };
}

/** Run a command in one unit of work over every store. */
export function runCommand<T>(repo: Repository, fn: (c: CommandContext) => T): Promise<T> {
  return repo.unitOfWork(STORE_NAMES, (state, w) => {
    const c = new CommandContext(state, w, repo);
    const result = fn(c);
    c.finish();
    return result;
  });
}
