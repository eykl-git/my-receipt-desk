/**
 * Guided-demo batch registry (S12, design §8). Only implemented batches are
 * listed, so "Next batch" is offered only while a listed batch is unloaded.
 * Demo statements go through the normal CSV pipeline with this fixed mapping.
 */
import type { ColumnMapping, ImportConventions } from '../domain/imports/mapping';

export type BatchNumber = 1 | 2 | 3;

export interface DemoBatch {
  n: BatchNumber;
  title: string;
  /** Receipt fixture IDs, in upload order. */
  fixtureIds: readonly string[];
  /** CSV path inside public/. */
  csvPath: string;
  csvFileName: string;
  /** Tour step after this batch is loaded (review-3 amendment M3). */
  tourStepAfterLoad: 1 | 3 | 4;
}

export const DEMO_ACCOUNT_LABEL = 'Demo Card ••1234';

/** Demo CSV columns: Reference,Transaction date,Posting date,Description,Amount,Currency,Type. */
export const DEMO_MAPPING: ColumnMapping = Object.freeze({
  reference: 0,
  transactionDate: 1,
  postingDate: 2,
  description: 3,
  amount: 4,
  currency: 5,
  type: 6,
});

export const DEMO_CONVENTIONS: ImportConventions = Object.freeze({
  dateFormat: 'YYYY-MM-DD',
  amountSign: 'type_column',
  defaultCurrency: 'HKD',
});

export const DEMO_BATCHES: readonly DemoBatch[] = Object.freeze([
  {
    n: 1,
    title: 'Batch 1: First encounter',
    fixtureIds: ['R-101', 'R-102', 'R-103', 'R-104', 'R-105'],
    csvPath: 'demo/statements/batch-1.csv',
    csvFileName: 'batch-1.csv',
    tourStepAfterLoad: 1,
  },
  {
    n: 2,
    title: 'Batch 2: Knowledge reused',
    fixtureIds: ['R-201', 'R-202', 'R-203', 'R-204'],
    csvPath: 'demo/statements/batch-2.csv',
    csvFileName: 'batch-2.csv',
    tourStepAfterLoad: 3,
  },
  {
    n: 3,
    title: 'Batch 3: The boundary still holds',
    fixtureIds: ['R-301', 'R-302', 'R-303'],
    csvPath: 'demo/statements/batch-3.csv',
    csvFileName: 'batch-3.csv',
    tourStepAfterLoad: 4,
  },
]);

export function demoBatch(n: number): DemoBatch | undefined {
  return DEMO_BATCHES.find((b) => b.n === n);
}

/** The batch a fixture belongs to (null for anything else). */
export function batchOfFixture(fixtureId: string | undefined): BatchNumber | null {
  if (!fixtureId) return null;
  return DEMO_BATCHES.find((b) => b.fixtureIds.includes(fixtureId))?.n ?? null;
}

/** The lowest listed batch that is not loaded yet, or null when every listed batch is loaded. */
export function nextUnloadedBatch(loaded: readonly number[]): DemoBatch | null {
  return DEMO_BATCHES.find((b) => !loaded.includes(b.n)) ?? null;
}
