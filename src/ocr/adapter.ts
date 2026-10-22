/**
 * OCR extraction adapter (design §3, ocr-design.md §2.3). It only proposes
 * field values: they are stored as `original` values with provenance 'ocr' and
 * stay unconfirmed until the user saves them (A3). It receives an engine and
 * nothing else: no repository, activation or ledger handle.
 */
import type { ExtractionAdapter, ExtractionInput, ExtractionResult } from '../domain/capture/adapter';
import { parseReceiptText, receiptText, type OcrLine } from '../domain/capture/ocrParse';
import type { ReceiptLocale } from '../domain/capture/ocrLocale';
import { LIMITS } from '../domain/limits';
import type { OcrEngine } from './engine';

export const OCR_ADAPTER_ID = 'ocr-tesseract';
export const OCR_DISCLOSURE_LABEL = 'Read automatically, check before saving';

export interface OcrExtractionDetails {
  readonly result: ExtractionResult;
  readonly locale: ReceiptLocale;
  readonly lines: readonly OcrLine[];
}

export interface OcrExtractionAdapter extends ExtractionAdapter {
  extractWithDetails(input: ExtractionInput): Promise<OcrExtractionDetails>;
}

/** Failures reject with an OcrError subclass (not caught here). The caller terminates the engine. */
export function createOcrAdapter(engine: OcrEngine): OcrExtractionAdapter {
  const extractWithDetails = async (input: ExtractionInput): Promise<OcrExtractionDetails> => {
    const page = await engine.recognize(input.file);
    const parsed = parseReceiptText(page.lines, { adapterId: OCR_ADAPTER_ID });
    const text = receiptText(page.lines).slice(0, LIMITS.printedTextMaxChars);
    const { merchant, date, amountMinor, currency } = parsed.fields;
    const result: ExtractionResult = {
      merchant,
      date,
      amountMinor,
      currency,
      printedText: text === '' ? null : text,
      warnings: [...parsed.notes],
    };
    return { result, locale: parsed.locale, lines: page.lines };
  };
  return Object.freeze({
    id: OCR_ADAPTER_ID,
    kind: 'ocr' as const,
    disclosureLabel: OCR_DISCLOSURE_LABEL,
    extractWithDetails,
    async extract(input: ExtractionInput): Promise<ExtractionResult> {
      return (await extractWithDetails(input)).result;
    },
  });
}
