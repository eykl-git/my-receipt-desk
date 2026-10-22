/**
 * App store (design §2): holds the two workspace repositories, the current
 * snapshots and UI state. After every command it reloads the snapshot; the
 * evaluations and metrics are memoised on the snapshot object, so a render
 * without a new snapshot recomputes nothing. UI code never touches storage
 * directly and never stores a proposal.
 */
import { useSyncExternalStore } from 'react';
import { assetUrl } from '../config/base';
import { prefetchDemoAssets, type DemoAssets } from '../demo/assets';
import { demoBatch, nextUnloadedBatch, type BatchNumber } from '../demo/batches';
import { AlreadyLinkedError, DemoAssetsError, StaleProposalError, ValidationError } from '../domain/errors';
import { deriveMetrics, type Metrics } from '../domain/metrics';
import type { WorkspaceId } from '../domain/primitives';
import { deriveWorkspaceView, type WorkspaceView } from '../domain/views';
import { advanceTourStep, loadDemoBatch, newRecordRun, recordAllReady, type RecordRun } from '../persistence/commands';
import { classifyStorageError } from '../persistence/errors';

import { buildFixtureSnapshot } from '../persistence/fixtureSnapshot';
import type { FixtureSnapshot } from '../demo/compare';
import { asWorkspaceState } from '../persistence/commands/context';
import { duplicateUploadNotice } from '../persistence/commands/demo';
import { MemoryRepository } from '../persistence/memoryRepository';
import type { Repository, StorageProblem, WorkspaceSnapshot } from '../persistence/repository';
import { setWorkspaceCurrency } from '../persistence/commands';
import { deleteDatabase, deleteWorkspaceDb, OCR_CACHE_DB, openWorkspace, readLastWorkspace, writeLastWorkspace } from '../persistence/workspaces';
import type { WorkspaceCurrency } from '../domain/schemas';
import { COPY } from './copy';
import type { AppState, DialogState, DrawerState, ListFilter, Notice, OcrOutcome, TabId } from './state';

export interface Derived {
  view: WorkspaceView;
  baseline: WorkspaceView;
  metrics: Metrics;
}

export type ActionResult = { ok: true } | { ok: false; message: string };

/** Map an error to the user message (design §11.5); unexpected errors are logged. */
export function errorMessage(e: unknown, action: string): string {
  if (e instanceof ValidationError || e instanceof StaleProposalError || e instanceof AlreadyLinkedError || e instanceof DemoAssetsError) {
    console.info(e.message);
    return e.message;
  }
  console.error(e);
  const kind = classifyStorageError(e);
  if (kind === 'quota') return COPY.storageFull;
  if (kind === 'newer_version') return COPY.storageBanner.newer_version;
  return COPY.notSaved(action);
}

const HIGHLIGHT_MS = 4000;

export class AppStore {
  repos: Record<WorkspaceId, Repository>;
  private state: AppState;
  private listeners = new Set<() => void>();
  private derivedCache = new WeakMap<WorkspaceSnapshot, Derived>();
  private assets: DemoAssets | null = null;
  private timers: number[] = [];
  private fixtureCache: { key: string; promise: Promise<FixtureSnapshot> } | null = null;
  /** The "Record all ready" run in progress: its pause handle (memory only, §11.4). */
  private currentRun: RecordRun | null = null;
  /** Workspaces whose stored database is newer than the app (§11.5); they run in memory. */
  private newer = new Set<WorkspaceId>();

  constructor() {
    this.repos = { demo: new MemoryRepository('demo'), personal: new MemoryRepository('personal') };
    this.state = {
      ready: false,
      workspace: 'personal',
      snapshots: { demo: emptySnapshot('demo'), personal: emptySnapshot('personal') },
      view: 'assisted',
      batchFilter: 'all',
      listFilter: 'all',
      tab: 'data',
      drawer: null,
      dialog: null,
      newCard: null,
      pulseCases: [],
      newlyReady: [],
      live: '',
      notice: null,
      demoLoad: 'idle',
      exampleCsv: null,
      busy: false,
      recording: false,
      pausing: false,
      storage: null,
      ocrOutcome: null,
    };
  }

  setOcrOutcome(receiptId: string, outcome: Omit<OcrOutcome, 'receiptId'>): void {
    this.set({ ocrOutcome: { receiptId, ...outcome } });
  }

