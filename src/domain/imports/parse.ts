/**
 * Card CSV parsing and full validation before any write (S15, design §12.1).
 * Pure: the caller passes decoded text, the chosen mapping and conventions,
 * the card account and the file identity. Every row is validated; nothing is
 * accepted partially here (the commit decides, with the user's explicit
 * "valid rows only" choice). Cells are untrusted data and only ever stored and
 * displayed as text.
 */
import Papa from 'papaparse';
import { isDateInSupportedRange, parseDateWithFormat, type IsoDate } from '../dates';
import { sourceRowId, transactionId } from '../ids';
import { LIMITS } from '../limits';
import { formatMinor, parseAmount } from '../money';
import { normalizeLabel } from '../normalize';
import type { WorkspaceId } from '../primitives';
import { StatementTransactionSchema, type StatementTransaction } from '../schemas';
import { impliedAmountSign, mappingProblems, presetDateFormat, type ColumnMapping, type ImportConventions, type MappingField } from './mapping';

export type RowErrorCode =
  | 'REQUIRED_MISSING'
  | 'DATE_INVALID'
  | 'AMOUNT_INVALID'
  | 'AMOUNT_ZERO'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'DIRECTION_UNKNOWN'
  | 'CURRENCY_INVALID'
  | 'FIELD_TOO_LONG'
  | 'POSTING_BEFORE_TRANSACTION';

export interface RowError {
  /** 1-based line in the file. */
  row: number;
  column: string;
  /** First 80 characters of the original cell (shown as text). */
  value: string;
  code: RowErrorCode;
  message: string;
}

export interface CsvRow {
  /** 1-based line in the file where the row starts. */
  line: number;
  cells: string[];
}

export interface CsvGrid {
  header: string[];
  rows: CsvRow[];
  /** File-level problems (unreadable CSV, too many rows or columns). */
  problems: string[];
}

export interface StatementAccount {
  accountId: string;
  accountLabel: string;
}

export interface StatementSource {
  sha256: string;
  sourceDocumentId: string;
  workspaceId: WorkspaceId;
  /** Workspace currency (REQ-20); rows in any other currency are quarantined. HKD when omitted. */
  workspaceCurrency?: string;
}

export interface ImportPreview {
  /** The workspace currency the debit rows and total below are in. */
  currency: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  quarantinedRows: number[];
  creditRows: number[];
  /** Available debit rows in the workspace currency (HKD unless My files uses MYR). */
  hkdDebitRows: number;
  hkdDebitTotalMinor: number;
  /** Amounts in other currencies listed separately by currency (never converted). */
  otherCurrencyTotals: Array<{ currency: string; totalMinor: number }>;
}

export interface ParsedStatement {
  /** Valid rows only, as statement transactions. */
  rows: StatementTransaction[];
  errors: RowError[];
  /** Line numbers of rows with at least one error. */
  errorLines: number[];
  /** Problems that block the whole import (mapping, conventions, file limits). */
  fileErrors: string[];
  preview: ImportPreview;
}

export const IMPORT_MESSAGES = Object.freeze({
  notUtf8: 'This file isn’t UTF-8 text',
  notCsv: 'Choose a .csv file.',
  tooLarge: `The file is larger than ${LIMITS.csvMaxBytes / (1024 * 1024)} MB.`,
  noHeader: 'The file has no header row.',
  tooManyRows: `The file has more than ${LIMITS.csvMaxDataRows} data rows.`,
  tooManyColumns: `The file has more than ${LIMITS.csvMaxColumns} columns.`,
  chooseDateFormat: 'Choose the date format. Dates like 03/04/2026 can be read two ways, so the app never guesses.',
  chooseAmountSign: 'Choose how charges appear in the Amount column.',
});

