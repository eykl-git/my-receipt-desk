/**
 * Integrity, history and failures (tasks 5.1, 5.2, 5.4, 5.5): T14 edit
 * sub-case, T15 stale proposals at commit, T16 void and unlink sub-cases,
 * T24 pause and the per-run limit, T25 failed storage leaves nothing
 * half-written, and the §11.5 failure handling. Each suite runs on
 * MemoryRepository and IndexedDB.
 */
import { openDB } from 'idb';
import { describe, expect, it, vi } from 'vitest';
import { StaleProposalError } from '../../src/domain/errors';
import { missingEvidence } from '../../src/domain/ledger/evidence';
import { classifyStorageError } from '../../src/persistence/errors';
import { IdbRepository } from '../../src/persistence/idb/idbRepository';
import { DB_NAMES } from '../../src/persistence/idb/schema';
import { deleteDatabase, openWorkspace } from '../../src/persistence/workspaces';
import { COPY } from '../../src/ui/copy';
import { errorMessage } from '../../src/ui/store';
import { previewImpact } from '../../src/domain/knowledge/preview';
import { toDraftContent } from '../../src/domain/knowledge/schema';
import {
  activateRule,
  confirmCaseOnly,
  discardDraft,
  editRule,
  loadDemoBatch,
  recordProposal,
  recordStatementOnly,
  saveFields,
  unlinkReceipt,
  voidEntry,
} from '../../src/persistence/commands';
import { newRecordRun, recordAllReady } from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { MemoryRepository } from '../../src/persistence/memoryRepository';
import type { Repository, StoreName } from '../../src/persistence/repository';
import { receipt, recorded, tx } from '../builders';
import { describeEachRepo, makeRepo } from '../helpers/repos';
import { addReceipt, importCsv, personalRepo } from '../helpers/personal';
import { assets, demoRepo, teachAlias, tourToConfirmedR102, TOUR_REASON, txIdByRef, viewOf } from '../helpers/tour';

describeEachRepo('T14 edit sub-case', () => {
  it('T14 (edit) "Edit" creates v2 as a draft while v1 stays active; activating v2 supersedes v1; a discarded draft stays readable and v1 stays active', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    const s0 = await repo.loadSnapshot();
    const v1 = s0.ruleVersions[0]!;
    // Edit → v2 draft; v1 keeps applying.
    expect(await editRule(repo, 'K-ALIAS-0001', toDraftContent(v1))).toEqual({ ruleId: 'K-ALIAS-0001', version: 2 });
    const s1 = await repo.loadSnapshot();
    expect(s1.ruleHeads[0]).toMatchObject({ status: 'active', activeVersion: 1, currentVersion: 2, draftVersion: 2, lastApprovedVersion: 1 });
    expect(s1.ruleVersions.map((v) => [v.version, v.approvedAt !== undefined])).toEqual([
      [1, true],
      [2, false],
    ]);
    expect(viewOf(s1).caseById.get('R-103')!.proposal!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(s1.audit.at(-1)!.action).toBe('rule.draft_created');
    // A second edit while a draft is open is refused.
    await expect(editRule(repo, 'K-ALIAS-0001', toDraftContent(v1))).rejects.toThrow('already has an open draft (v2)');
    // Discard: the draft stays readable, v1 stays active.
    await discardDraft(repo, 'K-ALIAS-0001');
    const s2 = await repo.loadSnapshot();
    expect(s2.ruleHeads[0]).toMatchObject({ status: 'active', activeVersion: 1, draftVersion: null, currentVersion: 2 });
    expect(s2.ruleVersions.find((v) => v.version === 2)!.discardedAt).toBeDefined();
    // Edit again → v3; activate it → v1 is superseded but stays approved and unchanged.
    expect((await editRule(repo, 'K-ALIAS-0001', toDraftContent(v1))).version).toBe(3);
    const s3 = await repo.loadSnapshot();
    const v3 = s3.ruleVersions.find((v) => v.version === 3)!;
    await activateRule(repo, 'K-ALIAS-0001', 3, previewImpact(asWorkspaceState(s3), { kind: 'activate', version: v3 }).stateFingerprint);
    const s4 = await repo.loadSnapshot();
    expect(s4.ruleHeads[0]).toMatchObject({ status: 'active', activeVersion: 3, lastApprovedVersion: 3, draftVersion: null });
    expect(s4.ruleVersions.find((v) => v.version === 1)).toEqual(v1);
    expect(viewOf(s4).caseById.get('R-103')!.proposal!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 3 }]);
    // R-103 relied on v1, so its pending proposal is invalidated in the audit log.
    expect(s4.audit.slice(-2).map((a) => a.action)).toEqual(['proposals.invalidated', 'rule.activated']);
    expect(s4.audit.at(-2)!.affected).toEqual([
      { kind: 'rule', id: 'K-ALIAS-0001' },
      { kind: 'receipt', id: 'R-103' },
    ]);
    // The recorded entry (R-102, manual) is not touched.
    expect(s4.ledger).toEqual(s0.ledger);
  });
});

