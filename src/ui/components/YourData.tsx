/** "Your data" column (design §9.3): input buttons, workspace badge, filter chips, receipts and card rows. */
import { useId, useMemo, useState } from 'react';
import { assetUrl } from '../../config/base';
import { WORKSPACE_CURRENCIES, type WorkspaceCurrency } from '../../domain/schemas';
import { currencyLockReason } from '../../persistence/commands/settings';
import { categoryName } from '../../domain/categories';
import type { CaseView } from '../../domain/matching/caseView';
import type { Receipt } from '../../domain/schemas';
import { hasSubtleCrypto } from '../../persistence/hash';
import { formatMoney } from '../../domain/money';
import { COPY } from '../copy';
import { batchFilter } from '../filters';
import { receiptAmount, receiptDate, receiptMerchant, txAmount, txRef, txRefClass } from '../format';
import { useFileUrl } from '../hooks';
import { IconCard, IconDownload, IconPlay, IconReceipt, IconUpload } from '../icons';
import type { ListFilter } from '../state';
import { store, useAppState, useDerived } from '../store';
import { AmberChip, GroupChip, NeutralChip } from './Chips';

function Thumb({ receipt }: { receipt: Receipt }) {
  const doc = store.snapshot().sourceDocuments.find((d) => d.id === receipt.sourceDocumentId);
  const url = useFileUrl(doc?.fileKey ?? null);
  return <span className="thumb">{url ? <img src={url} alt="" /> : <IconReceipt />}</span>;
}

function ReceiptCard({ receipt, c }: { receipt: Receipt; c: CaseView | undefined }) {
  return (
    <li>
      <button type="button" className="item-card" onClick={() => void store.openCase(receipt.id)}>
        <Thumb receipt={receipt} />
        <span className="item-main">
          <span className="item-title">
            <span className="mono">{receipt.id}</span> {receiptMerchant(receipt)}
          </span>
          <span className="item-meta">
            <span className="num">{receiptDate(receipt)}</span> · <span className="num">{receiptAmount(receipt)}</span>
          </span>
          <span className="chip-row">
            {c?.group ? <GroupChip group={c.group} /> : <NeutralChip text={COPY.setAsideFootnote} />}
            {c?.capture === 'needs_review' ? <AmberChip text={COPY.fieldsNeedReview} /> : null}
            {c && c.category.categoryId ? <NeutralChip text={`${categoryName(c.category.categoryId)} (${c.category.status})`} /> : null}
          </span>
        </span>
      </button>
    </li>
  );
}