  // --- subscription ----------------------------------------------------------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = (): AppState => this.state;
  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  // --- derived ---------------------------------------------------------------
  derived(ws: WorkspaceId = this.state.workspace): Derived {
    const snap = this.state.snapshots[ws];
    const hit = this.derivedCache.get(snap);
    if (hit) return hit;
    const state = asWorkspaceState(snap);
    const view = deriveWorkspaceView(state);
    const baseline = deriveWorkspaceView(state, []);
    const d = { view, baseline, metrics: deriveMetrics(state, view, baseline) };
    this.derivedCache.set(snap, d);
    return d;
  }
  snapshot(ws: WorkspaceId = this.state.workspace): WorkspaceSnapshot {
    return this.state.snapshots[ws];
  }
  repo(ws: WorkspaceId = this.state.workspace): Repository {
    return this.repos[ws];
  }

  async refresh(ws: WorkspaceId = this.state.workspace): Promise<WorkspaceSnapshot> {
    const snap = await this.repos[ws].loadSnapshot();
    this.set({ snapshots: { ...this.state.snapshots, [ws]: snap } });
    return snap;
  }

  // --- storage ---------------------------------------------------------------
  /** Open a workspace's IndexedDB database, or fall back to memory with a banner (§11.5). */
  private async openRepo(ws: WorkspaceId): Promise<Repository> {
    const { repo, fallback } = await openWorkspace(ws, () => this.set({ storage: 'blocking' }));
    if (fallback === 'newer_version') this.newer.add(ws);
    if (fallback) this.set({ storage: fallback });
    return repo;
  }

  /** Delete a workspace's data and start it empty (same kind of storage as before). */
  private async recreate(ws: WorkspaceId): Promise<void> {
    const old = this.repos[ws];
    if (old.kind === 'memory') {
      this.repos[ws] = new MemoryRepository(ws);
      return;
    }
    old.close();
    await deleteWorkspaceDb(ws, () => this.notify(COPY.deleteBlocked, 'error'));
    this.repos[ws] = await this.openRepo(ws);
  }

