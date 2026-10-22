/**
 * Card CSV column mapping and conventions (S15, design §12.1 steps 3–4).
 * Selects are pre-filled only for exact (case-insensitive) synonym matches,
 * and neither the date format nor the debit/credit convention is ever guessed.
 */
import { allStrictIso, type DateFormat } from '../dates';

export const MAPPING_FIELDS = [
  'postingDate',
  'description',
  'amount',
  'debitAmount',
  'creditAmount',
  'transactionDate',
  'currency',
  'reference',
  'type',
] as const;
export type MappingField = (typeof MAPPING_FIELDS)[number];

/** Field → zero-based column index. */
export type ColumnMapping = Partial<Record<MappingField, number>>;

export type AmountSign = 'positive_charges' | 'negative_charges' | 'type_column' | 'separate_columns';
export const AMOUNT_SIGNS: readonly AmountSign[] = Object.freeze(['positive_charges', 'negative_charges', 'type_column', 'separate_columns']);

export interface ImportConventions {
  dateFormat: DateFormat | null;
  amountSign: AmountSign | null;
  /** Used when no Currency column is mapped. */
  defaultCurrency: string;
}

export const MAPPING_SYNONYMS: Readonly<Record<MappingField, readonly string[]>> = Object.freeze({
  postingDate: ['posting date', 'posted', 'post date'],
  transactionDate: ['transaction date', 'date'],
  description: ['description', 'details', 'merchant'],
  amount: ['amount'],
  debitAmount: [],
  creditAmount: [],
  currency: ['currency'],
  reference: ['reference', 'ref'],
  type: ['type', 'dr/cr'],
});

/** Pre-fill from exact synonyms; each column is used at most once. */
export function prefillMapping(header: readonly string[]): ColumnMapping {
  const used = new Set<number>();
  const out: ColumnMapping = {};
  for (const field of MAPPING_FIELDS) {
    const synonyms = MAPPING_SYNONYMS[field];
    const idx = header.findIndex((h, i) => !used.has(i) && synonyms.includes(h.trim().toLowerCase()));
    if (idx >= 0) {
      out[field] = idx;
      used.add(idx);
    }
  }
  return out;
}

/** Problems that keep a mapping from being usable (shown next to the selects). */
export function mappingProblems(mapping: ColumnMapping): string[] {
  const problems: string[] = [];
  if (mapping.postingDate === undefined) problems.push('Choose the Posting date column.');
  if (mapping.description === undefined) problems.push('Choose the Description column.');
  const separate = mapping.debitAmount !== undefined || mapping.creditAmount !== undefined;
  if (mapping.amount === undefined && !separate) problems.push('Choose the Amount column, or Debit amount and Credit amount.');
  if (mapping.amount !== undefined && separate) problems.push('Use either Amount or Debit amount and Credit amount, not both.');
  if (separate && (mapping.debitAmount === undefined || mapping.creditAmount === undefined)) {
    problems.push('Choose both Debit amount and Credit amount.');
  }
  const cols = Object.values(mapping).filter((v): v is number => v !== undefined);
  if (new Set(cols).size !== cols.length) problems.push('A column can be mapped once.');
  return problems;
}

/** The sign convention implied by the mapping, if any. */
export function impliedAmountSign(mapping: ColumnMapping): AmountSign | null {
  if (mapping.debitAmount !== undefined && mapping.creditAmount !== undefined) return 'separate_columns';
  if (mapping.type !== undefined) return 'type_column';
  return null;
}

/** Date format pre-selected only when every date cell is strict ISO. */
export function presetDateFormat(rows: ReadonlyArray<readonly string[]>, mapping: ColumnMapping): DateFormat | null {
  const cells: string[] = [];
  for (const r of rows) {
    if (mapping.postingDate !== undefined) cells.push(r[mapping.postingDate] ?? '');
    if (mapping.transactionDate !== undefined) cells.push(r[mapping.transactionDate] ?? '');
  }
  return allStrictIso(cells) ? 'YYYY-MM-DD' : null;
}
