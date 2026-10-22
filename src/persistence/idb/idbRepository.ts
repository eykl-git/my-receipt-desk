/**
 * IndexedDB repository (design §11.1–§11.3). Each unit of work is one
 * `readwrite` transaction over every store: it reads the workspace state with
 * `getAll`, runs the command's pure domain code synchronously, then puts the
 * buffered writes and awaits `tx.done`. No non-IDB `await` happens inside the
 * transaction, so it cannot auto-commit half-way; any thrown error aborts it
 * and nothing persists (T25). Unique-index `ConstraintError`s on the active
 * match and ledger identity indexes become `AlreadyLinkedError`.
 */
import { AlreadyLinkedError } from '../../domain/errors';
import type { StoredRuleVersion, WorkspaceId } from '../../domain/schemas';
import { linkedSubject } from '../memoryRepository';
import { buildSnapshot, checkRuleVersionWrite, ConstraintError, keyOf, SCHEMAS, type StoreLists } from '../records';
import { STORE_NAMES, type Repository, type StorageProblem, type StoreName, type StoreRecords, type WorkspaceSnapshot, type Writer } from '../repository';
import { migrateRecord, openWorkspaceDb, type OpenHandlers } from './migrations';
import { DB_NAMES, MIGRATIONS, type AnyDb, type Migration } from './schema';

export interface IdbRepositoryOptions {
  systemNow?: () => string;
  /** Test hook: throw before the nth put (1-based) to `store` (design §11.3). */
  faultAt?: { store: StoreName; nth: number };
  /** Database name override (tests); defaults to `mrd-demo` / `mrd-personal`. */
  dbName?: string;
  migrations?: readonly Migration[];
  /** Called when a newer tab needs this connection closed (§11.5). */
  onBlocking?: () => void;
}

export type { StorageProblem } from '../repository';

const READ_STORES = STORE_NAMES.filter((s) => s !== 'files');

type AnyTx = ReturnType<AnyDb['transaction']>;

export class IdbRepository implements Repository {
  readonly kind = 'indexeddb' as const;
  readonly workspaceId: WorkspaceId;
  readonly systemNow: () => string;
  readonly dbName: string;
  /** Records excluded on the last load because they failed their schema. */
  problems: StorageProblem[] = [];
  private db: AnyDb;
  private readonly faultAt: IdbRepositoryOptions['faultAt'];

  private constructor(workspaceId: WorkspaceId, db: AnyDb, dbName: string, options: IdbRepositoryOptions) {
    this.workspaceId = workspaceId;
    this.db = db;
    this.dbName = dbName;
    this.systemNow = options.systemNow ?? (() => new Date().toISOString());
    this.faultAt = options.faultAt;
  }

  static async open(workspaceId: WorkspaceId, options: IdbRepositoryOptions = {}): Promise<IdbRepository> {
    const name = options.dbName ?? DB_NAMES[workspaceId];
    let repo: IdbRepository | null = null;
    const handlers: OpenHandlers = {
      blocking: () => {
        repo?.close();
        options.onBlocking?.();
      },
    };
    const db = await openWorkspaceDb(name, options.migrations ?? MIGRATIONS, handlers);
    repo = new IdbRepository(workspaceId, db, name, options);
    return repo;
  }

  close(): void {
    this.db.close();
  }

  private async readAll(tx: AnyTx): Promise<{ lists: StoreLists; problems: StorageProblem[] }> {
    const results = await Promise.all(READ_STORES.map((s) => tx.objectStore(s).getAll()));
    const lists = {} as Record<string, unknown[]>;
    const problems: StorageProblem[] = [];
    READ_STORES.forEach((store, i) => {
      const schema = SCHEMAS[store];
      const ok: unknown[] = [];
      for (const raw of results[i] ?? []) {
        const record = migrateRecord(store, raw);
        const parsed = schema ? schema.safeParse(record) : { success: true as const };
        if (parsed.success) ok.push(record);
        else {
          const id = keyOf(store, record as never);
          problems.push({ store, id, error: parsed.error.issues[0]?.message ?? 'Invalid record' });
          console.warn(`Stored record ${store}/${id} failed its check and is excluded.`);
        }
      }
      lists[store] = ok;
    });
    return { lists: lists as unknown as StoreLists, problems };
  }

  async loadSnapshot(): Promise<WorkspaceSnapshot> {
    const tx = this.db.transaction([...READ_STORES], 'readonly');
    const { lists, problems } = await this.readAll(tx);
    await tx.done;
    this.problems = problems;
    return buildSnapshot(this.workspaceId, lists);
  }

  async getFile(key: string): Promise<Blob | null> {
    const rec = (await this.db.get('files', key)) as StoreRecords['files'] | undefined;
    return rec?.blob ?? null;
  }

