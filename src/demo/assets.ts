/**
 * Demo asset prefetch (design §9.1, review-3 amendment N3). Whenever the demo
 * workspace becomes active, the files of every unloaded batch are fetched from
 * the app's own origin (resolved against the base path) into memory, so later
 * batches still load offline. A failed fetch is forgotten so the next attempt
 * starts a new one.
 */
import { assetUrl } from '../config/base';
import { DemoAssetsError } from '../domain/errors';
import { demoBatch, type BatchNumber } from './batches';
import { receiptFixture } from './fixtures';

export interface DemoAssets {
  /** fixtureId → SVG bytes (R-204 carries the bytes of R-102.svg). */
  svgs: Map<string, Uint8Array>;
  csvs: Map<BatchNumber, Uint8Array>;
}

const cache = new Map<string, Promise<Uint8Array>>();

function fetchBytes(path: string): Promise<Uint8Array> {
  const hit = cache.get(path);
  if (hit) return hit;
  const p = fetch(assetUrl(path))
    .then(async (res) => {
      if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    })
    .catch((e: unknown) => {
      cache.delete(path);
      throw e;
    });
  cache.set(path, p);
  return p;
}

export async function prefetchDemoAssets(batches: readonly BatchNumber[]): Promise<DemoAssets> {
  const svgs = new Map<string, Uint8Array>();
  const csvs = new Map<BatchNumber, Uint8Array>();
  try {
    await Promise.all(
      batches.map(async (n) => {
        const batch = demoBatch(n);
        if (!batch) return;
        csvs.set(n, await fetchBytes(batch.csvPath));
        for (const id of batch.fixtureIds) svgs.set(id, await fetchBytes(`demo/receipts/${receiptFixture(id).file}`));
      }),
    );
  } catch (e) {
    throw new DemoAssetsError(e);
  }
  return { svgs, csvs };
}
