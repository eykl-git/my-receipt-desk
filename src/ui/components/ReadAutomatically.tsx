/**
 * "Read automatically" in the receipt drawer (brief §26 B, §27, task 4.8a,
 * ocr-design §2.3). Runs only on a click, on an uploaded receipt whose fields
 * have not been saved yet. Language data comes from this site (assetUrl) and is
 * downloaded on first use for the chosen languages only. Progress, "Cancel"
 * and a 60 s timeout are shown; a failure leaves the record unchanged. The
 * result becomes unconfirmed `original` field values (provenance ocr) that the
 * user checks and saves with "Save fields". Receipt text is shown as text only.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { assetUrl } from '../../config/base';
import { detectedRegions } from '../../domain/capture/ocrLocale';
import type { OcrOutcome } from '../state';
import type { Receipt } from '../../domain/schemas';
import { applyExtraction } from '../../persistence/commands';
import {
  createOcrAdapter,
  createTesseractEngine,
  defaultOcrLanguageOption,
  isOcrError,
  OCR_ASSET_DIR,
  OCR_DEFAULT_TIMEOUT_MS,
  OCR_LANGUAGE_OPTIONS,
  ocrLanguageOption,
  type OcrLanguageOptionId,
  type OcrProgress,
} from '../../ocr';
import { COPY } from '../copy';
import { IconClose, IconEye } from '../icons';
import { store, useAppState } from '../store';

/** Worker + one core file, fetched once with the first option used (ocr-design §4). */
const ENGINE_BYTES = 111_307 + 3_905_767;

type Outcome = Omit<OcrOutcome, 'receiptId'>;

export function ReadAutomatically({ receipt }: { receipt: Receipt }) {
  const s = useAppState();
  const selectId = useId();
  const workspaceCurrency = store.snapshot(receipt.workspaceId).currency;
  const [option, setOption] = useState<OcrLanguageOptionId>(defaultOcrLanguageOption(workspaceCurrency));
  const [progress, setProgress] = useState<OcrProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const reading = progress !== null;

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (reading) cancelRef.current?.focus();
  }, [reading]);

  const read = async () => {
    setError(null);
    const doc = store.snapshot().sourceDocuments.find((d) => d.id === receipt.sourceDocumentId);
    const file = doc ? await store.repo().getFile(doc.fileKey) : null;
    if (!file) return setError(COPY.ocrFailed);
    const ctrl = new AbortController();
    controller.current = ctrl;
    setProgress({ stage: 'loading-engine', progress: 0 });
    const engine = createTesseractEngine({
      assetBase: assetUrl(OCR_ASSET_DIR),
      languages: ocrLanguageOption(option).languages,
      onProgress: (p) => setProgress(p),
      signal: ctrl.signal,
      timeoutMs: OCR_DEFAULT_TIMEOUT_MS,
    });
    try {
      const adapter = createOcrAdapter(engine);
      const { result, locale } = await adapter.extractWithDetails({ file, sourceDocumentId: receipt.sourceDocumentId });
      const r = await store.run(`reading ${receipt.id}`, (repo) => applyExtraction(repo, receipt.id, { id: adapter.id, kind: 'ocr' }, result));
      if (!r.ok) setError(r.message);
      else {
        store.setOcrOutcome(receipt.id, { locale, notes: [...result.warnings], currency: result.currency.value });
        store.announce(COPY.ocrDone(receipt.id));
      }
    } catch (e) {
      if (isOcrError(e)) {
        console.warn(e);
        setError(
          e.code === 'cancelled'
            ? COPY.ocrCancelled
            : e.code === 'timeout'
              ? `${COPY.ocrFailed} ${COPY.ocrTimeout}`
              : e.code === 'asset-load-failed'
                ? `${COPY.ocrFailed} ${COPY.ocrAssetsFailed}`
                : COPY.ocrFailed,
        );
      } else setError(COPY.ocrFailed);
    } finally {
      await engine.terminate().catch(() => undefined);
      controller.current = null;
      setProgress(null);
    }
  };

  const selected = ocrLanguageOption(option);
  const mb = ((selected.downloadBytes + ENGINE_BYTES) / 1_000_000).toFixed(1);
  return (
    <div className="ocr-box" data-testid="ocr-box">
      <div className="form-grid">
        <label className="field" htmlFor={selectId}>
          <span className="field-label">{COPY.ocrLanguage}</span>
          <select id={selectId} className="select" value={option} disabled={reading} onChange={(e) => setOption(e.target.value as OcrLanguageOptionId)}>
            {OCR_LANGUAGE_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="muted">{COPY.ocrNote(mb)}</p>
      {reading ? (
        <div className="ocr-progress" role="status" aria-live="polite">
          <span>{COPY.ocrStage[progress.stage]}</span>
          <progress max={1} value={progress.progress} aria-label={COPY.ocrStage[progress.stage]} />
          <button ref={cancelRef} type="button" className="btn btn-secondary btn-small" onClick={() => controller.current?.abort()}>
            <IconClose />
            {COPY.cancel}
          </button>
        </div>
      ) : (
        <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void read()}>
          <IconEye />
          {COPY.readAutomatically}
        </button>
      )}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What the last read found (evidence lists only, never a score), shown until the drawer closes. */
export function OcrOutcomeNote({ outcome, workspaceCurrency }: { outcome: Outcome; workspaceCurrency: string }) {
  const regions = detectedRegions(outcome.locale);
  return (
    <div className="ocr-outcome" data-testid="ocr-outcome">
      {regions.map((region) => {
        const signals = region === 'malaysia' ? outcome.locale.malaysia : outcome.locale.hongKong;
        return (
          <p key={region}>
            {region === 'malaysia' ? COPY.looksMalaysian : COPY.looksHongKong}{' '}
            {signals.map((sig) => (
              <span key={`${sig.kind}:${sig.text}`} className="chip chip-muted">
                {sig.text}
              </span>
            ))}
          </p>
        );
      })}
      {outcome.currency !== null && outcome.currency !== workspaceCurrency ? <p className="error-text">{COPY.ocrCurrencyMismatch(outcome.currency, workspaceCurrency)}</p> : null}
      {outcome.notes.length > 0 ? (
        <ul className="plain-list">
          {outcome.notes.map((n) => (
            <li key={n} className="muted">
              {n}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