function downloadExample(bytes: Uint8Array) {
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'example-card-statement.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** My files currency (REQ-20): HKD or MYR, only while the workspace is empty; otherwise disabled with the reason. */
function CurrencySetting() {
  const s = useAppState();
  const id = useId();
  const helpId = useId();
  const snap = store.snapshot('personal');
  const locked = currencyLockReason(snap);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="currency-setting">
      <label className="field-inline" htmlFor={id}>
        <span className="field-label">{COPY.currencyLabel}</span>
      </label>
      <select
        id={id}
        className="select"
        value={snap.currency}
        disabled={locked !== null || s.busy}
        aria-describedby={helpId}
        onChange={(e) => {
          setError(null);
          void store.setCurrency(e.target.value as WorkspaceCurrency).then((r) => {
            if (!r.ok) setError(r.message);
          });
        }}
      >
        {WORKSPACE_CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <p id={helpId} className="muted">
        {locked ?? COPY.currencyHelp}
      </p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <details className="samples-disclosure">
        <summary className="samples-summary">Sample test files (Malaysia MYR)</summary>
        <p className="muted samples">
          <a className="link-button" href={assetUrl('samples/sample-receipt-my.png')} download="sample-receipt-my.png">
            <IconDownload />
            {COPY.sampleReceiptMy}
          </a>{' '}
          <a className="link-button" href={assetUrl('samples/example-card-statement-my.csv')} download="example-card-statement-my.csv">
            <IconDownload />
            {COPY.sampleCsvMy}
          </a>
          <span className="block">{COPY.samplesNote}</span>
        </p>
      </details>
    </div>
  );
}

export function YourData() {
  const s = useAppState();
  const { view } = useDerived();
  const snap = store.snapshot();
  const filter = useMemo(() => batchFilter(s.batchFilter, snap), [s.batchFilter, snap]);
  const secure = hasSubtleCrypto();
  const demoEmpty = store.snapshot('demo').demoState.loadedBatches.length === 0;
  const showTry = s.workspace === 'personal' || demoEmpty;
  const loading = s.demoLoad === 'loading';
  const workspaceEmpty = snap.receipts.length === 0 && snap.transactions.length === 0 && snap.payables.length === 0;

  const toPersonal = (kind: 'addReceipts' | 'import') => {
    if (s.workspace === 'demo') {
      store.switchWorkspace('personal');
      store.notify(COPY.switchedToPersonal);
    }
    store.openDialog({ kind });
  };

  const receipts = snap.receipts.filter((r) => {
    const c = view.caseById.get(r.id);
    if (!filter.receipt(r, c)) return false;
    if (s.listFilter === 'all') return true;
    if (s.listFilter === 'transactions' || s.listFilter === 'invoices') return false;
    return c?.group === s.listFilter;
  });
  const transactions = snap.transactions.filter((t) => filter.transaction(t) && (s.listFilter === 'all' || s.listFilter === 'transactions'));
  const flags = new Map(view.transactionCases.map((t) => [t.transactionId, t]));
  const linked = new Map(snap.matches.filter((m) => m.status === 'active').map((m) => [m.transactionId, m.subject.id]));

  const filters: ListFilter[] = ['all', 'needs_decision', 'ready', 'recorded', 'transactions', ...(snap.payables.length > 0 ? (['invoices'] as const) : [])];
  const showInvoices = snap.payables.length > 0 && (s.listFilter === 'all' || s.listFilter === 'invoices');
  return (
    <section className="column column-data" aria-labelledby="col-data">
      <div className="column-head">
        <h2 id="col-data" className="column-title">
          {COPY.yourData}
        </h2>
        <span className={`chip ${s.workspace === 'demo' ? 'chip-teal' : 'chip-muted'}`}>{s.workspace === 'demo' ? COPY.badgeDemo : COPY.badgePersonal}</span>
      </div>
      <div className="button-stack">
        {showTry ? (
          <button type="button" className={`btn btn-primary${workspaceEmpty ? ' btn-large' : ''}`} disabled={loading || !secure} aria-busy={loading} onClick={() => void store.tryDemo()}>
            <IconPlay />
            {loading ? COPY.loadingDemo : COPY.tryDemo}
          </button>
        ) : null}
        <div className="button-row">
          <button type="button" className="btn btn-secondary" disabled={!secure} onClick={() => toPersonal('addReceipts')}>
            <IconUpload />
            {COPY.addReceipts}
          </button>
          <button type="button" className="btn btn-secondary" disabled={!secure} onClick={() => toPersonal('import')}>
            <IconCard />
            {COPY.importCsv}
          </button>
        </div>
        {s.exampleCsv instanceof Uint8Array ? (
          <button type="button" className="btn btn-tertiary" onClick={() => downloadExample(s.exampleCsv as Uint8Array)}>
            <IconDownload />
            {COPY.downloadExample}
          </button>
        ) : s.exampleCsv === 'failed' ? (
          <p className="muted">
            <button type="button" className="btn btn-tertiary" disabled>
              <IconDownload />
              {COPY.downloadExample}
            </button>{' '}
            {COPY.exampleUnavailable}
          </p>
        ) : null}
        {!secure ? <p className="error-text">{COPY.secureContext}</p> : null}
      </div>

      {s.workspace === 'personal' ? <CurrencySetting /> : null}

      {workspaceEmpty ? (
        <p className="empty-state">{s.workspace === 'demo' ? COPY.emptyDemo : COPY.emptyPersonal}</p>
      ) : (
        <>
          <div className="filter-chips" role="group" aria-label={COPY.filterLabel}>
            {filters.map((f) => (
              <button key={f} type="button" className="filter-chip" aria-pressed={s.listFilter === f} onClick={() => store.setListFilter(f)}>
                {COPY.filters[f]}
              </button>
            ))}
          </div>
          {showInvoices ? (
            <>
              <h3 className="list-heading">{COPY.invoicesHeading}</h3>
              <ul className="item-list" data-testid="invoice-list">
                {snap.payables.map((p) => (
                  <li key={p.id}>
                    <button type="button" className="item-row" onClick={() => store.openInvoice(p.id)}>
                      <span className="mono">{p.id}</span>
                      <span className="item-label">
                        {p.supplierName}
                        {p.invoiceNumber ? ` · ${p.invoiceNumber}` : ''}
                      </span>
                      <span className="num muted">{p.invoiceDate}</span>
                      <span className="num amount">{formatMoney(p.amountMinor, p.currency)}</span>
                      <span className="item-flag">{p.state === 'paid' ? <span className="chip chip-green">{COPY.paid}</span> : <AmberChip text={COPY.notYetPaid} />}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {s.listFilter !== 'transactions' && s.listFilter !== 'invoices' ? (
            <>
              <h3 className="list-heading">{COPY.receiptsHeading}</h3>
              {receipts.length === 0 ? (
                <p className="muted">{COPY.emptyFilter}</p>
              ) : (
                <ul className="item-list" data-testid="receipt-list">
                  {receipts.map((r) => (
                    <ReceiptCard key={r.id} receipt={r} c={view.caseById.get(r.id)} />
                  ))}
                </ul>
              )}
            </>
          ) : null}
          {s.listFilter === 'all' || s.listFilter === 'transactions' ? (
            <>
              <h3 className="list-heading">{COPY.transactionsHeading}</h3>
              {transactions.length === 0 ? (
                <p className="muted">{COPY.emptyFilter}</p>
              ) : (
                <ul className="item-list">
                  {transactions.map((t) => {
                    const f = flags.get(t.id);
                    const linkedTo = linked.get(t.id);
                    return (
                      <li key={t.id}>
                        <button type="button" className="item-row" onClick={() => void store.openTransaction(t.id)}>
                          <span className={txRefClass(t)}>{txRef(t)}</span>
                          <span className="item-label">{t.rawLabel}</span>
                          <span className="num muted">{t.postingDate}</span>
                          <span className="num amount">{txAmount(t)}</span>
                          <span className="item-flag">
                            {f ? (
                              <AmberChip text={f.explanation} />
                            ) : linkedTo ? (
                              <NeutralChip text={COPY.linkedShort(linkedTo)} />
                            ) : t.intake === 'set_aside_duplicate' ? (
                              <NeutralChip text={COPY.rowSetAside} />
                            ) : null}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          ) : null}
        </>
      )}
    </section>
  );
}
