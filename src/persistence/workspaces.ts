/**
 * Workspaces, reset and delete (design §11.6). Each workspace is its own
 * IndexedDB database; the last-used workspace is kept in localStorage (no
 * data). If IndexedDB can't be opened the app falls back to a
 * MemoryRepository and says that nothing is kept (§11.5).
 */
import { deleteDB } from 'idb';
import type { WorkspaceId } from '../domain/schemas';
import { IdbRepository } from './idb/idbRepository';
import { DB_NAMES } from './idb/schema';
import { MemoryRepository } from './memoryRepository';
import type { Repository } from './repository';

export const LAST_WORKSPACE_KEY = 'mrd:lastWorkspace';
/** tesseract.js keeps downloaded OCR language files here (ocr-design §6). It holds no user data. */
export const OCR_CACHE_DB = 'keyval-store';

export type StorageFallback = 'unavailable' | 'newer_version';

export interface OpenedWorkspace {
  repo: Repository;
  /** Set when IndexedDB couldn't be used and the workspace runs in memory. */
  fallback: StorageFallback | null;
}

export async function openWorkspace(ws: WorkspaceId, onBlocking?: () => void): Promise<OpenedWorkspace> {
  if (typeof indexedDB === 'undefined') return { repo: new MemoryRepository(ws), fallback: 'unavailable' };
  try {
    return { repo: await IdbRepository.open(ws, { onBlocking }), fallback: null };
  } catch (e) {
    console.error(e);
    const newer = e instanceof Error && e.name === 'VersionError';
    return { repo: new MemoryRepository(ws), fallback: newer ? 'newer_version' : 'unavailable' };
  }
}

/** Delete one database; `onBlocked` fires if another tab keeps it open. */
export async function deleteDatabase(name: string, onBlocked?: () => void): Promise<void> {
  await deleteDB(name, { blocked: () => onBlocked?.() });
}

export function deleteWorkspaceDb(ws: WorkspaceId, onBlocked?: () => void): Promise<void> {
  return deleteDatabase(DB_NAMES[ws], onBlocked);
}

export function readLastWorkspace(): WorkspaceId | null {
  try {
    const v = globalThis.localStorage?.getItem(LAST_WORKSPACE_KEY);
    return v === 'demo' || v === 'personal' ? v : null;
  } catch {
    return null;
  }
}

export function writeLastWorkspace(ws: WorkspaceId | null): void {
  try {
    if (ws === null) globalThis.localStorage?.removeItem(LAST_WORKSPACE_KEY);
    else globalThis.localStorage?.setItem(LAST_WORKSPACE_KEY, ws);
  } catch {
    // Storage disabled: the workspace choice is simply not remembered.
  }
}
