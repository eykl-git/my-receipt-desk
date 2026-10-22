/**
 * In-memory repository (design §2, §11.5). Each unit of work runs on a copy of
 * the stores; the copy replaces the state only when every write passed its
 * schema, write-once and unique-index checks. It backs the comparison replay
 * and tests, and is the fallback when IndexedDB is unavailable.
 */
import { AlreadyLinkedError } from '../domain/errors';
import type { StoredRuleVersion, WorkspaceId } from '../domain/schemas';
import { buildSnapshot, checkRuleVersionWrite, ConstraintError, keyOf, SCHEMAS, UNIQUE_INDEXES, type StoreLists } from './records';
import { STORE_NAMES, type Repository, type StoreName, type StoreRecords, type WorkspaceSnapshot, type Writer } from './repository';

export { ConstraintError } from './records';

type Stores = { [S in StoreName]: Map<string, StoreRecords[S]> };

export interface MemoryRepositoryOptions {
  systemNow?: () => string;
  /** Test hook: throw before the nth put (1-based) to `store` (design §11.3). */
  faultAt?: { store: StoreName; nth: number };
}

function emptyStores(): Stores {
  const s = {} as Record<StoreName, Map<string, unknown>>;
  for (const name of STORE_NAMES) s[name] = new Map();
  return s as Stores;
}

/** The record holding `key` in a unique index, for the AlreadyLinkedError message. */
export function linkedSubject(other: Record<string, unknown>): string | null {
  return (other.subject as { id?: string } | undefined)?.id ?? ((other.evidence as { receiptIds?: string[] } | undefined)?.receiptIds?.[0] ?? null);
}

export class MemoryRepository implements Repository {
  readonly kind = 'memory' as const;
  readonly workspaceId: WorkspaceId;
  readonly systemNow: () => string;
  private stores: Stores = emptyStores();
  /** Test hook (design §11.3): throw before the nth put to a store in each unit of work. */
  faultAt: MemoryRepositoryOptions['faultAt'];

  constructor(workspaceId: WorkspaceId, options: MemoryRepositoryOptions = {}) {
    this.workspaceId = workspaceId;
    this.systemNow = options.systemNow ?? (() => new Date().toISOString());
    this.faultAt = options.faultAt;
  }

  close(): void {
    // Nothing to release.
  }

  private snapshotOf(stores: Stores): WorkspaceSnapshot {
    const lists = {} as Record<string, unknown[]>;
    for (const name of STORE_NAMES) if (name !== 'files') lists[name] = [...stores[name].values()];
    return buildSnapshot(this.workspaceId, lists as unknown as StoreLists);
  }

  loadSnapshot(): Promise<WorkspaceSnapshot> {
    return Promise.resolve(this.snapshotOf(this.stores));
  }

  getFile(key: string): Promise<Blob | null> {
    return Promise.resolve(this.stores.files.get(key)?.blob ?? null);
  }

  unitOfWork<T>(stores: readonly StoreName[], fn: (state: WorkspaceSnapshot, w: Writer) => T): Promise<T> {
    try {
      return Promise.resolve(this.runSync(stores, fn));
    } catch (e) {
      return Promise.reject(e);
    }
  }

  private runSync<T>(allowed: readonly StoreName[], fn: (state: WorkspaceSnapshot, w: Writer) => T): T {
    const writes: Array<{ store: StoreName; record: unknown }> = [];
    const writer: Writer = {
      put(store, record) {
        if (!allowed.includes(store)) throw new Error(`Unit of work may not write to ${store}.`);
        writes.push({ store, record: store === 'files' ? record : structuredClone(record) });
      },
    };
    const result = fn(this.snapshotOf(this.stores), writer);

    // Apply to copies; swap in only when everything passed.
    const next = {} as Record<StoreName, Map<string, unknown>>;
    for (const name of STORE_NAMES) next[name] = new Map(this.stores[name] as Map<string, unknown>);
    const puts = new Map<StoreName, number>();
    for (const { store, record } of writes) {
      const n = (puts.get(store) ?? 0) + 1;
      puts.set(store, n);
      if (this.faultAt && this.faultAt.store === store && this.faultAt.nth === n) {
        throw new Error(`Injected storage fault on ${store} put #${n}`);
      }
      const schema = SCHEMAS[store];
      if (schema) schema.parse(record);
      const key = keyOf(store, record as never);
      if (store === 'rule_versions') {
        checkRuleVersionWrite(next.rule_versions.get(key) as StoredRuleVersion | undefined, record as StoredRuleVersion);
      }
      next[store].set(key, record);
    }
    for (const idx of UNIQUE_INDEXES) {
      if (!puts.has(idx.store)) continue;
      const seen = new Map<unknown, Record<string, unknown>>();
      for (const rec of next[idx.store].values() as Iterable<Record<string, unknown>>) {
        const k = idx.key(rec);
        if (k === undefined || k === null) continue;
        const other = seen.get(k);
        if (other) {
          if (idx.name === 'byActiveTxn' || idx.name === 'byActiveIdentity') throw new AlreadyLinkedError(String(k), linkedSubject(other));
          throw new ConstraintError(`${idx.store}.${idx.name}: duplicate key ${String(k)}`);
        }
        seen.set(k, rec);
      }
    }
    this.stores = next as Stores;
    return result;
  }
}
