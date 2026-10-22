/**
 * Excel-compatible CSV exports (design §12.2, §12.3, review-3 N4, T18).
 * UTF-8 with BOM, CRLF, every field quoted. Every text cell passes
 * `escapeCell` (formula-injection protection); the typed columns (amounts,
 * dates, timestamps) are generated from validated values and asserted to match
 * their pattern or be empty, so Excel reads them as numbers and dates.
 * Exports are labelled CSV, never XLSX.
 */
import Papa from 'papaparse';
import { effectiveFields } from '../capture/fields';
import { categoryName } from '../categories';
import type { WorkspaceState } from '../knowledge/preview';
import { displayRef } from '../matching/helpers';
import { formatMinor } from '../money';
import { formatRuleRef } from '../primitives';
import type { WorkspaceView } from '../views';

/** A leading `= + - @`, tab or CR (also after leading spaces) makes a spreadsheet treat text as a formula. */
const FORMULA_START = /^[\s]*[=+\-@\t\r]/;

/** Formula-injection protection for one text cell (§12.3). */
export function escapeCell(text: string): string {
  const prefixed = FORMULA_START.test(text) ? `'${text}` : text;
  return prefixed.replace(/\r\n|\r|\n/g, ' ');
}

const TYPED = {
  amount: /^-?\d+\.\d{2}$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  datetime: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
} as const;

/** A typed cell must be its pattern or empty (§12.3); anything else stops the export. */
function typed(kind: keyof typeof TYPED, value: string | null): string {
  const v = value ?? '';
  if (v !== '' && !TYPED[kind].test(v)) throw new Error(`Export stopped: “${v}” is not a valid ${kind}.`);
  return v;
}

export const LEDGER_COLUMNS = [
  'ledger_id',
  'expense_date',
  'merchant',
  'amount',
  'currency',
  'category',
  'category_status',
  'ledger_status',
  'reconciliation_status',
  'match_method',
  'receipt_ids',
  'transaction_ids',
  'source_document_ids',
  'rule_refs',
  'evidence_status',
  'recorded_at',
] as const;

export const EXCEPTION_COLUMNS = ['case_id', 'case_type', 'date', 'merchant_or_label', 'direction', 'amount', 'currency', 'reasons', 'flags', 'candidate_ids'] as const;

function toCsv(columns: readonly string[], rows: string[][]): string {
  return `\uFEFF${Papa.unparse({ fields: [...columns], data: rows }, { quotes: true, newline: '\r\n' })}\r\n`;
}

/** "Export ledger CSV": every ledger entry, voided ones included (full history). */
export function ledgerCsv(state: WorkspaceState, missingEvidence: ReadonlySet<string> = new Set()): string {
  const rows = [...state.ledger]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((e) => {
      const active = state.matches.filter((m) => m.status === 'active' && e.evidence.matchIds.includes(m.id));
      const any = state.matches.filter((m) => e.evidence.matchIds.includes(m.id));
      const reconciliation = e.status === 'voided' ? 'released' : active.length > 0 ? 'confirmed' : 'not_applicable';
      const method = [...new Set(any.map((m) => m.method))].join('|');
      return [
        escapeCell(e.id),
        typed('date', e.expenseDate),
        escapeCell(e.merchantName),
        typed('amount', formatMinor(e.amountMinor)),
        escapeCell(e.currency),
        escapeCell(e.category.categoryId ? categoryName(e.category.categoryId) : ''),
        escapeCell(e.category.status),
        escapeCell(e.status),
        escapeCell(reconciliation),
        escapeCell(method),
        escapeCell(e.evidence.receiptIds.join('|')),
        escapeCell(e.evidence.transactionIds.join('|')),
        escapeCell(e.evidence.sourceDocumentIds.join('|')),
        escapeCell(e.ruleRefs.map(formatRuleRef).join('|')),
        escapeCell(missingEvidence.has(e.id) ? 'missing' : 'ok'),
        typed('datetime', e.recordedAt),
      ];
    });
  return toCsv(LEDGER_COLUMNS, rows);
}

/** "Export exceptions CSV" (N4): pending receipts that need a decision and card rows needing attention. */
export function exceptionsCsv(state: WorkspaceState, view: WorkspaceView): string {
  const txById = new Map(state.transactions.map((t) => [t.id, t]));
  const ref = (id: string) => {
    const t = txById.get(id);
    return t ? displayRef(t) : id;
  };
  const rows: string[][] = [];
  for (const c of view.groups.needs_decision) {
    const r = state.receipts.find((x) => x.id === c.receiptId)!;
    const f = effectiveFields(r);
    const candidates = c.proposal ? [...c.proposal.candidateIds, ...c.proposal.heldIds, ...c.proposal.nearCandidateIds] : [];
    rows.push([
      escapeCell(r.id),
      'receipt',
      typed('date', f.date),
      escapeCell(f.merchant ?? ''),
      '',
      typed('amount', f.amountMinor === null ? null : formatMinor(f.amountMinor)),
      escapeCell(f.currency ?? ''),
      escapeCell(c.explanation),
      escapeCell(c.flags.join('|')),
      escapeCell([...new Set(candidates)].map(ref).join('|')),
    ]);
  }
  for (const tc of view.transactionCases) {
    const t = txById.get(tc.transactionId);
    if (!t) continue;
    rows.push([
      escapeCell(t.reference ?? t.id),
      'card_transaction',
      typed('date', t.postingDate),
      escapeCell(t.rawLabel),
      t.direction,
      typed('amount', formatMinor(t.amountMinor)),
      escapeCell(t.currency),
      escapeCell(tc.explanation),
      escapeCell(tc.flags.join('|')),
      '',
    ]);
  }
  return toCsv(EXCEPTION_COLUMNS, rows);
}

/** `my-receipt-desk-<kind>-<workspace>-<YYYYMMDD>.<ext>` */
export function exportFileName(kind: string, workspace: string, isoNow: string, ext = 'csv'): string {
  return `my-receipt-desk-${kind}-${workspace}-${isoNow.slice(0, 10).replace(/-/g, '')}.${ext}`;
}
