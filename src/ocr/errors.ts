/**
 * Typed OCR failures (ocr-design.md §2.3). The adapter never catches them; the
 * caller shows "Couldn't read this image. Enter the fields by hand." and leaves
 * the record unchanged.
 */
export type OcrErrorCode = 'asset-load-failed' | 'timeout' | 'cancelled' | 'unreadable-image';

export class OcrError extends Error {
  readonly code: OcrErrorCode;
  constructor(code: OcrErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OcrError';
    this.code = code;
  }
}

/** The worker, core or language files could not load (offline, 404, blocked). */
export class OcrAssetLoadError extends OcrError {
  constructor(message = 'The reading files could not be loaded. Check the connection and try again.', options?: { cause?: unknown }) {
    super('asset-load-failed', message, options);
    this.name = 'OcrAssetLoadError';
  }
}

/** The time limit passed (this also covers a silent hang). */
export class OcrTimeoutError extends OcrError {
  constructor(message = 'Reading the image took too long and was stopped.', options?: { cause?: unknown }) {
    super('timeout', message, options);
    this.name = 'OcrTimeoutError';
  }
}

/** The signal was aborted, or the engine was used after cancel, timeout or terminate. */
export class OcrCancelledError extends OcrError {
  constructor(message = 'Reading the image was cancelled.', options?: { cause?: unknown }) {
    super('cancelled', message, options);
    this.name = 'OcrCancelledError';
  }
}

/** Empty input, not PNG or JPEG bytes, or recognition failed. */
export class OcrUnreadableImageError extends OcrError {
  constructor(message = "This image couldn't be read.", options?: { cause?: unknown }) {
    super('unreadable-image', message, options);
    this.name = 'OcrUnreadableImageError';
  }
}

export function isOcrError(e: unknown): e is OcrError {
  return e instanceof OcrError;
}
