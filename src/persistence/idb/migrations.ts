/**
 * Opening and migrating a workspace database (design §11.2). `openWorkspaceDb`
 * runs `migrations[v]` for each stored version `v` up to the newest, in order,
 * inside the upgrade transaction. Records also carry `schemaVersion`;
 * `migrateRecord` lifts an old record to the current shape before zod (v1 is
 * the identity).
 */
import { openDB } from 'idb';
import type { StoreName } from '../repository';
import type { AnyDb, Migration, UpgradeTx } from './schema';

export interface OpenHandlers {
  /** A newer tab wants to upgrade; the connection should close (§11.5). */
  blocking?: () => void;
}

export async function openWorkspaceDb(name: string, migrations: readonly Migration[], handlers: OpenHandlers = {}): Promise<AnyDb> {
  const db = await openDB<unknown>(name, migrations.length, {
    upgrade(database, oldVersion, newVersion, tx) {
      const target = newVersion ?? migrations.length;
      for (let v = oldVersion; v < target; v++) migrations[v]!(database as AnyDb, tx as unknown as UpgradeTx);
    },
    blocking() {
      handlers.blocking?.();
    },
  });
  return db as AnyDb;
}

export const CURRENT_RECORD_VERSION = 1;

/** Lift a stored record to the current schema version (v1: identity). */
export function migrateRecord(store: StoreName, record: unknown): unknown {
  void store;
  return record;
}
