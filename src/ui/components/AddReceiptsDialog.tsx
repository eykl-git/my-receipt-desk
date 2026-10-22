/** "Add receipts" (design §10.1): JPEG/PNG only, checked before any write; fields are entered manually. */
import { useId, useState } from 'react';
import { checkReceiptFile, TOO_MANY_FILES_MESSAGE } from '../../domain/capture/upload';
import { LIMITS } from '../../domain/limits';
import { validatePayableInput, type PayableErrors, type PayableInput } from '../../domain/ledger/invoice';
import { addPayable, addReceipts, duplicateUploadNotice, type ReceiptUpload } from '../../persistence/commands';
import { sha256Hex } from '../../persistence/hash';
import { COPY } from '../copy';
import { store, useAppState } from '../store';
import { Modal } from './Modal';

/** "Invoice (not yet paid)" (§10.3): one file plus the invoice fields, saved together as an unpaid payable. */
function AddInvoiceForm() {
  const s = useAppState();
  const fileId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [values, setValues] = useState<PayableInput>({ supplierName: '', invoiceNumber: '', invoiceDate: '', amount: '', currency: store.snapshot().currency });
  const [errors, setErrors] = useState<PayableErrors>({});
  const [message, setMessage] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const [added, setAdded] = useState<string | null>(null);

  const submit = async () => {
    setMessage(null);
    setErrors({});
    if (!file) {
      setMessage({ text: COPY.chooseInvoiceFile, tone: 'error' });
      return;
    }
    const v = validatePayableInput(values);
    if (!v.ok) {
      setErrors(v.errors);
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const check = checkReceiptFile(file.name, file.type, bytes);
    if (!check.ok) {
      setMessage({ text: check.message, tone: 'error' });
      return;
    }
    let outcome: Awaited<ReturnType<typeof addPayable>> | null = null;
    const upload = { fileName: file.name, mimeType: file.type, bytes, sha256: await sha256Hex(bytes) };
    const r = await store.run('adding the invoice', async (repo) => {
      outcome = await addPayable(repo, upload, values);
    });
    if (!r.ok) {
      setMessage({ text: r.message, tone: 'error' });
      return;
    }
    const o = outcome as Awaited<ReturnType<typeof addPayable>> | null;
    if (o?.payableId) {
      setAdded(o.payableId);
      setMessage({ text: COPY.invoiceAdded(o.payableId), tone: 'ok' });
      store.announce(COPY.invoiceAdded(o.payableId));
    } else if (o?.duplicateOf) setMessage({ text: COPY.invoiceDuplicate(o.duplicateOf), tone: 'error' });
  };

  const input = (key: keyof PayableInput, label: string, type = 'text') => (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        className="input"
        type={type}
        value={values[key]}
        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        aria-invalid={errors[key] ? true : undefined}
        aria-describedby={errors[key] ? `inv-err-${key}` : undefined}
        inputMode={key === 'amount' ? 'decimal' : undefined}
      />
      {errors[key] ? (
        <span id={`inv-err-${key}`} className="error-text">
          {errors[key]}
        </span>
      ) : null}
    </label>
  );

  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="full-row">{COPY.invoiceHelp}</p>
      <label className="field full-row" htmlFor={fileId}>
        <span className="field-label">{COPY.invoiceFile}</span>
      </label>
      <input id={fileId} className="input full-row" type="file" accept="image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      {input('supplierName', COPY.supplier)}
      {input('invoiceNumber', COPY.invoiceNumber)}
      {input('invoiceDate', COPY.invoiceDate, 'date')}
      {input('amount', COPY.colAmount)}
      {input('currency', COPY.txCurrency)}
      {message ? (
        <p className={message.tone === 'error' ? 'error-text full-row' : 'full-row'} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
      <div className="button-row full-row">
        <button type="submit" className="btn btn-primary" disabled={s.busy}>
          {COPY.addInvoice}
        </button>
        {added ? (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              store.closeDialog();
              store.openInvoice(added);
            }}
          >
            {COPY.openCase(added)}
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function AddReceiptsDialog() {
  const s = useAppState();
  const [kind, setKind] = useState<'receipt' | 'invoice'>('receipt');
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ added: string[]; messages: string[] } | null>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    if (files.length > LIMITS.receiptFilesPerSelection) {
      setResult({ added: [], messages: [TOO_MANY_FILES_MESSAGE] });
      return;
    }
    setBusy(true);
    const messages: string[] = [];
    const uploads: ReceiptUpload[] = [];
    for (const file of [...files]) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const check = checkReceiptFile(file.name, file.type, bytes);
      if (!check.ok) {
        messages.push(check.message);
        continue;
      }
      uploads.push({ fileName: file.name, mimeType: file.type, bytes, sha256: await sha256Hex(bytes) });
    }
    let added: string[] = [];
    if (uploads.length > 0) {
      let outcome: Awaited<ReturnType<typeof addReceipts>> | null = null;
      const r = await store.run('adding receipts', async (repo) => {
        outcome = await addReceipts(repo, uploads);
      });
      if (!r.ok) messages.push(r.message);
      else if (outcome) {
        const o = outcome as Awaited<ReturnType<typeof addReceipts>>;
        added = o.added;
        for (const d of o.duplicates) messages.push(`${d.fileName}: ${duplicateUploadNotice(d.matchedReceiptId)}`);
      }
    }
    setBusy(false);
    setResult({ added, messages });
    if (added.length > 0) store.announce(COPY.added(added.length));
  };

  const typeChoice =
    s.workspace === 'personal' ? (
      <fieldset className="fieldset type-choice">
        <legend className="field-label">{COPY.addType}</legend>
        <label className="radio-row">
          <input type="radio" name="add-type" checked={kind === 'receipt'} onChange={() => setKind('receipt')} />
          <span>{COPY.typeReceipt}</span>
        </label>
        <label className="radio-row">
          <input type="radio" name="add-type" checked={kind === 'invoice'} onChange={() => setKind('invoice')} />
          <span>{COPY.typeInvoice}</span>
        </label>
      </fieldset>
    ) : null;

  if (kind === 'invoice') {
    return (
      <Modal title={COPY.addReceiptsTitle} onClose={() => store.closeDialog()}>
        {typeChoice}
        <AddInvoiceForm />
      </Modal>
    );
  }

  return (
    <Modal title={COPY.addReceiptsTitle} onClose={() => store.closeDialog()}>
      {typeChoice}
      <p className="disclosure-label">{COPY.manualExtraction}</p>
      <p>{COPY.addReceiptsHelp}</p>
      <label className="field" htmlFor={inputId}>
        <span className="field-label">{COPY.addReceiptsFile}</span>
      </label>
      <input id={inputId} className="input" type="file" accept="image/jpeg,image/png" multiple disabled={busy} onChange={(e) => void onFiles(e.target.files)} />
      {busy ? (
        <p className="muted" aria-busy="true">
          {COPY.checkingFiles}
        </p>
      ) : null}
      {result ? (
        <div aria-live="polite">
          {result.added.length > 0 ? (
            <>
              <p>{COPY.added(result.added.length)}</p>
              <div className="button-row">
                {result.added.map((id) => (
                  <button
                    key={id}
                    type="button"
                    className="btn btn-secondary btn-small"
                    onClick={() => {
                      store.closeDialog();
                      void store.openCase(id);
                    }}
                  >
                    {COPY.openCase(id)}
                  </button>
                ))}
              </div>
            </>
          ) : null}
          {result.messages.length > 0 ? (
            <>
              <h3 className="list-heading">{COPY.rejectedFiles}</h3>
              <ul className="plain-list">
                {result.messages.map((m) => (
                  <li key={m} className="error-text">
                    {m}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