  /**
   * "Delete this record" in the "Storage problems" panel (§11.5): removes one
   * stored record that failed its schema on the last load. Only records listed
   * in `problems` can be deleted; they were never part of any evaluation.
   */
  async deleteProblem(problem: Pick<StorageProblem, 'store' | 'id'>): Promise<void> {
    if (!this.problems.some((p) => p.store === problem.store && p.id === problem.id)) throw new Error(`${problem.store}/${problem.id} is not a listed storage problem.`);
    let key: IDBValidKey = problem.id;
    if (problem.store === 'rule_versions') {
      const at = problem.id.lastIndexOf('#');
      key = [problem.id.slice(0, at), Number(problem.id.slice(at + 1))];
    }
    const tx = this.db.transaction([problem.store], 'readwrite');
    await tx.objectStore(problem.store).delete(key);
    await tx.done;
    this.problems = this.problems.filter((p) => !(p.store === problem.store && p.id === problem.id));
  }

  async unitOfWork<T>(allowed: readonly StoreName[], fn: (state: WorkspaceSnapshot, w: Writer) => T): Promise<T> {
    const tx = this.db.transaction([...STORE_NAMES], 'readwrite');
    const done = tx.done;
    done.catch(() => undefined);
    const writes: Array<{ store: StoreName; record: unknown }> = [];
    try {
      const { lists } = await this.readAll(tx);
      const snapshot = buildSnapshot(this.workspaceId, lists);
      const writer: Writer = {
        put(store, record) {
          if (!allowed.includes(store)) throw new Error(`Unit of work may not write to ${store}.`);
          writes.push({ store, record: store === 'files' ? record : structuredClone(record) });
        },
      };
      const result = fn(snapshot, writer);

      const versions = new Map<string, StoredRuleVersion>(snapshot.ruleVersions.map((v) => [keyOf('rule_versions', v), v]));
      const puts = new Map<StoreName, number>();
      const pending: Promise<unknown>[] = [];
      for (const { store, record } of writes) {
        const n = (puts.get(store) ?? 0) + 1;
        puts.set(store, n);
        if (this.faultAt && this.faultAt.store === store && this.faultAt.nth === n) {
          throw new Error(`Injected storage fault on ${store} put #${n}`);
        }
        const schema = SCHEMAS[store];
        if (schema) schema.parse(record);
        if (store === 'rule_versions') {
          const v = record as StoredRuleVersion;
          const key = keyOf('rule_versions', v);
          checkRuleVersionWrite(versions.get(key), v);
          versions.set(key, v);
        }
        const put = tx.objectStore(store).put(record);
        // If a later write throws, the abort rejects earlier puts; that is handled below.
        put.catch(() => undefined);
        pending.push(put);
      }
      const settled = await Promise.allSettled(pending);
      const failed = settled.findIndex((s) => s.status === 'rejected' && !isAbortError(s.reason));
      if (failed >= 0) throw this.mapPutError((settled[failed] as PromiseRejectedResult).reason, writes, failed, snapshot);
      const aborted = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
      if (aborted) throw aborted.reason;
      await done;
      return result;
    } catch (e) {
      try {
        tx.abort();
      } catch {
        // Already finished or aborted.
      }
      await done.catch(() => undefined);
      throw e;
    }
  }

  /** Unique-index violations: a second active link is AlreadyLinkedError (S-3). */
  private mapPutError(e: unknown, writes: ReadonlyArray<{ store: StoreName; record: unknown }>, index: number, snapshot: WorkspaceSnapshot): unknown {
    if (!(e instanceof Error) || e.name !== 'ConstraintError') return e;
    const { store, record } = writes[index]!;
    const r = record as Record<string, unknown>;
    const earlier = writes.slice(0, index).filter((w) => w.store === store).map((w) => w.record as Record<string, unknown>);
    const existing = (store === 'matches' ? snapshot.matches : store === 'ledger' ? snapshot.ledger : []) as unknown as Array<Record<string, unknown>>;
    const pool = [...existing.filter((x) => x.id !== r.id), ...earlier.filter((x) => x.id !== r.id)];
    if (store === 'matches' && r.activeTxnKey !== undefined) {
      const other = pool.find((x) => x.activeTxnKey === r.activeTxnKey);
      if (other) return new AlreadyLinkedError(String(r.activeTxnKey), linkedSubject(other));
    }
    if (store === 'ledger' && r.activeIdentityKey !== undefined) {
      const other = pool.find((x) => x.activeIdentityKey === r.activeIdentityKey);
      if (other) return new AlreadyLinkedError(String(r.activeIdentityKey), linkedSubject(other));
    }
    return new ConstraintError(`${store}: ${e.message || 'a unique index rejected the write'}`);
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}