describeEachRepo('T15 stale proposals at commit', () => {
  it('T15 (competing commit) a shown proposal whose card transaction was linked meanwhile is refused with transaction_taken; nothing is written', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    const s0 = await repo.loadSnapshot();
    const shown = viewOf(s0).caseById.get('R-103')!.proposal!;
    // A competing commit: R-103 is recorded once from another screen.
    await recordProposal(repo, shown);
    const s1 = await repo.loadSnapshot();
    const e = await recordProposal(repo, shown).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StaleProposalError);
    expect((e as StaleProposalError).reason).toBe('transaction_taken');
    expect(await repo.loadSnapshot()).toEqual(s1);
  });

  it('T15 (receipt edited) a shown proposal is refused with receipt_changed after the receipt fields change; nothing is written', async () => {
    const repo = personalRepo();
    await importCsv(repo, 'Date,Posted,Details,Amount,Currency\n2026-04-02,2026-04-03,PAGE CORNER,-120.00,HKD\n');
    const id = await addReceipt(repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
    const shown = viewOf(await repo.loadSnapshot()).caseById.get(id)!.proposal!;
    expect(shown.outcome).toBe('unique_candidate');
    await saveFields(repo, id, { merchant: 'Page Corner', date: '2026-04-03', amount: '120.00', currency: 'HKD' });
    const s = await repo.loadSnapshot();
    const e = await recordProposal(repo, shown).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StaleProposalError);
    expect((e as StaleProposalError).reason).toBe('receipt_changed');
    expect(await repo.loadSnapshot()).toEqual(s);
  });
});

describeEachRepo('T16 corrections', () => {
  it('T16 (void) voiding R-105’s manually chosen entry releases the match, keeps the entry as voided, frees the card row and returns R-105 to review', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s0 = await repo.loadSnapshot();
    const s105a = txIdByRef(s0, 'S-105A');
    const { ledgerEntryId, matchId } = await confirmCaseOnly(repo, { receiptId: 'R-105', transactionId: s105a, reason: 'The parking slip time matches S-105A' });
    const s1 = await repo.loadSnapshot();
    expect(viewOf(s1).caseById.get('R-105')!.group).toBe('recorded');
    await expect(voidEntry(repo, ledgerEntryId, 'no')).rejects.toThrow('Reason must be');
    await voidEntry(repo, ledgerEntryId, 'Chose the wrong card row');
    const s2 = await repo.loadSnapshot();
    const entry = s2.ledger.find((e) => e.id === ledgerEntryId)!;
    expect(entry).toMatchObject({ status: 'voided', voidReason: 'Chose the wrong card row', amountMinor: 3000 });
    expect(entry.activeIdentityKey).toBeUndefined();
    const m = s2.matches.find((x) => x.id === matchId)!;
    expect(m).toMatchObject({ status: 'released', releaseReason: 'Chose the wrong card row' });
    expect(m.activeTxnKey).toBeUndefined();
    expect(m.activeSubjectKey).toBeUndefined();
    // The receipt itself is unchanged; it re-evaluates as pending (ambiguous again).
    expect(s2.receipts).toEqual(s1.receipts);
    const c = viewOf(s2).caseById.get('R-105')!;
    expect(c).toMatchObject({ group: 'needs_decision', ledger: 'voided', reconciliation: 'ambiguous', voidedEntryIds: [ledgerEntryId] });
    expect(c.proposal!.candidateIds).toContain(s105a);
    expect(s2.audit.slice(-2).map((a) => a.action)).toEqual(['ledger.voided', 'match.released']);
    // Voiding twice is refused; the transaction can be linked again.
    await expect(voidEntry(repo, ledgerEntryId, 'Again please')).rejects.toThrow('not recorded');
    await confirmCaseOnly(repo, { receiptId: 'R-105', transactionId: txIdByRef(s2, 'S-105B'), reason: 'The other row is the right one' });
    expect((await repo.loadSnapshot()).ledger.filter((e) => e.status === 'recorded')).toHaveLength(1);
  });

  it('T16 (unlink) a statement-only entry with an attached receipt stays recorded with the receipt removed from its evidence', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s0 = await repo.loadSnapshot();
    const s101 = txIdByRef(s0, 'S-101');
    const { ledgerEntryId } = await recordStatementOnly(repo, s101);
    await recordProposal(repo, viewOf(await repo.loadSnapshot()).caseById.get('R-101')!.proposal!);
    const s1 = await repo.loadSnapshot();
    expect(s1.ledger[0]!.evidence.receiptIds).toEqual(['R-101']);
    // "Void entry" is not the receipt's correction here; the domain offers unlink.
    await expect(unlinkReceipt(repo, ledgerEntryId, 'R-103', 'Not on this entry')).rejects.toThrow('not part of that entry');
    await unlinkReceipt(repo, ledgerEntryId, 'R-101', 'Receipt belongs to another purchase');
    const s2 = await repo.loadSnapshot();
    expect(s2.ledger).toHaveLength(1);
    const e = s2.ledger[0]!;
    expect(e).toMatchObject({ id: ledgerEntryId, status: 'recorded', activeIdentityKey: s101, origin: 'statement_only' });
    expect(e.evidence).toEqual({ ...s0.ledger[0]?.evidence, receiptIds: [], transactionIds: [s101], payableIds: [], matchIds: [], sourceDocumentIds: [s0.transactions.find((t) => t.id === s101)!.sourceDocumentId] });
    expect(s2.matches[0]).toMatchObject({ status: 'released' });
    expect(s2.audit.slice(-2).map((a) => a.action)).toEqual(['match.released', 'ledger.evidence_detached']);
    const c = viewOf(s2).caseById.get('R-101')!;
    expect(c.group).toBe('ready');
  });
});

