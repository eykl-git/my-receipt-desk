/**
 * Guided-demo commands (design §8.1, §9.1, review-3 amendments M3 and N3).
 *
 * `loadDemoBatch` hashes files, runs the demo adapter and parses the CSV
 * before its unit of work, then writes the whole batch (documents, files,
 * receipts, card rows, audit, `loadedBatches` and `tourStep`) together.
 * `advanceTourStep` writes only the tour step: no clock tick, no audit.
 */
import { parseStatementCsv, readCsvGrid, decodeCsvBytes, type ParsedStatement } from '../../domain/imports/parse';
import { DemoAssetsError, ValidationError } from '../../domain/errors';
import { accountId } from '../../domain/normalize';
import type { ExtractionResult } from '../../domain/capture/adapter';
import { DEMO_ACCOUNT_LABEL, DEMO_CONVENTIONS, DEMO_MAPPING, demoBatch, type BatchNumber } from '../../demo/batches';
import type { DemoAssets } from '../../demo/assets';
import { DEMO_ADAPTER_ID, extractFixture } from '../../demo/demoAdapter';
import { receiptFixture } from '../../demo/fixtures';
import { sha256Hex } from '../hash';
import type { Repository } from '../repository';
import { runCommand } from './context';
import { buildReceipt } from './receipts';
import { newSourceDocument, PENDING_DOCUMENT_ID, writeStatement } from './statements';

export const DEMO_LOAD_FAILED = 'The demo data couldn’t be loaded. Restart the demo.';

export interface LoadBatchResult {
  alreadyLoaded: boolean;
  addedReceiptIds: string[];
  duplicateUploads: Array<{ fixtureId: string; matchedReceiptId: string }>;
}

export function duplicateUploadNotice(matchedReceiptId: string): string {
  return `Already added as ${matchedReceiptId} (identical file). Nothing was added.`;
}

interface PreparedReceipt {
  fixtureId: string;
  fileName: string;
  bytes: Uint8Array;
  sha256: string;
  extraction: ExtractionResult;
}

