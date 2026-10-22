/** Invoice drawer (design §10.3, REQ-17): the original file, its fields, and "Link card payment". */
import { useId, useState } from 'react';
import { paymentCandidates } from '../../domain/ledger/invoice';
import { formatMoney } from '../../domain/money';
import { attachPayment } from '../../persistence/commands';
import { COPY } from '../copy';
import { txAmount, txRef } from '../format';
import { useFileUrl } from '../hooks';
import { store, useAppState } from '../store';
import { AmberChip, NeutralChip } from './Chips';
import { Modal } from './Modal';

export function InvoiceDrawer({ payableId }: { payableId: string }) {
  const s = useAppState();
  const snap = store.snapshot();
  const p = snap.payables.find((x) => x.id === payableId);
  const doc = p ? snap.sourceDocuments.find((d) => d.id === p.sourceDocumentId) : undefined;
  const url = useFileUrl(doc?.fileKey ?? null);
  const reasonId = useId();
  const [linkOpen, setLinkOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!p) return null;
  const candidates = paymentCandidates(p, snap.transactions, { matches: snap.matches, ledger: snap.ledger, currency: snap.currency });
  const entry = p.paidByMatchId ? snap.ledger.find((e) => e.evidence.matchIds.includes(p.paidByMatchId!) && e.status === 'recorded') : undefined;
  const unsupported = p.currency !== snap.currency;
  const chosen = selected ?? (candidates.length === 1 ? candidates[0]!.id : null);
  const disabledReason = unsupported ? COPY.invoiceUnsupported(p.currency, snap.currency) : candidates.length === 0 ? COPY.pickerEmpty : null;

  const submit = async () => {
    if (!chosen) return;
    setError(null);
    const r = await store.run(`linking the payment of ${p.id}`, (repo) => attachPayment(repo, p.id, chosen, reason));
    if (!r.ok) {
      setError(r.message);
      return;
    }
    const after = store.snapshot().payables.find((x) => x.id === p.id);
    const m = after?.paidByMatchId ? store.snapshot().matches.find((x) => x.id === after.paidByMatchId) : undefined;
    store.announce(COPY.paymentDone(p.id, m?.ledgerEntryId ?? ''));
    setLinkOpen(false);
  };

  const footer =
    p.state === 'unpaid' ? (
      <div className="drawer-actions">
        <div className="action-with-help">
          <button type="button" className="btn btn-secondary" disabled={disabledReason !== null || linkOpen} onClick={() => setLinkOpen(true)}>
            {COPY.linkPayment}
          </button>
          <span className="help">{disabledReason ?? COPY.linkPaymentHelp}</span>
        </div>
      </div>
    ) : entry ? (
      <div className="drawer-actions">
        <button type="button" className="btn btn-secondary" onClick={() => store.openDialog({ kind: 'void', ledgerEntryId: entry.id, mode: 'void', receiptId: null })}>
          {COPY.voidEntry}
        </button>
      </div>
    ) : undefined;

  return (
    <Modal variant="drawer" testId="drawer" title={COPY.invoiceTitle(p.id)} onClose={() => store.closeDrawer()} footer={footer}>
      <div className="chip-row">{p.state === 'paid' ? <span className="chip chip-green">{COPY.paid}</span> : <AmberChip text={COPY.notYetPaid} />}</div>
      {entry ? <p>{COPY.paidBy(entry.id)}</p> : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {linkOpen ? (
        <section className="drawer-section" aria-label={COPY.linkPayment}>
          <h3 className="drawer-section-title">{COPY.linkPayment}</h3>
          <form
            className="manual-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <fieldset className="fieldset">
              <legend className="field-label">{COPY.chooseTransaction}</legend>
              {candidates.map((t) => (
                <label key={t.id} className="radio-row">
                  <input type="radio" name="payment" value={t.id} checked={chosen === t.id} onChange={() => setSelected(t.id)} />
                  <span className="mono">{txRef(t)}</span>
                  <span>{t.rawLabel}</span>
                  <span className="num">{t.postingDate}</span>
                  <span className="num">{txAmount(t)}</span>
                </label>
              ))}
            </fieldset>
            <label className="field" htmlFor={reasonId}>
              <span className="field-label">{COPY.paymentReason}</span>
            </label>
            <textarea id={reasonId} className="input" rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="button-row">
              <button type="submit" className="btn btn-primary" disabled={chosen === null || reason.trim().length < 3 || s.busy}>
                {COPY.confirmAndRecord}
              </button>
              <button type="button" className="btn btn-tertiary" onClick={() => setLinkOpen(false)}>
                {COPY.cancel}
              </button>
            </div>
            {chosen === null ? <p className="muted">{COPY.chooseOne}</p> : reason.trim().length < 3 ? <p className="muted">{COPY.reasonHelp}</p> : null}
          </form>
        </section>
      ) : null}
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.originalInvoice}</h3>
        <figure className="receipt-figure">
          {url ? <img src={url} alt={COPY.invoiceImageAlt(p.id)} className="receipt-image" /> : null}
          <figcaption className="muted" title={doc?.fileName}>
            {doc ? (doc.fileName.length > 200 ? `${doc.fileName.slice(0, 200)}…` : doc.fileName) : COPY.evidenceMissing(p.sourceDocumentId)}
          </figcaption>
        </figure>
      </section>
      <section className="drawer-section">
        <table className="table">
          <tbody>
            <tr>
              <th scope="row">{COPY.supplier}</th>
              <td>{p.supplierName}</td>
            </tr>
            <tr>
              <th scope="row">{COPY.invoiceNumber}</th>
              <td className="mono">{p.invoiceNumber ?? '—'}</td>
            </tr>
            <tr>
              <th scope="row">{COPY.invoiceDate}</th>
              <td className="num">{p.invoiceDate}</td>
            </tr>
            <tr>
              <th scope="row">{COPY.colAmount}</th>
              <td className="num">{formatMoney(p.amountMinor, p.currency)}</td>
            </tr>
          </tbody>
        </table>
        {unsupported ? <NeutralChip text={COPY.invoiceUnsupported(p.currency, snap.currency)} /> : null}
      </section>
    </Modal>
  );
}