/** Alias path at tour step 4: six cases are ready (R-101, R-103, R-201, R-202, R-203, R-303). */
async function step4AliasPath() {
  const repo = await tourToConfirmedR102();
  await teachAlias(repo);
  await loadDemoBatch(repo, 2, assets);
  await loadDemoBatch(repo, 3, assets);
  return repo;
}

describeEachRepo('T24 pause and bounded runs', () => {
  it('T24 pausing after two commits leaves exactly two complete records; the rest stay ready; a later single "Record" works', async () => {
    const repo = await step4AliasPath();
    const s0 = await repo.loadSnapshot();
    const ready = viewOf(s0).groups.ready.map((c) => c.proposal!);
    expect(ready.map((p) => p.subject.id)).toEqual(['R-101', 'R-103', 'R-201', 'R-202', 'R-203', 'R-303']);
    const run = newRecordRun();
    let calls = 0;
    const result = await recordAllReady(repo, run, ready, {
      onCommitted: () => {
        calls++;
        if (calls === 2) run.paused = true;
      },
    });
    expect(result.paused).toBe(true);
    expect(result.recorded.map((r) => r.receiptId)).toEqual(['R-101', 'R-103']);
    expect(result.remaining).toEqual(['R-201', 'R-202', 'R-203', 'R-303']);
    const s1 = await repo.loadSnapshot();
    // Exactly two complete triples: match + ledger entry + their two audit events each.
    expect(s1.matches.length - s0.matches.length).toBe(2);
    expect(s1.ledger.length - s0.ledger.length).toBe(2);
    expect(s1.audit.slice(s0.audit.length).map((a) => a.action)).toEqual(['match.confirmed', 'ledger.recorded', 'match.confirmed', 'ledger.recorded']);
    for (const r of result.recorded) {
      expect(s1.matches.find((m) => m.id === r.matchId)!.ledgerEntryId).toBe(r.ledgerEntryId);
      expect(s1.ledger.find((e) => e.id === r.ledgerEntryId)!.evidence.matchIds).toEqual([r.matchId]);
    }
    const v1 = viewOf(s1);
    expect(v1.groups.ready.map((c) => c.receiptId)).toEqual(['R-201', 'R-202', 'R-203', 'R-303']);
    // Pause does not persist: a single "Record" afterwards works.
    await recordProposal(repo, v1.caseById.get('R-201')!.proposal!);
    expect(viewOf(await repo.loadSnapshot()).caseById.get('R-201')!.group).toBe('recorded');
  });

  it('T24 a pause pressed while a commit is in flight stops the next one inside its own write; nothing of it is written', async () => {
    const inner = await step4AliasPath();
    const run = newRecordRun();
    let units = 0;
    // A repository whose second unit of work starts after "Pause processing" was pressed.
    const repo: Repository = {
      ...inner,
      kind: inner.kind,
      workspaceId: inner.workspaceId,
      systemNow: inner.systemNow,
      close: () => inner.close(),
      loadSnapshot: () => inner.loadSnapshot(),
      getFile: (k) => inner.getFile(k),
      unitOfWork: (stores, fn) => {
        units++;
        if (units === 2) run.paused = true;
        return inner.unitOfWork(stores, fn);
      },
    };
    const s0 = await inner.loadSnapshot();
    const ready = viewOf(s0).groups.ready.map((c) => c.proposal!);
    const result = await recordAllReady(repo, run, ready);
    expect(result.recorded.map((r) => r.receiptId)).toEqual(['R-101']);
    expect(result.paused).toBe(true);
    expect(result.remaining).toHaveLength(5);
    const s1 = await inner.loadSnapshot();
    expect(s1.matches.length - s0.matches.length).toBe(1);
    expect(s1.demoState.clockTick - s0.demoState.clockTick).toBe(1);
  });

  it('T24 with 55 ready cases one run records at most 50 and reports the other 5 as still ready', async () => {
    const repo = makeRepo('demo');
    const receipts = Array.from({ length: 55 }, (_, i) =>
      receipt({ id: `R-5${String(i + 1).padStart(2, '0')}`, merchant: `Shop ${i + 1}`, date: '2026-03-02', amount: 1000 + i }),
    );
    const transactions = receipts.map((_r, i) => tx({ file: 'many.csv', row: i + 2, ref: `S-5${String(i + 1).padStart(2, '0')}`, label: `SHOP ${i + 1}`, posting: '2026-03-03', amount: 1000 + i }));
    await repo.unitOfWork(['receipts', 'transactions'], (_s, w) => {
      for (const r of receipts) w.put('receipts', r);
      for (const t of transactions) w.put('transactions', t);
    });
    const ready = viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!);
    expect(ready).toHaveLength(55);
    const result = await recordAllReady(repo, newRecordRun(), ready);
    expect(result.recorded).toHaveLength(50);
    expect(result.paused).toBe(false);
    expect(result.remaining).toEqual(['R-551', 'R-552', 'R-553', 'R-554', 'R-555']);
    const s = await repo.loadSnapshot();
    expect(s.ledger).toHaveLength(50);
    expect(viewOf(s).groups.ready.map((c) => c.receiptId)).toEqual(result.remaining);
  });
});

