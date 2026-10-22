/**
 * My files receipt capture (design §10.1, §10.2). File checks and hashing run
 * before the unit of work; an identical file (same SHA-256 in this workspace)
 * creates nothing and is audited as a rejected duplicate upload.
 */
import { applyFieldConfirmation, validateFieldInput, type FieldErrors, type FieldInput } from '../../domain/capture/edit';
import { MANUAL_ADAPTER_ID, manualExtraction } from '../../domain/capture/manualAdapter';
import { ValidationError } from '../../domain/errors';
import { LIMITS } from '../../domain/limits';
import type { ExtractionResult } from '../../domain/capture/adapter';
import { FIELD_NAMES, type Receipt } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand } from './context';
import { buildReceipt } from './receipts';
import { newSourceDocument } from './statements';

export interface ReceiptUpload {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface AddReceiptsResult {
  added: string[];
  duplicates: Array<{ fileName: string; matchedReceiptId: string }>;
}

export function addReceipts(repo: Repository, uploads: readonly ReceiptUpload[]): Promise<AddReceiptsResult> {
  return runCommand(repo, (c) => {
    const known = new Map<string, string>();
    for (const d of c.state.sourceDocuments) known.set(d.sha256, c.state.receipts.find((r) => r.sourceDocumentId === d.id)?.id ?? d.id);
    const newCount = uploads.filter((u, i) => !known.has(u.sha256) && uploads.findIndex((x) => x.sha256 === u.sha256) === i).length;
    if (c.state.receipts.length + newCount > LIMITS.workspaceMaxReceipts) {
      throw new ValidationError('LIMIT', `A workspace can hold at most ${LIMITS.workspaceMaxReceipts} receipts.`);
    }
    const result: AddReceiptsResult = { added: [], duplicates: [] };
    for (const u of uploads) {
      const matched = known.get(u.sha256);
      if (matched) {
        result.duplicates.push({ fileName: u.fileName, matchedReceiptId: matched });
        c.audit({
          action: 'capture.duplicate_upload_rejected',
          affected: [{ kind: 'receipt', id: matched }],
          after: { matchedReceiptId: matched, fileName: u.fileName },
        });
        continue;
      }
      const doc = newSourceDocument(c, u, 'receipt_upload');
      const id = `R-${String(c.next('receipt')).padStart(4, '0')}`;
      c.put('receipts', buildReceipt(c, id, doc, manualExtraction(), { id: MANUAL_ADAPTER_ID, kind: 'manual' }));
      known.set(u.sha256, id);
      result.added.push(id);
      c.audit({
        action: 'capture.receipt_added',
        affected: [{ kind: 'receipt', id }, { kind: 'source_document', id: doc.id }],
        evidenceRefs: [{ kind: 'source_document', ref: doc.id }],
        after: { fileName: u.fileName, adapter: MANUAL_ADAPTER_ID },
      });
    }
    if (result.added.length === 0 && result.duplicates.length === 0) c.markNoop();
    return result;
  });
}

export const EXTRACTION_MESSAGES = Object.freeze({
  notAllowed: 'Automatic reading is only available for an uploaded receipt whose fields have not been saved yet.',
});

/** Whether "Read automatically" may store results on this receipt (manual entry, nothing saved yet). */
export function canApplyExtraction(r: Receipt): boolean {
  return (
    r.adapter.kind === 'manual' &&
    r.disposition === 'active' &&
    FIELD_NAMES.every((n) => r.fields[n].confirmedAt === null && r.fields[n].correction === null && r.fields[n].original.clarity === 'missing')
  );
}

/**
 * "Read automatically" (brief §26 B, task 4.8a): stores an adapter's proposed
 * values as the receipt's `original` fields with their provenance (`ocr`).
 * Only allowed while the receipt still has the empty manual-entry originals,
 * so an extracted original is never overwritten. Every field stays
 * unconfirmed until "Save fields" (A3); nothing matches before that. The
 * extraction itself ran before this unit of work.
 */
export function applyExtraction(repo: Repository, receiptId: string, adapter: { id: string; kind: 'ocr' }, extraction: ExtractionResult): Promise<void> {
  return runCommand(repo, (c) => {
    const receipt = c.state.receipts.find((r) => r.id === receiptId);
    if (!receipt) throw new ValidationError('NOT_FOUND', 'This receipt no longer exists.');
    if (!canApplyExtraction(receipt)) throw new ValidationError('EXTRACTION_NOT_ALLOWED', EXTRACTION_MESSAGES.notAllowed);
    const doc = c.state.sourceDocuments.find((d) => d.id === receipt.sourceDocumentId)!;
    const next = buildReceipt(c, receipt.id, doc, extraction, { id: adapter.id, kind: adapter.kind });
    c.put('receipts', { ...next, createdAt: receipt.createdAt });
    c.audit({
      action: 'capture.fields_extracted',
      affected: [{ kind: 'receipt', id: receiptId }],
      evidenceRefs: [{ kind: 'source_document', ref: receipt.sourceDocumentId }],
      after: { adapter: adapter.id, clarity: Object.fromEntries(FIELD_NAMES.map((n) => [n, next.fields[n].original.clarity])) },
    });
  });
}

export class FieldValidationError extends ValidationError {
  readonly fieldErrors: FieldErrors;
  constructor(fieldErrors: FieldErrors) {
    super('FIELDS_INVALID', 'Check the highlighted fields. Nothing was saved.');
    this.fieldErrors = fieldErrors;
  }
}

/** "Save fields": confirms all four fields; corrections only where values differ from the original. */
export function saveFields(repo: Repository, receiptId: string, input: FieldInput): Promise<{ changed: string[] }> {
  const v = validateFieldInput(input);
  if (!v.ok) return Promise.reject(new FieldValidationError(v.errors));
  return runCommand(repo, (c) => {
    const receipt = c.state.receipts.find((r) => r.id === receiptId);
    if (!receipt) throw new ValidationError('NOT_FOUND', 'This receipt no longer exists.');
    const linked =
      c.state.matches.some((m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === receiptId) ||
      c.state.ledger.some((e) => e.status === 'recorded' && e.evidence.receiptIds.includes(receiptId));
    if (linked) throw new ValidationError('RECORDED', 'This one is recorded. Void its entry first.');
    const confirmation = applyFieldConfirmation(receipt, v.values, c.at);
    c.put('receipts', confirmation.receipt);
    c.audit({
      action: 'capture.fields_confirmed',
      affected: [{ kind: 'receipt', id: receiptId }],
      evidenceRefs: [{ kind: 'source_document', ref: receipt.sourceDocumentId }],
      before: confirmation.changed.length > 0 ? confirmation.before : null,
      after: { confirmed: ['merchant', 'date', 'amountMinor', 'currency'], ...(confirmation.changed.length > 0 ? { values: confirmation.after } : {}) },
    });
    return { changed: confirmation.changed };
  });
}
