/**
 * DemoFixtureAdapter (design §3): returns the preloaded structured fixture for
 * a bundled fictional receipt. No OCR or model runs; the UI says so with the
 * disclosure label wherever these fields are shown.
 */
import type { ExtractedField, ExtractionAdapter, ExtractionInput, ExtractionResult } from '../domain/capture/adapter';
import { receiptFixture, type FixtureField } from './fixtures';

export const DEMO_ADAPTER_ID = 'demo-fixture';
export const DEMO_EXTRACTION_LABEL = 'Demo extraction—preloaded fictional example';

const provenance = { adapterId: DEMO_ADAPTER_ID, kind: 'demo-fixture' as const };

function field<T>(f: FixtureField<T>): ExtractedField<T> {
  return { value: f.value, raw: f.raw, clarity: f.clarity, provenance: { ...provenance } };
}

/** Synchronous lookup used by the demo loader and the adapter. */
export function extractFixture(fixtureId: string): ExtractionResult {
  const f = receiptFixture(fixtureId);
  return {
    merchant: field(f.merchant),
    date: field(f.date),
    amountMinor: field(f.amountMinor),
    currency: field(f.currency),
    printedText: f.printedText,
    warnings: [],
  };
}

export const DemoFixtureAdapter: ExtractionAdapter = Object.freeze({
  id: DEMO_ADAPTER_ID,
  kind: 'demo-fixture' as const,
  disclosureLabel: DEMO_EXTRACTION_LABEL,
  extract(input: ExtractionInput): Promise<ExtractionResult> {
    if (!input.fixtureId) return Promise.reject(new Error('The demo adapter needs a fixture ID.'));
    return Promise.resolve(extractFixture(input.fixtureId));
  },
});
