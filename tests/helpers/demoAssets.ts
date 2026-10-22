/** Reads the bundled demo files from disk, in the shape the UI's prefetch returns (review-3 amendment N3). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DemoAssets } from '../../src/demo/assets';
import { DEMO_BATCHES } from '../../src/demo/batches';
import { receiptFixture } from '../../src/demo/fixtures';

export function loadDemoAssetsFromDisk(dir = 'public/demo'): DemoAssets {
  const root = join(process.cwd(), dir);
  const svgs = new Map<string, Uint8Array>();
  const csvs = new Map<1 | 2 | 3, Uint8Array>();
  for (const b of DEMO_BATCHES) {
    csvs.set(b.n, new Uint8Array(readFileSync(join(root, 'statements', b.csvFileName))));
    for (const id of b.fixtureIds) svgs.set(id, new Uint8Array(readFileSync(join(root, 'receipts', receiptFixture(id).file))));
  }
  return { svgs, csvs };
}
