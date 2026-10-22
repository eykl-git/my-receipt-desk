/**
 * ManualAdapter (design §3): the baseline for "My files". It extracts nothing;
 * every field starts missing and the user enters or corrects it.
 */
import type { ExtractedField, ExtractionAdapter, ExtractionResult } from './adapter';

export const MANUAL_ADAPTER_ID = 'manual';
export const MANUAL_ENTRY_LABEL = 'Manual entry—automatic extraction is not enabled';

const missing = <T>(): ExtractedField<T> => ({
  value: null,
  raw: null,
  clarity: 'missing',
  provenance: { adapterId: MANUAL_ADAPTER_ID, kind: 'manual' },
});

export function manualExtraction(): ExtractionResult {
  return { merchant: missing(), date: missing(), amountMinor: missing(), currency: missing(), printedText: null, warnings: [] };
}

export const ManualAdapter: ExtractionAdapter = Object.freeze({
  id: MANUAL_ADAPTER_ID,
  kind: 'manual' as const,
  disclosureLabel: MANUAL_ENTRY_LABEL,
  extract(): Promise<ExtractionResult> {
    return Promise.resolve(manualExtraction());
  },
});