let dbn = 0;
type Fault = { store: StoreName; nth: number } | undefined;
/**
 * The same workspace with and without a fault: IndexedDB opens a second
 * connection to the same database with `faultAt`; the memory repository has
 * one state, so its test hook is switched on and off.
 */
function faultable(kind: 'memory' | 'indexeddb') {
  const name = `t25-${kind}-${++dbn}`;
  const base = makeRepo('demo', { dbName: name }, kind);
  return {
    base,
    with(fault: Fault): Repository {
      if (base instanceof MemoryRepository) {
        base.faultAt = fault;
        return base;
      }
      return makeRepo('demo', { dbName: name, faultAt: fault }, kind);
    },
  };
}

describe('T25 failed storage operations', () => {
  for (const kind of ['memory', 'indexeddb'] as const) {
    for (const store of ['audit', 'ledger', 'matches'] as const) {
      it(`T25 [${kind}] a fault on the ${store} put while recording leaves no match, ledger or audit record; the next commit succeeds`, async () => {
        const f = faultable(kind);
        await loadDemoBatch(f.base, 1, assets);
        const before = await f.base.loadSnapshot();
        const faulty = f.with({ store, nth: 1 });
        await expect(confirmCaseOnly(faulty, { receiptId: 'R-102', transactionId: txIdByRef(before, 'S-102'), reason: TOUR_REASON })).rejects.toThrow(/Injected storage fault/);
        const after = await faulty.loadSnapshot();
        expect(after).toEqual(before);
        expect(after.matches).toEqual([]);
        expect(after.ledger).toEqual([]);
        const ok = f.with(undefined);
        await confirmCaseOnly(ok, { receiptId: 'R-102', transactionId: txIdByRef(before, 'S-102'), reason: TOUR_REASON });
        const s = await ok.loadSnapshot();
        expect(s.matches).toHaveLength(1);
        expect(s.ledger).toHaveLength(1);
        expect(s.audit.slice(before.audit.length).map((a) => a.action)).toEqual(['match.confirmed', 'ledger.recorded']);
      });
    }

    it(`T25 [${kind}] (M3) a fault on transactions during loadDemoBatch(1) leaves no receipt, file, document, transaction or audit record, and loadedBatches/tourStep unchanged`, async () => {
      const f = faultable(kind);
      const faulty = f.with({ store: 'transactions', nth: 1 });
      const before = await faulty.loadSnapshot();
      await expect(loadDemoBatch(faulty, 1, assets)).rejects.toThrow(/Injected storage fault/);
      const after = await faulty.loadSnapshot();
      expect(after).toEqual(before);
      expect(after.receipts).toEqual([]);
      expect(after.sourceDocuments).toEqual([]);
      expect(after.transactions).toEqual([]);
      expect(after.audit).toEqual([]);
      expect(after.demoState).toEqual({ loadedBatches: [], tourStep: 1, clockTick: 0 });
      expect(await faulty.getFile('DOC-0001')).toBeNull();
      const ok = f.with(undefined);
      await loadDemoBatch(ok, 1, assets);
      expect((await ok.loadSnapshot()).demoState).toMatchObject({ loadedBatches: [1], tourStep: 1 });
    });
  }
});