  // --- startup ---------------------------------------------------------------
  async init(): Promise<void> {
    const [demo, personal] = await Promise.all([this.openRepo('demo'), this.openRepo('personal')]);
    this.repos = { demo, personal };
    await Promise.all([this.refresh('demo'), this.refresh('personal')]);
    // Restore the last-used workspace (§11.1: the choice only, no data).
    if (readLastWorkspace() === 'demo') {
      this.set({ workspace: 'demo' });
      this.prefetchUnloaded();
    }
    this.set({ ready: true });
    void this.fetchExampleCsv();
    const params = new URLSearchParams(window.location.search);
    // Browser-test aid (design §20 A-S5-6): a bounded wait between "Record all ready" commits.
    const delay = Number(params.get('recordDelay'));
    if (Number.isInteger(delay) && delay > 0) this.commitDelayMs = Math.min(delay, 2000);
    if (params.get('demo') === '1') {
      params.delete('demo');
      const q = params.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${q ? `?${q}` : ''}${window.location.hash}`);
      await this.tryDemo();
    }
  }

  private async fetchExampleCsv(): Promise<void> {
    try {
      const res = await fetch(assetUrl('demo/example-card-statement.csv'));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.set({ exampleCsv: new Uint8Array(await res.arrayBuffer()) });
    } catch (e) {
      console.warn('Example CSV could not be loaded', e);
      this.set({ exampleCsv: 'failed' });
    }
  }

  // --- notices ---------------------------------------------------------------
  announce(text: string): void {
    this.set({ live: text });
  }
  notify(text: string, tone: Notice['tone'] = 'info'): void {
    // The banner itself is a status/alert region, so the live region is not repeated.
    this.set({ notice: { text, tone } });
  }
  dismissNotice(): void {
    this.set({ notice: null });
  }

  // --- navigation ------------------------------------------------------------
  switchWorkspace(ws: WorkspaceId): void {
    if (ws === this.state.workspace) return;
    writeLastWorkspace(ws);
    this.set({ workspace: ws, batchFilter: 'all', listFilter: 'all', drawer: null, notice: null });
    if (ws === 'demo') this.prefetchUnloaded();
  }
  setView(view: AppState['view']): void {
    this.set({ view });
  }
  setBatchFilter(batchFilter: string): void {
    this.set({ batchFilter });
  }
  setListFilter(listFilter: ListFilter): void {
    this.set({ listFilter });
  }
  setTab(tab: TabId): void {
    this.set({ tab });
  }
  openDialog(dialog: DialogState): void {
    this.set({ dialog });
  }
  closeDialog(): void {
    this.set({ dialog: null });
  }
  setDrawer(drawer: DrawerState | null): void {
    this.set({ drawer, ...(drawer === null ? { ocrOutcome: null } : {}) });
  }

  // --- guided demo -----------------------------------------------------------
  private unloaded(): BatchNumber[] {
    const loaded = this.snapshot('demo').demoState.loadedBatches;
    return [1, 2, 3].filter((n) => demoBatch(n) && !loaded.includes(n as BatchNumber)) as BatchNumber[];
  }

  /** Prefetch every unloaded batch whenever the demo workspace becomes active (§9.1). */
  private prefetchUnloaded(): void {
    const batches = this.unloaded();
    if (batches.length === 0) return;
    prefetchDemoAssets(batches)
      .then((a) => {
        this.assets = a;
      })
      .catch((e: unknown) => console.warn('Demo files could not be prefetched', e));
  }

  private async loadBatch(n: BatchNumber): Promise<boolean> {
    this.set({ demoLoad: 'loading', notice: null });
    try {
      const assets = this.assets && this.assets.csvs.has(n) ? this.assets : await prefetchDemoAssets(this.unloaded());
      this.assets = assets;
      const result = await loadDemoBatch(this.repos.demo, n, assets);
      await this.refresh('demo');
      this.set({ demoLoad: 'idle' });
      const title = demoBatch(n)!.title;
      const dup = result.duplicateUploads[0];
      if (dup) this.notify(`${title} is loaded. ${duplicateUploadNotice(dup.matchedReceiptId)}`);
      else this.announce(`${title} is loaded.`);
      return true;
    } catch (e) {
      const message = e instanceof DemoAssetsError ? COPY.demoAssetsFailed : errorMessage(e, `loading Batch ${n}`);
      if (e instanceof DemoAssetsError) console.warn(e);
      this.set({ demoLoad: 'error' });
      this.notify(message, 'error');
      return false;
    }
  }

  async tryDemo(): Promise<void> {
    this.switchWorkspace('demo');
    if (this.snapshot('demo').demoState.loadedBatches.length > 0) return;
    await this.loadBatch(1);
  }

  async nextBatch(): Promise<void> {
    const next = nextUnloadedBatch(this.snapshot('demo').demoState.loadedBatches);
    if (next) await this.loadBatch(next.n);
  }

  /**
   * "Restart demo" (§9.1, N7): first make sure every demo file is in memory;
   * only then delete and recreate the demo workspace and load Batch 1. If the
   * files can't be loaded, the demo workspace is left exactly as it was.
   */
  async restartDemo(): Promise<boolean> {
    this.set({ demoLoad: 'loading', notice: null });
    let assets: DemoAssets;
    try {
      assets = await prefetchDemoAssets([1, 2, 3]);
    } catch (e) {
      console.warn(e);
      this.set({ demoLoad: 'error' });
      this.notify(COPY.demoAssetsFailed, 'error');
      return false;
    }
    this.assets = assets;
    await this.recreate('demo');
    await this.refresh('demo');
    this.set({
      drawer: null,
      newCard: null,
      pulseCases: [],
      newlyReady: this.state.newlyReady.filter((n) => n.workspace !== 'demo'),
      batchFilter: 'all',
      listFilter: 'all',
    });
    const ok = await this.loadBatch(1);
    if (ok) this.notify(COPY.restartDone);
    return ok;
  }

  /**
   * The immutable fixture snapshot of the loaded batches for the comparison
   * replay (§9.2). Built once per set of loaded batches from the bundled files.
   */
  fixtureSnapshot(): Promise<FixtureSnapshot> {
    const loaded = [...this.snapshot('demo').demoState.loadedBatches].sort() as BatchNumber[];
    const key = loaded.join(',');
    if (this.fixtureCache?.key === key) return this.fixtureCache.promise;
    const promise = prefetchDemoAssets(loaded).then((a) => buildFixtureSnapshot(loaded, a));
    const entry = { key, promise };
    this.fixtureCache = entry;
    promise.catch(() => {
      if (this.fixtureCache === entry) this.fixtureCache = null;
    });
    return promise;
  }

  // --- recording -------------------------------------------------------------
  /**
   * "Record all ready" (§6.3, §11.4): bounded, sorted, each case revalidated in
   * its own unit of work. "Pause processing" stops before the next record;
   * entries already recorded stay recorded. The run (and its pause) ends here.
   */
  async recordAllReady(): Promise<void> {
    if (this.state.recording) return;
    const ws = this.state.workspace;
    const shown = this.derived(ws).view.groups.ready.flatMap((c) => (c.proposal ? [c.proposal] : []));
    if (shown.length === 0) return;
    const run = newRecordRun();
    this.currentRun = run;
    this.set({ recording: true, busy: true, pausing: false });
    try {
      const r = await recordAllReady(this.repos[ws], run, shown, {
        onCommitted: () => {
          void this.refresh(ws);
          if (this.commitDelayMs > 0) return new Promise<void>((res) => window.setTimeout(res, this.commitDelayMs));
          return undefined;
        },
      });
      await this.refresh(ws);
      const text = COPY.recordAllDone(r.recorded.length, r.skipped.length, r.remaining.length, r.paused);
      if (r.paused || r.remaining.length > 0) this.notify(text);
      else this.announce(text);
    } catch (e) {
      await this.refresh(ws);
      this.notify(errorMessage(e, 'recording the ready cases'), 'error');
    } finally {
      this.currentRun = null;
      this.set({ recording: false, busy: false, pausing: false });
    }
  }

  /**
   * Test and demo aid only: a pause between commits of "Record all ready" so a
   * browser test can press "Pause processing" mid-run. 0 (no wait) by default;
   * set from `?recordDelay=<ms>` in the URL.
   */
  commitDelayMs = 0;

  /** "Pause processing": stops the run before its next record (§11.4). */
  pauseRun(): void {
    if (!this.currentRun || this.currentRun.paused) return;
    this.currentRun.paused = true;
    this.set({ pausing: true });
  }

  // --- storage problems (§11.5) ---------------------------------------------
  /** Stored records that failed their check on the last load (IndexedDB only). */
  storageProblems(ws: WorkspaceId = this.state.workspace): readonly StorageProblem[] {
    return this.repos[ws].problems ?? [];
  }

  /** "Delete this record" for a listed storage problem; reloads the workspace. */
  async deleteProblem(problem: StorageProblem): Promise<ActionResult> {
    const ws = this.state.workspace;
    const repo = this.repos[ws];
    if (!repo.deleteProblem) return { ok: false, message: COPY.notSaved('deleting the record') };
    try {
      await repo.deleteProblem(problem);
      await this.refresh(ws);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errorMessage(e, 'deleting the record') };
    }
  }

  /**
   * The workspace "Delete data in this workspace" acts on: the current one if
   * its database is newer than the app, else the other one that is.
   */
  newerWorkspace(): WorkspaceId | null {
    if (this.newer.has(this.state.workspace)) return this.state.workspace;
    return [...this.newer][0] ?? null;
  }

  /**
   * Called only from the banner's confirm step (§11.5, A-S5-12): deletes the
   * newer-version database and reopens that workspace empty. The other
   * workspace is not touched.
   */
  async deleteNewerWorkspace(): Promise<void> {
    const ws = this.newerWorkspace();
    if (!ws) return;
    this.repos[ws].close();
    await deleteWorkspaceDb(ws, () => this.notify(COPY.deleteBlocked, 'error'));
    this.newer.delete(ws);
    const { repo, fallback } = await openWorkspace(ws, () => this.set({ storage: 'blocking' }));
    if (fallback === 'newer_version') this.newer.add(ws);
    this.repos[ws] = repo;
    this.set({ storage: fallback ?? (this.newer.size > 0 ? 'newer_version' : null) });
    await this.refresh(ws);
    this.notify(ws === 'demo' ? COPY.resetDone.demo : COPY.resetDone.personal);
  }

  async continueTour(): Promise<void> {
    if (await advanceTourStep(this.repos.demo, 2)) await this.refresh('demo');
  }

  // --- drawer ----------------------------------------------------------------
  async openCase(receiptId: string): Promise<void> {
    this.set({ drawer: { kind: 'case', receiptId, panel: null } });
    if (this.state.workspace === 'demo' && this.snapshot('demo').demoState.tourStep === 1) await this.continueTour();
  }
  openInvoice(payableId: string): void {
    this.set({ drawer: { kind: 'invoice', payableId } });
  }
  async openTransaction(transactionId: string): Promise<void> {
    this.set({ drawer: { kind: 'transaction', transactionId } });
    if (this.state.workspace === 'demo' && this.snapshot('demo').demoState.tourStep === 1) await this.continueTour();
  }

  /** Close the drawer. After an activation, the highlight and badges start now (M2). */
  closeDrawer(): void {
    const d = this.state.drawer;
    const summary = d && (d.kind === 'case' || d.kind === 'rule') ? d.panel?.summary : null;
    this.set({ drawer: null, ocrOutcome: null });
    if (summary) this.startHighlight(summary.ruleId, summary.version, summary.affected, summary.newlyReady);
  }

  startHighlight(ruleId: string, version: number, affected: string[], newlyReady: string[]): void {
    this.set({
      newCard: ruleId,
      pulseCases: affected,
      newlyReady: [...this.state.newlyReady.filter((n) => !(n.ruleId === ruleId && n.workspace === this.state.workspace)), { workspace: this.state.workspace, ruleId, version, caseIds: newlyReady }],
    });
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [window.setTimeout(() => this.set({ newCard: null, pulseCases: [] }), HIGHLIGHT_MS)];
  }

  // --- reset -----------------------------------------------------------------
  /**
   * "Reset demo", "Delete my files data", "Delete all data in this browser"
   * (§11.6): each deletes whole databases. Resetting the demo never touches My
   * files. Deleting everything also removes the remembered workspace and the
   * downloaded OCR language files (ocr-design §6), and returns to the first screen.
   */
  async reset(kind: 'demo' | 'personal' | 'all'): Promise<void> {
    if (kind === 'demo' || kind === 'all') {
      await this.recreate('demo');
      this.assets = null;
    }
    if (kind === 'personal' || kind === 'all') await this.recreate('personal');
    if (kind === 'all') {
      writeLastWorkspace(null);
      if (typeof indexedDB !== 'undefined') {
        await deleteDatabase(OCR_CACHE_DB, () => this.notify(COPY.deleteBlocked, 'error')).catch((e: unknown) => console.error(e));
      }
    }
    await Promise.all([this.refresh('demo'), this.refresh('personal')]);
    this.set({
      drawer: null,
      dialog: null,
      newCard: null,
      pulseCases: [],
      newlyReady: kind === 'all' ? [] : this.state.newlyReady.filter((n) => n.workspace !== kind),
      batchFilter: 'all',
      listFilter: 'all',
      demoLoad: 'idle',
      ...(kind === 'all' ? { workspace: 'personal' as const, view: 'assisted' as const } : {}),
    });
    this.notify(COPY.resetDone[kind]);
    if (this.state.workspace === 'demo') this.prefetchUnloaded();
  }

  /** My files currency (REQ-20): only while the workspace is empty; refused otherwise. */
  async setCurrency(currency: WorkspaceCurrency): Promise<ActionResult> {
    const r = await this.run('the currency', (repo) => setWorkspaceCurrency(repo, currency));
    if (r.ok) this.announce(COPY.currencySet(currency));
    return r;
  }

  /** Run a command against the current workspace and reload; errors become messages. */
  async run(action: string, fn: (repo: Repository) => Promise<unknown>): Promise<ActionResult> {
    const ws = this.state.workspace;
    this.set({ busy: true });
    try {
      await fn(this.repos[ws]);
      await this.refresh(ws);
      return { ok: true };
    } catch (e) {
      await this.refresh(ws);
      return { ok: false, message: errorMessage(e, action) };
    } finally {
      this.set({ busy: false });
    }
  }
}

function emptySnapshot(workspaceId: WorkspaceId): WorkspaceSnapshot {
  return {
    workspaceId,
    schemaVersion: 1,
    counters: {},
    demoState: { loadedBatches: [], tourStep: 1, clockTick: 0 },
    currency: 'HKD',
    sourceDocuments: [],
    receipts: [],
    transactions: [],
    payables: [],
    matches: [],
    ledger: [],
    ruleHeads: [],
    ruleVersions: [],
    decisions: [],
    audit: [],
  };
}

export const store = new AppStore();

export function useAppState(): AppState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** The derived view of the current workspace (memoised per snapshot). */
export function useDerived(): Derived {
  const s = useAppState();
  return store.derived(s.workspace);
}
