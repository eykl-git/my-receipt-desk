/**
 * Extraction adapter contract (design §3). An adapter only proposes field
 * values; they are stored as `original` values with provenance and are never
 * treated as validated until the user confirms them (A3 covers clear demo
 * fixtures only). Adapters receive no repository, activation or ledger handle
 * (enforced by lint boundaries).
 */
import type { IsoDate } from '../dates';
import type { AdapterKind, FieldClarity } from '../schemas';

export interface ExtractedField<T> {
  value: T | null;
  raw: string | null;
  clarity: FieldClarity;
  provenance: { adapterId: string; kind: AdapterKind };
}

export interface ExtractionResult {
  merchant: ExtractedField<string>;
  date: ExtractedField<IsoDate>;
  amountMinor: ExtractedField<number>;
  currency: ExtractedField<string>;
  /** Untrusted text printed on the receipt (display only). */
  printedText: string | null;
  warnings: string[];
}

export interface ExtractionInput {
  file: Blob;
  sourceDocumentId: string;
  fixtureId?: string;
}

export interface ExtractionAdapter {
  id: string;
  kind: AdapterKind;
  /** Label shown wherever this adapter's fields are displayed. */
  disclosureLabel: string;
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}

export const EXTRACTION_FAILED_MESSAGE = 'Automatic extraction failed. Enter the fields manually.';
