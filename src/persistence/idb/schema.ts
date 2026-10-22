/**
 * IndexedDB layout (design §11.1): one database per workspace, version 1.
 * `migrations[0]` creates every store and index. Adding a schema version means
 * appending a migration here plus a record migrator in `migrations.ts`.
 */
import type { IDBPDatabase, IDBPTransaction } from 'idb';
import type { WorkspaceId } from '../../domain/schemas';
import { UNIQUE_INDEXES } from '../records';
import { STORE_NAMES, type StoreName } from '../repository';

export const DB_NAMES: Readonly<Record<WorkspaceId, string>> = Object.freeze({ demo: 'mrd-demo', personal: 'mrd-personal' });

/** Key paths (design §11.1; `id` unless noted). */
export const KEY_PATHS: Readonly<Record<StoreName, string | string[]>> = Object.freeze({
  meta: 'key',
  files: 'key',
  source_documents: 'id',
  receipts: 'id',
  transactions: 'id',
  payables: 'id',
  matches: 'id',
  ledger: 'id',
  rule_heads: 'ruleId',
  rule_versions: ['ruleId', 'version'],
  decisions: 'id',
  audit: 'id',
});

/** Non-unique lookup indexes (§11.1). */
const LOOKUP_INDEXES: ReadonlyArray<{ store: StoreName; name: string; keyPath: string }> = [
  { store: 'receipts', name: 'bySourceDocument', keyPath: 'sourceDocumentId' },
  { store: 'transactions', name: 'bySourceDocument', keyPath: 'sourceDocumentId' },
];

// The stores are untyped at the idb level; records are checked with zod instead.
export type AnyDb = IDBPDatabase<unknown>;
export type UpgradeTx = IDBPTransaction<unknown, string[], 'versionchange'>;
export type Migration = (db: AnyDb, tx: UpgradeTx) => void;

/** v0 → v1: every store and index. */
export const createStores: Migration = (db) => {
  for (const name of STORE_NAMES) {
    const store = db.createObjectStore(name, { keyPath: KEY_PATHS[name] });
    for (const idx of UNIQUE_INDEXES) if (idx.store === name) store.createIndex(idx.name, idx.keyPath, { unique: true });
    for (const idx of LOOKUP_INDEXES) if (idx.store === name) store.createIndex(idx.name, idx.keyPath, { unique: false });
  }
};

export const MIGRATIONS: readonly Migration[] = Object.freeze([createStores]);
