/**
 * Both-repository harness (plan S4, task 4.1): persistence suites run once on
 * MemoryRepository and once on IdbRepository (fake-indexeddb). `makeRepo`
 * returns a repository synchronously; the IndexedDB one opens its own fresh
 * database lazily on first use, so existing helpers keep their shape.
 */
import { afterAll, beforeAll, describe } from 'vitest';
import type { WorkspaceId } from '../../src/domain/schemas';
import { IdbRepository, type IdbRepositoryOptions } from '../../src/persistence/idb/idbRepository';
import { MemoryRepository } from '../../src/persistence/memoryRepository';
import type { Repository, StoreName, WorkspaceSnapshot, Writer } from '../../src/persistence/repository';

export type RepoKind = 'memory' | 'indexeddb';
export const REPO_KINDS: readonly RepoKind[] = ['memory', 'indexeddb'];

let current: RepoKind = 'memory';
let dbCounter = 0;

export function currentRepoKind(): RepoKind {
  return current;
}

/** Defers IdbRepository.open until the first call; reports kind 'indexeddb'. */
export class LazyIdbRepository implements Repository {
  readonly kind = 'indexeddb' as const;
  readonly workspaceId: WorkspaceId;
  readonly systemNow: () => string;
  readonly dbName: string;
  private readonly opening: Promise<IdbRepository>;

  constructor(workspaceId: WorkspaceId, options: IdbRepositoryOptions = {}) {
    this.workspaceId = workspaceId;
    this.systemNow = options.systemNow ?? (() => new Date().toISOString());
    this.dbName = options.dbName ?? `test-${workspaceId}-${++dbCounter}`;
    this.opening = IdbRepository.open(workspaceId, { ...options, dbName: this.dbName });
  }
  inner(): Promise<IdbRepository> {
    return this.opening;
  }
  close(): void {
    void this.opening.then((r) => r.close());
  }
  async loadSnapshot(): Promise<WorkspaceSnapshot> {
    return (await this.opening).loadSnapshot();
  }
  async getFile(key: string): Promise<Blob | null> {
    return (await this.opening).getFile(key);
  }
  async unitOfWork<T>(stores: readonly StoreName[], fn: (state: WorkspaceSnapshot, w: Writer) => T): Promise<T> {
    return (await this.opening).unitOfWork(stores, fn);
  }
}

export function makeRepo(ws: WorkspaceId, options: IdbRepositoryOptions = {}, kind: RepoKind = current): Repository {
  return kind === 'memory' ? new MemoryRepository(ws, options) : new LazyIdbRepository(ws, options);
}

/** Run `fn`'s tests once per repository kind; `makeRepo()` inside uses that kind. */
export function describeEachRepo(name: string, fn: (kind: RepoKind) => void): void {
  for (const kind of REPO_KINDS) {
    describe(`${name} [${kind}]`, () => {
      beforeAll(() => {
        current = kind;
      });
      afterAll(() => {
        current = 'memory';
      });
      fn(kind);
    });
  }
}