export async function loadDemoBatch(repo: Repository, n: BatchNumber, assets: DemoAssets): Promise<LoadBatchResult> {
  const batch = demoBatch(n);
  if (!batch) throw new ValidationError('UNKNOWN_BATCH', `Batch ${n} is not available.`);
  const before = await repo.loadSnapshot();
  if (before.demoState.loadedBatches.includes(n)) return { alreadyLoaded: true, addedReceiptIds: [], duplicateUploads: [] };
  if (n > 1 && !before.demoState.loadedBatches.includes((n - 1) as BatchNumber)) {
    throw new ValidationError('BATCH_ORDER', `Load Batch ${n - 1} first.`);
  }

  // (1) Outside the unit of work: bytes, hashes, extraction.
  const csvBytes = assets.csvs.get(n);
  if (!csvBytes) throw new DemoAssetsError();
  const prepared: PreparedReceipt[] = [];
  for (const fixtureId of batch.fixtureIds) {
    const bytes = assets.svgs.get(fixtureId);
    if (!bytes) throw new DemoAssetsError();
    prepared.push({ fixtureId, fileName: receiptFixture(fixtureId).file, bytes, sha256: await sha256Hex(bytes), extraction: extractFixture(fixtureId) });
  }
  const csvSha = await sha256Hex(csvBytes);

  // (2) Parse with the fixed demo mapping (pure). A failure is a build defect.
  const decoded = decodeCsvBytes(csvBytes);
  const account = { accountId: accountId(DEMO_ACCOUNT_LABEL), accountLabel: DEMO_ACCOUNT_LABEL };
  let parsed: ParsedStatement | null = null;
  if (decoded.ok) {
    parsed = parseStatementCsv(readCsvGrid(decoded.text), DEMO_MAPPING, DEMO_CONVENTIONS, account, {
      sha256: csvSha,
      sourceDocumentId: PENDING_DOCUMENT_ID,
      workspaceId: repo.workspaceId,
    });
  }
  if (!parsed || parsed.fileErrors.length > 0 || parsed.errors.length > 0) {
    console.error('Demo statement failed to parse', parsed?.fileErrors, parsed?.errors);
    throw new Error(DEMO_LOAD_FAILED);
  }
  const statement = parsed;

  // (3) One unit of work for the whole batch.
  return runCommand(repo, (c) => {
    if (c.state.demoState.loadedBatches.includes(n)) {
      c.markNoop();
      return { alreadyLoaded: true, addedReceiptIds: [], duplicateUploads: [] };
    }
    const shaToReceipt = new Map<string, { docId: string; receiptId: string | null }>();
    for (const d of c.state.sourceDocuments) {
      shaToReceipt.set(d.sha256, { docId: d.id, receiptId: c.state.receipts.find((r) => r.sourceDocumentId === d.id)?.id ?? null });
    }
    const added: string[] = [];
    const duplicates: LoadBatchResult['duplicateUploads'] = [];
    for (const p of prepared) {
      const existing = shaToReceipt.get(p.sha256);
      if (existing) {
        const matched = existing.receiptId ?? existing.docId;
        duplicates.push({ fixtureId: p.fixtureId, matchedReceiptId: matched });
        c.audit({
          action: 'capture.duplicate_upload_rejected',
          affected: [{ kind: 'source_document', id: existing.docId }, ...(existing.receiptId ? [{ kind: 'receipt', id: existing.receiptId }] : [])],
          evidenceRefs: [{ kind: 'source_document', ref: existing.docId }],
          after: { matchedReceiptId: matched, fileName: p.fileName, fixtureId: p.fixtureId, batch: n },
        });
        continue;
      }
      const doc = newSourceDocument(c, { fileName: p.fileName, mimeType: 'image/svg+xml', bytes: p.bytes, sha256: p.sha256 }, 'demo_receipt_image');
      const receipt = buildReceipt(c, p.fixtureId, doc, p.extraction, { id: DEMO_ADAPTER_ID, kind: 'demo-fixture' }, p.fixtureId);
      c.put('receipts', receipt);
      shaToReceipt.set(p.sha256, { docId: doc.id, receiptId: receipt.id });
      added.push(receipt.id);
      c.audit({
        action: 'capture.receipt_added',
        affected: [{ kind: 'receipt', id: receipt.id }, { kind: 'source_document', id: doc.id }],
        evidenceRefs: [{ kind: 'source_document', ref: doc.id }],
        after: { fixtureId: p.fixtureId, adapter: DEMO_ADAPTER_ID },
      });
    }
    const { document } = writeStatement(c, { fileName: batch.csvFileName, mimeType: 'text/csv', bytes: csvBytes, sha256: csvSha }, statement, 'demo_statement_csv');
    c.setDemoState({ loadedBatches: [...c.state.demoState.loadedBatches, n].sort(), tourStep: batch.tourStepAfterLoad });
    c.audit({
      action: 'demo.batch_loaded',
      actor: 'system',
      affected: [{ kind: 'batch', id: String(n) }, ...added.map((id) => ({ kind: 'receipt', id }))],
      evidenceRefs: [{ kind: 'source_document', ref: document.id }],
      after: { batch: n, receipts: added, duplicateUploads: duplicates.map((d) => d.fixtureId) },
    });
    return { alreadyLoaded: false, addedReceiptIds: added, duplicateUploads: duplicates };
  });
}

/** Step 1 → 2 only (M3): writes `tourStep` and nothing else. */
export function advanceTourStep(repo: Repository, step: 2): Promise<boolean> {
  return repo.unitOfWork(['meta'], (state, w) => {
    if (state.workspaceId !== 'demo' || state.demoState.tourStep !== 1 || step !== 2) return false;
    w.put('meta', { key: 'demoState', value: { ...state.demoState, tourStep: 2 } });
    return true;
  });
}