/** Decode bytes as UTF-8 (fatal on invalid sequences) and strip a BOM. */
export function decodeCsvBytes(bytes: Uint8Array): { ok: true; text: string } | { ok: false; message: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { ok: true, text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text };
  } catch {
    return { ok: false, message: IMPORT_MESSAGES.notUtf8 };
  }
}

/** Parse CSV text into rows with their file line numbers. Blank lines are skipped. */
export function readCsvGrid(text: string): CsvGrid {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const result = Papa.parse<string[]>(clean, { header: false, skipEmptyLines: false });
  const problems: string[] = [];
  const firstError = result.errors.find((e) => e.code !== 'UndetectableDelimiter');
  if (firstError) problems.push(`This file couldn’t be read as CSV: ${firstError.message} (row ${(firstError.row ?? 0) + 1}).`);

  let line = 1;
  const nonEmpty: CsvRow[] = [];
  for (const cells of result.data) {
    const rowLine = line;
    line += 1 + cells.reduce((n, c) => n + (c.match(/\n/g)?.length ?? 0), 0);
    if (cells.every((c) => c.trim() === '')) continue;
    nonEmpty.push({ line: rowLine, cells });
  }
  const [headerRow, ...rows] = nonEmpty;
  if (!headerRow) return { header: [], rows: [], problems: [...problems, IMPORT_MESSAGES.noHeader] };
  if (headerRow.cells.length > LIMITS.csvMaxColumns || rows.some((r) => r.cells.length > LIMITS.csvMaxColumns)) {
    problems.push(IMPORT_MESSAGES.tooManyColumns);
  }
  if (rows.length > LIMITS.csvMaxDataRows) problems.push(IMPORT_MESSAGES.tooManyRows);
  return { header: headerRow.cells.map((h) => h.trim()), rows, problems };
}

const FIELD_LABELS: Record<MappingField, string> = {
  postingDate: 'Posting date',
  transactionDate: 'Transaction date',
  description: 'Description',
  amount: 'Amount',
  debitAmount: 'Debit amount',
  creditAmount: 'Credit amount',
  currency: 'Currency',
  reference: 'Reference',
  type: 'Type',
};

const DEBIT_TYPES = ['DEBIT', 'DR', 'D'];
const CREDIT_TYPES = ['CREDIT', 'CR', 'C'];

/** Conventions after applying what the mapping implies; null fields still need a choice. */
export function effectiveConventions(grid: CsvGrid, mapping: ColumnMapping, chosen: ImportConventions): ImportConventions {
  return {
    dateFormat: chosen.dateFormat ?? presetDateFormat(grid.rows.map((r) => r.cells), mapping),
    amountSign: impliedAmountSign(mapping) ?? chosen.amountSign,
    defaultCurrency: chosen.defaultCurrency,
  };
}

function emptyPreview(totalRows: number, currency: string): ImportPreview {
  return { currency, totalRows, validRows: 0, errorRows: 0, quarantinedRows: [], creditRows: [], hkdDebitRows: 0, hkdDebitTotalMinor: 0, otherCurrencyTotals: [] };
}

