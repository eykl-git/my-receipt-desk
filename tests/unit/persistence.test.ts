/**
 * IndexedDB persistence (design §11, task 4.1): T20 persistence and reset
 * boundaries, the v1 → v2 migration test (§11.2), and the IndexedDB unit of
 * work's atomicity and unique-index guarantees.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AlreadyLinkedError } from '../../src/domain/errors';
import { addReceipts, confirmCaseOnly, loadDemoBatch, setWorkspaceCurrency } from '../../src/persistence/commands';
import { sha256Hex } from '../../src/persistence/hash';
import { IdbRepository } from '../../src/persistence/idb/idbRepository';
import { openWorkspaceDb } from '../../src/persistence/idb/migrations';
import { createStores, DB_NAMES, type Migration } from '../../src/persistence/idb/schema';
import { deleteDatabase, OCR_CACHE_DB } from '../../src/persistence/workspaces';
import { AppStore } from '../../src/ui/store';
import { assets, teachAlias, tourToConfirmedR102, TOUR_REASON, txIdByRef } from '../helpers/tour';
import { makeRepo } from '../helpers/repos';
import { openDB } from 'idb';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
let n = 0;
const uniqueName = (label: string) => `t20-${label}-${++n}`;
const now = () => '2026-04-20T10:00:00.000Z';

async function upload(name: string, bytes = PNG) {
  return { fileName: name, mimeType: 'image/png', bytes, sha256: await sha256Hex(bytes) };
}

async function dbNames(): Promise<string[]> {
  return (await indexedDB.databases()).map((d) => d.name ?? '').sort();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const name of [DB_NAMES.demo, DB_NAMES.personal, OCR_CACHE_DB]) await deleteDatabase(name);
});

describe('T20 persistence and reset boundaries (IndexedDB)', () => {
  it('T20 write, close and reopen gives the same snapshot and the original file bytes', async () => {
    const dbName = uniqueName('reopen');
    const repo = await IdbRepository.open('demo', { dbName });
    await tourToConfirmedR102(repo);
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    const before = await repo.loadSnapshot();
    const doc = before.sourceDocuments.find((d) => d.sourceType === 'demo_receipt_image')!;
    repo.close();

    const reopened = await IdbRepository.open('demo', { dbName });
    const after = await reopened.loadSnapshot();
    expect(after).toEqual(before);
    expect(after.demoState).toEqual({ loadedBatches: [1, 2], tourStep: 3, clockTick: before.demoState.clockTick });
    expect(after.ruleHeads.map((h) => [h.ruleId, h.status, h.activeVersion])).toEqual([['K-ALIAS-0001', 'active', 1]]);
    const blob = await reopened.getFile(doc.fileKey);
    expect(blob).not.toBeNull();
    expect(await sha256Hex(new Uint8Array(await blob!.arrayBuffer()))).toBe(doc.sha256);
    expect(reopened.problems).toEqual([]);
    reopened.close();
  });

  it('T20 My files receipts, fields and the currency setting survive a reopen', async () => {
    const dbName = uniqueName('personal');
    const repo = await IdbRepository.open('personal', { dbName, systemNow: now });
    await setWorkspaceCurrency(repo, 'MYR');
    await addReceipts(repo, [await upload('photo.png')]);
    repo.close();
    const again = await IdbRepository.open('personal', { dbName, systemNow: now });
    const s = await again.loadSnapshot();
    expect(s.currency).toBe('MYR');
    expect(s.receipts.map((r) => r.id)).toEqual(['R-0001']);
    expect(s.sourceDocuments.map((d) => d.fileName)).toEqual(['photo.png']);
    again.close();
  });

  it('T20 "Reset demo" deletes mrd-demo only; "Delete my files data" deletes mrd-personal only; "Delete all" removes both and the OCR cache', async () => {
    const store = new AppStore();
    store.repos = { demo: await IdbRepository.open('demo'), personal: await IdbRepository.open('personal', { systemNow: now }) };
    await loadDemoBatch(store.repos.demo, 1, assets);
    await addReceipts(store.repos.personal, [await upload('mine.png')]);
    // A stand-in for tesseract.js's language-file cache (ocr-design §6).
    (await openDB(OCR_CACHE_DB, 1, { upgrade: (db) => db.createObjectStore('keyval') })).close();
    const personalBefore = await store.repos.personal.loadSnapshot();

    await store.reset('demo');
    expect(store.repos.demo.kind).toBe('indexeddb');
    expect((await store.repos.demo.loadSnapshot()).receipts).toEqual([]);
    expect(await store.repos.personal.loadSnapshot()).toEqual(personalBefore);
    // A fresh connection sees the same: the demo database was really deleted.
    const probe = await IdbRepository.open('demo');
    expect((await probe.loadSnapshot()).demoState.loadedBatches).toEqual([]);
    probe.close();

    await loadDemoBatch(store.repos.demo, 1, assets);
    await store.reset('personal');
    expect((await store.repos.personal.loadSnapshot()).receipts).toEqual([]);
    expect((await store.repos.demo.loadSnapshot()).receipts).toHaveLength(5);

    await addReceipts(store.repos.personal, [await upload('again.png')]);
    expect(await dbNames()).toEqual(expect.arrayContaining([DB_NAMES.demo, DB_NAMES.personal, OCR_CACHE_DB]));
    await store.reset('all');
    expect(await dbNames()).not.toContain(OCR_CACHE_DB);
    expect((await store.repos.demo.loadSnapshot()).receipts).toEqual([]);
    expect((await store.repos.personal.loadSnapshot()).receipts).toEqual([]);
    expect(store.get().workspace).toBe('personal');
    store.repos.demo.close();
    store.repos.personal.close();
  });

  it('T20 (migration) a v1 database upgraded with a test-only v2 migration keeps its data and runs migrations in order', async () => {
    const dbName = uniqueName('migrate');
    const v1 = await IdbRepository.open('personal', { dbName, systemNow: now });
    await addReceipts(v1, [await upload('kept.png')]);
    const before = await v1.loadSnapshot();
    v1.close();

    const ran: string[] = [];
    const recordingV1: Migration = (db, tx) => {
      ran.push('v1');
      createStores(db, tx);
    };
    const v2: Migration = (db) => {
      ran.push('v2');
      db.createObjectStore('test_v2_notes', { keyPath: 'id' });
    };
    const upgraded = await IdbRepository.open('personal', { dbName, systemNow: now, migrations: [recordingV1, v2] });
    expect(ran).toEqual(['v2']);
    expect(await upgraded.loadSnapshot()).toEqual(before);
    upgraded.close();

    // A brand-new database runs every migration once, in order.
    const fresh: string[] = [];
    const db = await openWorkspaceDb(uniqueName('fresh'), [
      (d, t) => {
        fresh.push('v1');
        createStores(d, t);
      },
      () => fresh.push('v2'),
    ]);
    expect(fresh).toEqual(['v1', 'v2']);
    expect(db.version).toBe(2);
    db.close();
  });

  it('T20 a stored record that fails its schema is excluded on load and reported, not repaired', async () => {
    const dbName = uniqueName('corrupt');
    const repo = await IdbRepository.open('personal', { dbName, systemNow: now });
    await addReceipts(repo, [await upload('ok.png')]);
    repo.close();
    const raw = await openDB(dbName);
    const r = (await raw.get('receipts', 'R-0001')) as Record<string, unknown>;
    await raw.put('receipts', { ...r, id: 'R-0002', disposition: 'not-a-disposition' });
    raw.close();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const again = await IdbRepository.open('personal', { dbName, systemNow: now });
    const s = await again.loadSnapshot();
    expect(s.receipts.map((x) => x.id)).toEqual(['R-0001']);
    expect(again.problems.map((p) => [p.store, p.id])).toEqual([['receipts', 'R-0002']]);
    again.close();
  });
});

describe('IndexedDB unit of work', () => {
  it('T25 (IndexedDB) a fault before the audit put leaves no match, ledger or audit record; the next commit succeeds', async () => {
    const dbName = uniqueName('fault');
    const setup = await IdbRepository.open('demo', { dbName });
    await loadDemoBatch(setup, 1, assets);
    const before = await setup.loadSnapshot();
    setup.close();
    const faulty = await IdbRepository.open('demo', { dbName, faultAt: { store: 'audit', nth: 1 } });
    await expect(confirmCaseOnly(faulty, { receiptId: 'R-102', transactionId: txIdByRef(before, 'S-102'), reason: TOUR_REASON })).rejects.toThrow(/Injected storage fault/);
    expect(await faulty.loadSnapshot()).toEqual(before);
    faulty.close();
    const ok = await IdbRepository.open('demo', { dbName });
    await confirmCaseOnly(ok, { receiptId: 'R-102', transactionId: txIdByRef(before, 'S-102'), reason: TOUR_REASON });
    const s = await ok.loadSnapshot();
    expect(s.matches).toHaveLength(1);
    expect(s.ledger).toHaveLength(1);
    expect(s.audit.length).toBeGreaterThan(before.audit.length);
    ok.close();
  });

  it('S-3 the byActiveTxn unique index refuses a second active link even if domain checks were bypassed', async () => {
    const repo = makeRepo('demo', {}, 'indexeddb');
    await tourToConfirmedR102(repo);
    const s = await repo.loadSnapshot();
    const m = s.matches[0]!;
    const second = { ...m, id: 'M-0099', subject: { kind: 'receipt' as const, id: 'R-103' }, activeSubjectKey: 'receipt:R-103' };
    await expect(repo.unitOfWork(['matches'], (_state, w) => w.put('matches', second))).rejects.toBeInstanceOf(AlreadyLinkedError);
    expect((await repo.loadSnapshot()).matches).toEqual(s.matches);
  });
});
