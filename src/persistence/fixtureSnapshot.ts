/**
 * Builds the immutable fixture snapshot for "Compare without this rule"
 * (design §9.2). The bundled demo files of the loaded batches go through the
 * same loader as the tour (`loadDemoBatch`, so the same adapter, CSV parser
 * and IDs) into a private, throwaway in-memory workspace that is never
 * connected to the live one. Only the fixture receipts and card rows are
 * kept, deep-frozen: no live matches, decisions, field edits or rules.
 */
import type { DemoAssets } from '../demo/assets';
import type { BatchNumber } from '../demo/batches';
import { deepFreeze, type FixtureSnapshot } from '../demo/compare';
import { loadDemoBatch } from './commands/demo';
import { MemoryRepository } from './memoryRepository';

export async function buildFixtureSnapshot(loadedBatches: readonly number[], assets: DemoAssets): Promise<FixtureSnapshot> {
  const scratch = new MemoryRepository('demo');
  const batches = [...loadedBatches].sort() as BatchNumber[];
  const duplicateUploads: Array<{ fixtureId: string; matchedReceiptId: string }> = [];
  for (const n of batches) {
    const r = await loadDemoBatch(scratch, n, assets);
    duplicateUploads.push(...r.duplicateUploads);
  }
  const s = await scratch.loadSnapshot();
  return deepFreeze({
    batches,
    receipts: structuredClone([...s.receipts]),
    transactions: structuredClone([...s.transactions]),
    duplicateUploads,
  });
}
