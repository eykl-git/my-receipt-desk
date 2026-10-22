/**
 * OCR language options (brief §27, ocr-design.md §2.3, §4). Only the chosen
 * option's languages are downloaded, on first use. One model variant per
 * language is shipped: `4.0.0_best_int` (LSTM only).
 */
export type OcrLanguageCode = 'eng' | 'msa' | 'chi_sim' | 'chi_tra';
export type OcrLanguageOptionId = 'eng+msa' | 'chi_sim+eng' | 'chi_tra+eng';

export interface OcrLanguageOption {
  readonly id: OcrLanguageOptionId;
  /** Shown verbatim in the "Receipt language" select. */
  readonly label: string;
  /** Load order = engine priority. */
  readonly languages: readonly OcrLanguageCode[];
  /** Traineddata bytes for this option (ocr-design.md §4). */
  readonly downloadBytes: number;
}

export interface OcrLanguageData {
  readonly variant: '4.0.0_best_int';
  readonly bytes: number;
  readonly sha256: string;
}

/** Size and SHA-256 of each shipped `<lang>.traineddata.gz`; scripts/ocr/copy-assets.mjs checks the same values. */
export const OCR_LANGUAGE_DATA: Readonly<Record<OcrLanguageCode, OcrLanguageData>> = Object.freeze({
  eng: Object.freeze({
    variant: '4.0.0_best_int',
    bytes: 2_952_873,
    sha256: '45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91',
  }),
  msa: Object.freeze({
    variant: '4.0.0_best_int',
    bytes: 1_177_136,
    sha256: '35ae490b99462d04cf4e2a7985d98f0ba5e10ca62adb13aeda070c6f1783f097',
  }),
  chi_sim: Object.freeze({
    variant: '4.0.0_best_int',
    bytes: 1_718_768,
    sha256: 'b8a23f10c7de500891eb458a8adc9cc58ab7f242f08b7d149f5e9aea4ad5db7c',
  }),
  chi_tra: Object.freeze({
    variant: '4.0.0_best_int',
    bytes: 1_656_239,
    sha256: '11fe2610dab05d8a880d02f193ce70203f4c4bbe061b987d5529a2c038a22743',
  }),
} as const);

function option(id: OcrLanguageOptionId, label: string, languages: readonly OcrLanguageCode[]): OcrLanguageOption {
  const downloadBytes = languages.reduce((sum, code) => sum + OCR_LANGUAGE_DATA[code].bytes, 0);
  return Object.freeze({ id, label, languages: Object.freeze([...languages]), downloadBytes });
}

export const OCR_LANGUAGE_OPTIONS: readonly OcrLanguageOption[] = Object.freeze([
  option('eng+msa', 'English + Malay', ['eng', 'msa']),
  option('chi_sim+eng', '简体中文 + English', ['chi_sim', 'eng']),
  option('chi_tra+eng', '繁體中文 + English', ['chi_tra', 'eng']),
]);

/** MYR → 'eng+msa'; anything else (HKD) → 'chi_tra+eng' (brief §27). */
export function defaultOcrLanguageOption(workspaceCurrency: string): OcrLanguageOptionId {
  return workspaceCurrency === 'MYR' ? 'eng+msa' : 'chi_tra+eng';
}

export function ocrLanguageOption(id: OcrLanguageOptionId): OcrLanguageOption {
  const found = OCR_LANGUAGE_OPTIONS.find((o) => o.id === id);
  if (!found) throw new RangeError(`Unknown OCR language option: ${String(id)}`);
  return found;
}
