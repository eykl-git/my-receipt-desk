/**
 * Restart-failure test (design §9.1, review-3 amendment N7): "Restart demo"
 * first awaits every demo file; if that fails, the demo workspace is left
 * exactly as it was. On success it starts again from Batch 1 at step 1.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../../src/ui/store';
import { COPY } from '../../src/ui/copy';
import { loadDemoBatch } from '../../src/persistence/commands';
import { assets, teachAlias, tourToConfirmedR102 } from '../helpers/tour';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function storeAtStep3() {
  const store = new AppStore();
  await tourToConfirmedR102(store.repos.demo as never);
  await teachAlias(store.repos.demo as never);
  await loadDemoBatch(store.repos.demo, 2, assets);
  await store.refresh('demo');
  return store;
}

describe('restart demo (N7)', () => {
  it('restart-failure: a rejected prefetch writes nothing and leaves the demo workspace unchanged', async () => {
    const store = await storeAtStep3();
    const repoBefore = store.repos.demo;
    const before = await repoBefore.loadSnapshot();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))));
    expect(await store.restartDemo()).toBe(false);
    expect(store.repos.demo).toBe(repoBefore);
    expect(await store.repos.demo.loadSnapshot()).toEqual(before);
    expect(store.get().notice).toEqual({ text: COPY.demoAssetsFailed, tone: 'error' });
    expect(store.get().demoLoad).toBe('error');
  });

  it('restart success: the demo workspace is recreated with Batch 1 only at step 1; My files is not touched', async () => {
    const store = await storeAtStep3();
    const personalBefore = await store.repos.personal.loadSnapshot();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        const path = String(url).replace(/^\//, '');
        const bytes = readFileSync(join(process.cwd(), 'public', path));
        return Promise.resolve(new Response(bytes));
      }),
    );
    expect(await store.restartDemo()).toBe(true);
    const s = await store.repos.demo.loadSnapshot();
    expect(s.demoState.loadedBatches).toEqual([1]);
    expect(s.demoState.tourStep).toBe(1);
    expect(s.ruleHeads).toEqual([]);
    expect(s.matches).toEqual([]);
    expect(s.receipts.map((r) => r.id)).toEqual(['R-101', 'R-102', 'R-103', 'R-104', 'R-105']);
    expect(await store.repos.personal.loadSnapshot()).toEqual(personalBefore);
    expect(store.get().notice).toEqual({ text: COPY.restartDone, tone: 'info' });
  });
});
