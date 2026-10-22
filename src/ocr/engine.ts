/**
 * tesseract.js engine wrapper (ocr-design.md §2.3). Nothing loads until the
 * first `recognize()`; then one worker is created for the chosen languages
 * only. Each call is raced against a timeout and the caller's AbortSignal;
 * either one terminates the worker and the engine stays dead afterwards.
 */
import Tesseract from 'tesseract.js';
import type { OcrLine } from '../domain/capture/ocrParse';
import { detectOcrRuntime, OCR_DEFAULT_TIMEOUT_MS, resolveOcrEngineConfig, type OcrEngineConfig } from './config';
import { OcrAssetLoadError, OcrCancelledError, OcrTimeoutError, OcrUnreadableImageError, isOcrError } from './errors';
import type { OcrLanguageCode } from './languages';

export type OcrStage = 'loading-engine' | 'loading-language' | 'initializing' | 'reading';
export interface OcrProgress {
  readonly stage: OcrStage;
  /** 0…1 within the stage. */
  readonly progress: number;
}
export interface OcrPage {
  readonly text: string;
  readonly lines: readonly OcrLine[];
}
export interface OcrEngine {
  readonly config: OcrEngineConfig;
  /** Lazily creates the worker and loads only config.languages on first call. Calls are serialised. */
  recognize(image: Blob | Uint8Array): Promise<OcrPage>;
  /** Idempotent. After cancel, timeout or terminate the engine rejects with OcrCancelledError. */
  terminate(): Promise<void>;
}
export interface TesseractEngineOptions {
  /** Browser: assetUrl(OCR_ASSET_DIR), e.g. '/my-receipt-desk/ocr/'; node: absolute dir holding lang/. */
  readonly assetBase: string;
  /** Usually ocrLanguageOption(id).languages. */
  readonly languages: readonly OcrLanguageCode[];
  readonly onProgress?: (p: OcrProgress) => void;
  /** Abort → worker.terminate() → OcrCancelledError. */
  readonly signal?: AbortSignal;
  /** Per recognize() call, including first-use download; default 60 000. */
  readonly timeoutMs?: number;
}

const STAGES: Readonly<Record<string, OcrStage>> = Object.freeze({
  'loading tesseract core': 'loading-engine',
  'initializing tesseract': 'initializing',
  'initializing api': 'initializing',
  'loading language traineddata': 'loading-language',
  'recognizing text': 'reading',
});

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

async function toBytes(image: Blob | Uint8Array): Promise<Uint8Array> {
  if (image instanceof Uint8Array) return image;
  try {
    return new Uint8Array(await image.arrayBuffer());
  } catch (e) {
    throw new OcrUnreadableImageError(undefined, { cause: e });
  }
}

function checkImage(bytes: Uint8Array): void {
  if (!startsWith(bytes, PNG_MAGIC) && !startsWith(bytes, JPEG_MAGIC)) {
    throw new OcrUnreadableImageError('This file is not a PNG or JPEG image.');
  }
}

function clamp01(n: unknown): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function toLines(page: Tesseract.Page): OcrLine[] {
  const out: OcrLine[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        out.push({
          text: line.text.trim(),
          words: line.words.map((w) => ({ text: w.text, confidence: w.confidence })),
        });
      }
    }
  }
  return out;
}

function workerOptions(config: OcrEngineConfig): Partial<Tesseract.WorkerOptions> {
  // Keys are omitted rather than set to undefined: tesseract.js spreads these
  // over its defaults, and an undefined workerPath would replace the node worker.
  const opts: Partial<Tesseract.WorkerOptions> = {
    langPath: config.langPath,
    cacheMethod: config.cacheMethod,
    gzip: config.gzip,
  };
  if (config.runtime === 'browser') {
    opts.cachePath = config.cachePath;
    opts.workerBlobURL = config.workerBlobURL;
    if (config.workerPath !== null) opts.workerPath = config.workerPath;
    if (config.corePath !== null) opts.corePath = config.corePath;
  }
  return opts;
}

export function createTesseractEngine(options: TesseractEngineOptions): OcrEngine {
  const config = resolveOcrEngineConfig({
    assetBase: options.assetBase,
    languages: options.languages,
    runtime: detectOcrRuntime(),
  });
  const timeoutMs = options.timeoutMs ?? OCR_DEFAULT_TIMEOUT_MS;
  const signal = options.signal;
  let dead = false;
  let worker: Tesseract.Worker | null = null;
  let starting: Promise<Tesseract.Worker> | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  const report = (status: string, progress: unknown) => {
    const stage = STAGES[status];
    if (stage && !dead && options.onProgress) options.onProgress({ stage, progress: clamp01(progress) });
  };

  const kill = async (): Promise<void> => {
    dead = true;
    const w = worker;
    worker = null;
    // A worker that is still starting is terminated as soon as it arrives (see startWorker).
    if (w) await w.terminate().catch(() => undefined);
  };

  const startWorker = (): Promise<Tesseract.Worker> =>
    new Promise<Tesseract.Worker>((resolve, reject) => {
      let settled = false;
      const fail = (cause: unknown) => {
        if (settled) return;
        settled = true;
        reject(new OcrAssetLoadError(undefined, { cause }));
      };
      Tesseract.createWorker([...config.languages], Tesseract.OEM.LSTM_ONLY, {
        ...workerOptions(config),
        logger: (m) => report(m.status, m.progress),
        // Without a handler tesseract.js rethrows worker errors as uncaught
        // exceptions, and a failed language load never settles createWorker.
        errorHandler: (e: unknown) => fail(e),
      }).then(
        (w) => {
          if (settled || dead) {
            void w.terminate().catch(() => undefined);
            if (!settled) {
              settled = true;
              reject(new OcrCancelledError());
            }
            return;
          }
          settled = true;
          worker = w;
          resolve(w);
        },
        (e: unknown) => fail(e),
      );
    });

  const run = async (bytes: Uint8Array): Promise<OcrPage> => {
    if (!starting) starting = startWorker();
    const w = await starting;
    let result: Tesseract.RecognizeResult;
    try {
      // Uint8Array is accepted at runtime in both the browser and node builds.
      result = await w.recognize(bytes as unknown as Tesseract.ImageLike, {}, { text: true, blocks: true });
    } catch (e) {
      throw new OcrUnreadableImageError(undefined, { cause: e });
    }
    return { text: result.data.text, lines: toLines(result.data) };
  };

  const guarded = (bytes: Uint8Array): Promise<OcrPage> =>
    new Promise<OcrPage>((resolve, reject) => {
      if (dead || signal?.aborted) {
        void kill();
        reject(new OcrCancelledError());
        return;
      }
      let done = false;
      const finish = (settle: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const onAbort = () =>
        finish(() => {
          void kill();
          reject(new OcrCancelledError());
        });
      const timer = setTimeout(
        () =>
          finish(() => {
            void kill();
            reject(new OcrTimeoutError());
          }),
        timeoutMs,
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      run(bytes).then(
        (page) => finish(() => resolve(page)),
        (e: unknown) => finish(() => reject(isOcrError(e) ? e : new OcrUnreadableImageError(undefined, { cause: e }))),
      );
    });

  signal?.addEventListener('abort', () => void kill(), { once: true });

  return Object.freeze({
    config,
    async recognize(image: Blob | Uint8Array): Promise<OcrPage> {
      if (dead || signal?.aborted) {
        await kill();
        throw new OcrCancelledError();
      }
      const bytes = await toBytes(image);
      checkImage(bytes);
      const turn = queue.then(() => guarded(bytes));
      queue = turn.catch(() => undefined);
      return turn;
    },
    terminate: kill,
  });
}
