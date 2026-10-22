/**
 * OCR engine layer (ocr-design.md §2.3, §3, §6): no non-local URL in the
 * config, language options, the asset copy script and typed errors.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  OCR_ASSET_DIR,
  OCR_DEFAULT_TIMEOUT_MS,
  OCR_LANGUAGE_DATA,
  OCR_LANGUAGE_OPTIONS,
  OcrAssetLoadError,
  OcrCancelledError,
  OcrError,
  OcrTimeoutError,
  OcrUnreadableImageError,
  createTesseractEngine,
  defaultOcrLanguageOption,
  detectOcrRuntime,
  isOcrError,
  ocrLanguageOption,
  resolveOcrEngineConfig,
  type OcrLanguageCode,
} from '../../src/ocr';

const ALL_LANGS: OcrLanguageCode[] = ['eng', 'msa', 'chi_sim', 'chi_tra'];
const PNG = readFileSync('public/samples/sample-receipt-my.png');

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

let assets: string;
beforeAll(() => {
  assets = mkdtempSync(join(tmpdir(), 'mrd-ocr-engine-'));
  execFileSync(process.execPath, ['scripts/ocr/copy-assets.mjs', '--out', assets], { stdio: 'pipe' });
});
afterAll(() => {
  rmSync(assets, { recursive: true, force: true });
});

describe('OCR engine config', () => {
  it('OE01 the browser config has no non-local URL: every path sits under the asset base', () => {
    const base = '/my-receipt-desk/ocr/';
    const c = resolveOcrEngineConfig({ assetBase: base, languages: ['eng', 'msa'], runtime: 'browser' });
    expect(c).toEqual({
      runtime: 'browser',
      languages: ['eng', 'msa'],
      workerPath: '/my-receipt-desk/ocr/worker.min.js',
      corePath: '/my-receipt-desk/ocr/core/',
      langPath: '/my-receipt-desk/ocr/lang',
      workerBlobURL: false,
      cacheMethod: 'write',
      cachePath: 'mrd-ocr/4.0.0_best_int',
      gzip: true,
    });
    for (const p of [c.workerPath, c.corePath, c.langPath]) {
      expect(p?.startsWith(base)).toBe(true);
      expect(p).not.toMatch(/^[a-z][a-z0-9+.-]*:\/\//i);
      expect(p?.startsWith('//')).toBe(false);
    }
    expect(JSON.stringify(c)).not.toMatch(/https?:|\/\/(?!$)[a-z]/i);
    // Root base and a base without a trailing slash.
    expect(resolveOcrEngineConfig({ assetBase: '/ocr', languages: ['eng'], runtime: 'browser' }).workerPath).toBe('/ocr/worker.min.js');
    expect(OCR_ASSET_DIR).toBe('ocr/');
  });

  it('OE02 the node config uses filesystem paths only and never caches into cwd', () => {
    const c = resolveOcrEngineConfig({ assetBase: '/tmp/x/ocr', languages: ['chi_tra', 'eng'], runtime: 'node' });
    expect(c).toMatchObject({ workerPath: null, corePath: null, langPath: '/tmp/x/ocr/lang', cacheMethod: 'none' });
    expect(JSON.stringify(c)).not.toMatch(/:\/\//);
    expect(detectOcrRuntime()).toBe('node');
  });

  it('OE03 src/ocr and scripts/ocr contain no http(s) or CDN literal', () => {
    const files = [...filesUnder('src/ocr'), ...filesUnder('scripts/ocr')];
    expect(files.length).toBeGreaterThan(5);
    const findings = files.flatMap((f) => {
      const text = readFileSync(f, 'utf8')
        // The SVG namespace identifier in make-samples is a name, not a request.
        .split('http://www.w3.org/2000/svg')
        .join('');
      return /https?:\/\/|cdn|jsdelivr|unpkg/i.test(text) ? [f] : [];
    });
    expect(findings).toEqual([]);
  });
});

describe('OCR language options', () => {
  it('OE04 three options in order, with exact labels and download sizes', () => {
    expect(OCR_LANGUAGE_OPTIONS.map((o) => [o.id, o.label, o.languages])).toEqual([
      ['eng+msa', 'English + Malay', ['eng', 'msa']],
      ['chi_sim+eng', '简体中文 + English', ['chi_sim', 'eng']],
      ['chi_tra+eng', '繁體中文 + English', ['chi_tra', 'eng']],
    ]);
    for (const o of OCR_LANGUAGE_OPTIONS) {
      expect(o.downloadBytes).toBe(o.languages.reduce((s, l) => s + OCR_LANGUAGE_DATA[l].bytes, 0));
    }
    expect(OCR_LANGUAGE_OPTIONS.map((o) => o.downloadBytes)).toEqual([4_130_009, 4_671_641, 4_609_112]);
    expect(Object.isFrozen(OCR_LANGUAGE_OPTIONS)).toBe(true);
    expect(defaultOcrLanguageOption('MYR')).toBe('eng+msa');
    expect(defaultOcrLanguageOption('HKD')).toBe('chi_tra+eng');
    expect(ocrLanguageOption('chi_sim+eng').label).toBe('简体中文 + English');
    expect(OCR_DEFAULT_TIMEOUT_MS).toBe(60_000);
  });

  it('OE05 copy-assets output matches OCR_LANGUAGE_DATA (size and SHA-256) and ships only the chosen files', () => {
    for (const lang of ALL_LANGS) {
      const file = join(assets, 'lang', `${lang}.traineddata.gz`);
      expect(statSync(file).size).toBe(OCR_LANGUAGE_DATA[lang].bytes);
      expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(OCR_LANGUAGE_DATA[lang].sha256);
    }
    const shipped = filesUnder(assets)
      .map((f) => f.slice(assets.length + 1))
      .sort();
    expect(shipped).toEqual([
      'core/tesseract-core-lstm.wasm.js',
      'core/tesseract-core-relaxedsimd-lstm.wasm.js',
      'core/tesseract-core-simd-lstm.wasm.js',
      'lang/chi_sim.traineddata.gz',
      'lang/chi_tra.traineddata.gz',
      'lang/eng.traineddata.gz',
      'lang/msa.traineddata.gz',
      'licenses/tesseract.js-LICENSE.md',
      'licenses/tesseract.js-core-LICENSE',
      'worker.min.js',
    ]);
  });
});

describe('OCR typed errors (real engine in node)', () => {
  it('OE06 an already-aborted signal rejects with OcrCancelledError without loading anything', async () => {
    const controller = new AbortController();
    controller.abort();
    let progressCalls = 0;
    const engine = createTesseractEngine({
      assetBase: assets,
      languages: ['eng'],
      signal: controller.signal,
      onProgress: () => progressCalls++,
    });
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(OcrCancelledError);
    expect(progressCalls).toBe(0);
    await engine.terminate();
    await engine.terminate(); // idempotent
  });

  it('OE07 non-image bytes and empty input reject with OcrUnreadableImageError before any load', async () => {
    const engine = createTesseractEngine({ assetBase: assets, languages: ['eng'] });
    await expect(engine.recognize(new TextEncoder().encode('not an image'))).rejects.toBeInstanceOf(OcrUnreadableImageError);
    await expect(engine.recognize(new Blob([]))).rejects.toBeInstanceOf(OcrUnreadableImageError);
    await engine.terminate();
  });

  it('OE08 a missing language directory rejects with OcrAssetLoadError', { timeout: 30_000 }, async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mrd-ocr-missing-'));
    const engine = createTesseractEngine({ assetBase: empty, languages: ['eng'], timeoutMs: 20_000 });
    try {
      const err: unknown = await engine.recognize(PNG).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OcrAssetLoadError);
      expect(isOcrError(err)).toBe(true);
      expect((err as OcrError).code).toBe('asset-load-failed');
    } finally {
      await engine.terminate();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('OE09 timeoutMs elapsing rejects with OcrTimeoutError, and the engine is dead afterwards', { timeout: 30_000 }, async () => {
    const engine = createTesseractEngine({ assetBase: assets, languages: ['eng'], timeoutMs: 1 });
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(OcrTimeoutError);
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(OcrCancelledError);
    await engine.terminate();
  });

  it('OE10 aborting during a read rejects with OcrCancelledError and reports progress stages before that', { timeout: 60_000 }, async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const engine = createTesseractEngine({
      assetBase: assets,
      languages: ['eng'],
      signal: controller.signal,
      onProgress: (p) => {
        stages.push(p.stage);
        expect(p.progress).toBeGreaterThanOrEqual(0);
        expect(p.progress).toBeLessThanOrEqual(1);
        if (p.stage === 'loading-language') controller.abort();
      },
    });
    await expect(engine.recognize(PNG)).rejects.toBeInstanceOf(OcrCancelledError);
    expect(stages).toContain('loading-language');
    expect(stages).not.toContain('reading');
    await engine.terminate();
  });

  it('OE11 errors share one base class with a stable code', () => {
    const errors = [new OcrAssetLoadError(), new OcrTimeoutError(), new OcrCancelledError(), new OcrUnreadableImageError()];
    expect(errors.map((e) => [e.name, e.code, e instanceof OcrError, isOcrError(e)])).toEqual([
      ['OcrAssetLoadError', 'asset-load-failed', true, true],
      ['OcrTimeoutError', 'timeout', true, true],
      ['OcrCancelledError', 'cancelled', true, true],
      ['OcrUnreadableImageError', 'unreadable-image', true, true],
    ]);
    expect(isOcrError(new Error('x'))).toBe(false);
    const cause = new Error('inner');
    expect(new OcrAssetLoadError(undefined, { cause }).cause).toBe(cause);
  });
});