describe('§11.5 failure handling', () => {
  it('storage errors map to their messages: quota, abort and a newer version; known domain errors keep their own text', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const quota = new DOMException('full', 'QuotaExceededError');
    expect(classifyStorageError(quota)).toBe('quota');
    expect(errorMessage(quota, 'recording R-101')).toBe(COPY.storageFull);
    expect(classifyStorageError(new DOMException('aborted', 'AbortError'))).toBe('aborted');
    expect(errorMessage(new DOMException('aborted', 'AbortError'), 'recording R-101')).toBe('Not saved: recording R-101. Nothing was changed.');
    expect(classifyStorageError(Object.assign(new Error('x'), { name: 'VersionError' }))).toBe('newer_version');
    expect(errorMessage(new Error('Injected'), 'voiding L-0001')).toBe('Not saved: voiding L-0001. Nothing was changed.');
    expect(errorMessage(new StaleProposalError('transaction_taken'), 'x')).toContain('This case changed since it was shown');
    vi.restoreAllMocks();
  });

  it('a database saved by a newer app version is left unchanged: the app falls back to memory and says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const raw = await openDB(DB_NAMES.personal, 99, { upgrade: (db) => db.createObjectStore('future') });
    raw.close();
    const opened = await openWorkspace('personal');
    expect(opened.fallback).toBe('newer_version');
    expect(opened.repo.kind).toBe('memory');
    await addReceipt(opened.repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
    const again = await openDB(DB_NAMES.personal);
    expect(again.version).toBe(99);
    expect([...again.objectStoreNames]).toEqual(['future']);
    again.close();
    await deleteDatabase(DB_NAMES.personal);
    vi.restoreAllMocks();
  });

  it('"Delete this record" removes only a listed storage problem; the rest of the workspace stays', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const dbName = `t-problem-${++dbn}`;
    const repo = await IdbRepository.open('personal', { dbName, systemNow: () => '2026-04-20T10:00:00.000Z' });
    await addReceipt(repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
    repo.close();
    const raw = await openDB(dbName);
    const r = (await raw.get('receipts', 'R-0001')) as Record<string, unknown>;
    await raw.put('receipts', { ...r, id: 'R-0009', disposition: 'broken' });
    raw.close();
    const again = await IdbRepository.open('personal', { dbName });
    const s = await again.loadSnapshot();
    expect(again.problems.map((p) => p.id)).toEqual(['R-0009']);
    await expect(again.deleteProblem({ store: 'receipts', id: 'R-0001' })).rejects.toThrow('not a listed storage problem');
    await again.deleteProblem({ store: 'receipts', id: 'R-0009' });
    expect(again.problems).toEqual([]);
    const s2 = await again.loadSnapshot();
    expect(again.problems).toEqual([]);
    expect(s2).toEqual(s);
    again.close();
    vi.restoreAllMocks();
  });

  it('broken evidence references are listed, never repaired', () => {
    const r = receipt({ id: 'R-101', merchant: 'Page Corner', date: '2026-03-02', amount: 12000 });
    const t = tx({ file: 'b.csv', row: 2, ref: 'S-101', label: 'PAGE CORNER', posting: '2026-03-03', amount: 12000 });
    const { entry } = recorded({ n: 1, receipt: r, transaction: t });
    const missing = missingEvidence([entry], { receipts: [], transactions: [t], sourceDocuments: [] });
    expect([...missing.entries()]).toEqual([['L-0001', ['R-101', ...entry.evidence.sourceDocumentIds]]]);
  });
});
