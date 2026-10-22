/** Receipt record creation shared by `addReceipts` and `loadDemoBatch` (design §4, §10.1). */
import type { ExtractionResult } from '../../domain/capture/adapter';
import { canonicalMerchantId } from '../../domain/normalize';
import type { Receipt, SourceDocument } from '../../domain/schemas';
import type { CommandContext } from './context';

export function buildReceipt(
  c: CommandContext,
  id: string,
  doc: SourceDocument,
  extraction: ExtractionResult,
  adapter: { id: string; kind: Receipt['adapter']['kind'] },
  fixtureId?: string,
): Receipt {
  const field = <T>(f: ExtractionResult[keyof Pick<ExtractionResult, 'merchant' | 'date' | 'amountMinor' | 'currency'>] & { value: T | null }) => ({
    original: { value: f.value, raw: f.raw, clarity: f.clarity, provenance: { ...f.provenance } },
    correction: null,
    confirmedAt: null,
  });
  const merchant = extraction.merchant.value;
  return {
    schemaVersion: 1,
    workspaceId: c.workspaceId,
    id,
    sourceDocumentId: doc.id,
    ...(fixtureId ? { fixtureId } : {}),
    adapter,
    fields: {
      merchant: field(extraction.merchant),
      date: field(extraction.date),
      amountMinor: field(extraction.amountMinor),
      currency: field(extraction.currency),
    },
    printedText: extraction.printedText,
    canonicalMerchantId: merchant === null ? null : canonicalMerchantId(merchant),
    disposition: 'active',
    category: { categoryId: null, status: 'unassigned' },
    createdAt: c.at,
    updatedAt: c.at,
  } as Receipt;
}