export function parseStatementCsv(
  grid: CsvGrid,
  mapping: ColumnMapping,
  chosen: ImportConventions,
  account: StatementAccount,
  source: StatementSource,
): ParsedStatement {
  const fileErrors = [...grid.problems, ...mappingProblems(mapping)];
  const conventions = effectiveConventions(grid, mapping, chosen);
  if (conventions.dateFormat === null) fileErrors.push(IMPORT_MESSAGES.chooseDateFormat);
  if (conventions.amountSign === null) fileErrors.push(IMPORT_MESSAGES.chooseAmountSign);
  const workspaceCurrency = source.workspaceCurrency ?? 'HKD';
  if (fileErrors.length > 0) {
    return { rows: [], errors: [], errorLines: [], fileErrors, preview: emptyPreview(grid.rows.length, workspaceCurrency) };
  }
  const dateFormat = conventions.dateFormat!;
  const amountSign = conventions.amountSign!;

  const errors: RowError[] = [];
  const rows: StatementTransaction[] = [];
  const errorLines: number[] = [];
  const colName = (field: MappingField) => {
    const idx = mapping[field];
    return idx === undefined ? FIELD_LABELS[field] : grid.header[idx] || FIELD_LABELS[field];
  };
  const cellOf = (cells: string[], field: MappingField) => {
    const idx = mapping[field];
    return idx === undefined ? '' : (cells[idx] ?? '');
  };

  for (const { line, cells } of grid.rows) {
    const rowErrors: RowError[] = [];
    const failAt = (column: string, value: string, code: RowErrorCode, message: string) =>
      rowErrors.push({ row: line, column, value: value.slice(0, 80), code, message });
    const fail = (field: MappingField, value: string, code: RowErrorCode, message: string) => failAt(colName(field), value, code, message);

    cells.forEach((c, i) => {
      if (c.length > LIMITS.csvCellMaxChars) {
        failAt(grid.header[i] || `Column ${i + 1}`, c, 'FIELD_TOO_LONG', `Cells can have at most ${LIMITS.csvCellMaxChars} characters.`);
      }
    });

    const description = cellOf(cells, 'description').trim();
    if (description === '') fail('description', description, 'REQUIRED_MISSING', 'Description is required.');
    else if (description.length > LIMITS.csvDescriptionMaxChars) {
      fail('description', description, 'FIELD_TOO_LONG', `Descriptions can have at most ${LIMITS.csvDescriptionMaxChars} characters.`);
    }

    const parseDate = (field: 'postingDate' | 'transactionDate', required: boolean): IsoDate | null => {
      const raw = cellOf(cells, field).trim();
      if (raw === '') {
        if (required) fail(field, raw, 'REQUIRED_MISSING', `${FIELD_LABELS[field]} is required.`);
        return null;
      }
      const d = parseDateWithFormat(raw, dateFormat);
      if (d === null || !isDateInSupportedRange(d)) {
        fail(field, raw, 'DATE_INVALID', `Not a real date in ${dateFormat} between ${LIMITS.dateMin} and ${LIMITS.dateMax}.`);
        return null;
      }
      return d;
    };
    const postingDate = parseDate('postingDate', true);
    const transactionDate = parseDate('transactionDate', false);
    if (postingDate && transactionDate && transactionDate > postingDate) {
      fail('postingDate', cellOf(cells, 'postingDate'), 'POSTING_BEFORE_TRANSACTION', 'The posting date is before the transaction date.');
    }

    // Amount and direction (never guessed: the convention is explicit).
    let amountMinor: number | null = null;
    let direction: 'debit' | 'credit' | null = null;
    const readAmount = (field: 'amount' | 'debitAmount' | 'creditAmount'): number | null => {
      const raw = cellOf(cells, field).trim();
      const v = parseAmount(raw);
      if (v === null) {
        fail(field, raw, 'AMOUNT_INVALID', 'Use a plain number such as 120.00 or -48.50.');
        return null;
      }
      if (v === 0) {
        fail(field, raw, 'AMOUNT_ZERO', 'The amount is zero.');
        return null;
      }
      if (Math.abs(v) > LIMITS.amountMaxMinor) {
        fail(field, raw, 'AMOUNT_OUT_OF_RANGE', `Amounts can be at most ${formatMinor(LIMITS.amountMaxMinor)}.`);
        return null;
      }
      return v;
    };
    if (amountSign === 'separate_columns') {
      const debitRaw = cellOf(cells, 'debitAmount').trim();
      const creditRaw = cellOf(cells, 'creditAmount').trim();
      if (debitRaw === '' && creditRaw === '') fail('debitAmount', '', 'REQUIRED_MISSING', 'Debit amount or Credit amount is required.');
      else if (debitRaw !== '' && creditRaw !== '') {
        fail('creditAmount', `${debitRaw} / ${creditRaw}`, 'DIRECTION_UNKNOWN', 'A row can have a debit or a credit amount, not both.');
      } else {
        const field = debitRaw !== '' ? 'debitAmount' : 'creditAmount';
        const v = readAmount(field);
        if (v !== null) {
          amountMinor = Math.abs(v);
          direction = field === 'debitAmount' ? 'debit' : 'credit';
        }
      }
    } else {
      const raw = cellOf(cells, 'amount').trim();
      if (raw === '') fail('amount', raw, 'REQUIRED_MISSING', 'Amount is required.');
      else {
        const v = readAmount('amount');
        if (v !== null) {
          amountMinor = Math.abs(v);
          if (amountSign === 'positive_charges') direction = v > 0 ? 'debit' : 'credit';
          else if (amountSign === 'negative_charges') direction = v < 0 ? 'debit' : 'credit';
          else {
            const t = cellOf(cells, 'type').trim().toUpperCase();
            if (DEBIT_TYPES.includes(t)) direction = 'debit';
            else if (CREDIT_TYPES.includes(t)) direction = 'credit';
            else fail('type', cellOf(cells, 'type'), 'DIRECTION_UNKNOWN', 'Type must be DEBIT, DR, D, CREDIT, CR or C.');
          }
        }
      }
    }

    let currency = conventions.defaultCurrency;
    if (mapping.currency !== undefined) {
      const raw = cellOf(cells, 'currency').trim();
      if (raw === '') fail('currency', raw, 'REQUIRED_MISSING', 'Currency is required.');
      currency = raw;
    }
    if (currency !== '' && !/^[A-Z]{3}$/.test(currency)) {
      fail('currency', currency, 'CURRENCY_INVALID', 'Use a three-letter currency code such as HKD.');
    }

    if (rowErrors.length > 0 || postingDate === null || amountMinor === null || direction === null) {
      errors.push(...rowErrors);
      errorLines.push(line);
      continue;
    }

    const reference = cellOf(cells, 'reference').trim();
    const intake = currency !== workspaceCurrency ? 'quarantined_currency' : direction === 'credit' ? 'credit_not_supported' : 'available';
    rows.push(
      StatementTransactionSchema.parse({
        schemaVersion: 1,
        workspaceId: source.workspaceId,
        id: transactionId(source.sha256, line),
        sourceDocumentId: source.sourceDocumentId,
        sourceRowId: sourceRowId(source.sha256, line),
        rowNumber: line,
        reference: reference === '' ? null : reference,
        accountId: account.accountId,
        accountLabel: account.accountLabel,
        rawLabel: description,
        normalizedLabel: normalizeLabel(description),
        transactionDate,
        postingDate,
        currency,
        direction,
        amountMinor,
        intake,
        duplicateSuspected: false,
        duplicateOf: null,
        duplicateResolution: null,
        rawCells: cells,
      }),
    );
  }

  const other = new Map<string, number>();
  for (const r of rows) if (r.intake === 'quarantined_currency' && r.direction === 'debit') other.set(r.currency, (other.get(r.currency) ?? 0) + r.amountMinor);
  const hkdDebits = rows.filter((r) => r.intake === 'available');
  return {
    rows,
    errors,
    errorLines,
    fileErrors: [],
    preview: {
      currency: workspaceCurrency,
      totalRows: grid.rows.length,
      validRows: rows.length,
      errorRows: errorLines.length,
      quarantinedRows: rows.filter((r) => r.intake === 'quarantined_currency').map((r) => r.rowNumber),
      creditRows: rows.filter((r) => r.intake === 'credit_not_supported').map((r) => r.rowNumber),
      hkdDebitRows: hkdDebits.length,
      hkdDebitTotalMinor: hkdDebits.reduce((n, r) => n + r.amountMinor, 0),
      otherCurrencyTotals: [...other.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, totalMinor]) => ({ currency, totalMinor })),
    },
  };
}
