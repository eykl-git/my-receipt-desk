/**
 * Engine configuration (ocr-design.md §2.3, §3, §5). Every path is derived from
 * the caller's asset base, so tesseract.js's built-in remote defaults are
 * never used. In the browser the base comes from `assetUrl(OCR_ASSET_DIR)`.
 */
import type { OcrLanguageCode } from './languages';

/** S4 passes `assetUrl(OCR_ASSET_DIR)` as the engine's asset base. */
export const OCR_ASSET_DIR = 'ocr/';
export const OCR_DEFAULT_TIMEOUT_MS = 60_000;
/** IndexedDB cache key prefix for downloaded language files (browser only). */
export const OCR_CACHE_PATH = 'mrd-ocr/4.0.0_best_int';

export type OcrRuntime = 'browser' | 'node';

export interface OcrEngineConfig {
  readonly runtime: OcrRuntime;
  readonly languages: readonly OcrLanguageCode[];
  /** Browser: `${assetBase}worker.min.js`; node: null (tesseract.js's local node worker). */
  readonly workerPath: string | null;
  /** Browser: `${assetBase}core/`; node: null (required from node_modules). */
  readonly corePath: string | null;
  /** `${assetBase}lang` (browser URL path or node filesystem directory). */
  readonly langPath: string;
  /** Classic same-origin worker, so no blob: in worker-src. */
  readonly workerBlobURL: false;
  /** Browser 'write' (IndexedDB); node 'none' (never writes into cwd). */
  readonly cacheMethod: 'write' | 'none';
  readonly cachePath: string;
  readonly gzip: true;
}

function withSlash(base: string): string {
  return base.endsWith('/') ? base : `${base}/`;
}

export function resolveOcrEngineConfig(o: {
  assetBase: string;
  languages: readonly OcrLanguageCode[];
  runtime: OcrRuntime;
}): OcrEngineConfig {
  const base = withSlash(o.assetBase);
  const languages = Object.freeze([...o.languages]);
  if (o.runtime === 'node') {
    return Object.freeze({
      runtime: 'node',
      languages,
      workerPath: null,
      corePath: null,
      langPath: `${base}lang`,
      workerBlobURL: false,
      cacheMethod: 'none',
      cachePath: OCR_CACHE_PATH,
      gzip: true,
    });
  }
  return Object.freeze({
    runtime: 'browser',
    languages,
    workerPath: `${base}worker.min.js`,
    corePath: `${base}core/`,
    langPath: `${base}lang`,
    workerBlobURL: false,
    cacheMethod: 'write',
    cachePath: OCR_CACHE_PATH,
    gzip: true,
  });
}

/** 'node' only outside a browser window with a Node version present; 'browser' otherwise. */
export function detectOcrRuntime(): OcrRuntime {
  const node = (globalThis as { process?: { versions?: { node?: unknown } } }).process?.versions?.node;
  return typeof window === 'undefined' && typeof node === 'string' ? 'node' : 'browser';
}
