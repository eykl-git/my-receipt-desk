/** Spreadsheet view (design §9.3): the familiar manual columns over the same records. Read-only; no injected mistakes. */
import { useMemo } from 'react';
import { categoryName } from '../../domain/categories';
import { COPY } from '../copy';
import { batchFilter } from '../filters';
import { receiptAmount, receiptDate, receiptMerchant, txAmount, txRef } from '../format';
import { store, useAppState, useDerived } from '../store';
import { TableWrap } from './TableWrap';

export function SpreadsheetView() {
  const s = useAppState();
  const { view } = useDerived();
  const snap = store.snapshot();
  const filter = useMemo(() => batchFilter(s.batchFilter, snap), [s.batchFilter, snap]);
  const linked = new Map(snap.matches.filter((m) => m.status === 'active').map((m) => [m.subject.id, m.transactionId]));
  const receipts = snap.receipts.filter((r) => filter.receipt(r, view.caseById.get(r.id)));
  const loose = view.transactionCases
    .map((c) => ({ c, t: snap.transactions.find((x) => x.id === c.transactionId)! }))
    .filter(({ t }) => t && filter.transaction(t));
  return (
    <section className="sheet" aria-label={COPY.viewSpreadsheet}>
      {receipts.length === 0 && loose.length === 0 ? (
        <p className="empty-state">{s.workspace === 'demo' ? COPY.emptyDemo : COPY.emptyPersonal}</p>
      ) : (
        <TableWrap label={COPY.viewSpreadsheet} scroll>
          <table className="table table-sheet" data-testid="spreadsheet">
            <thead>
              <tr>
                {COPY.sheetCols.map((c, i) => (
                  <th key={i} scope="col" className={i === 2 ? 'right' : undefined}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {receipts.map((r) => {
                const c = view.caseById.get(r.id);
                const txId = linked.get(r.id) ?? c?.proposal?.transactionId ?? null;
                const t = txId ? snap.transactions.find((x) => x.id === txId) : undefined;
                return (
                  <tr key={r.id}>
                    <td className="num">{receiptDate(r)}</td>
                    <td>{receiptMerchant(r)}</td>
                    <td className="num right">{receiptAmount(r)}</td>
                    <td>{c?.category.categoryId ? categoryName(c.category.categoryId) : ''}</td>
                    <td className="mono">{t ? txRef(t) : ''}</td>
                    <td>{c?.group === 'recorded' ? COPY.yes : COPY.no}</td>
                    <td>{c?.explanation ?? ''}</td>
                    <td>
                      <button type="button" className="link-button" onClick={() => void store.openCase(r.id)} aria-label={`${COPY.review} ${r.id}`}>
                        {COPY.review}
                      </button>
                    </td>
                  </tr>
                );
              })}
              {loose.map(({ c, t }) => (
                <tr key={t.id}>
                  <td className="num">{t.postingDate}</td>
                  <td>{t.rawLabel}</td>
                  <td className="num right">{txAmount(t)}</td>
                  <td />
                  <td className="mono">{txRef(t)}</td>
                  <td>{COPY.no}</td>
                  <td>{c.explanation}</td>
                  <td>
                    <button type="button" className="link-button" onClick={() => void store.openTransaction(t.id)} aria-label={`${COPY.review} ${txRef(t)}`}>
                      {COPY.review}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </section>
  );
}
