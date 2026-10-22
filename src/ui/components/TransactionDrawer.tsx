/** Card-transaction drawer: the statement evidence for one row (design §5.1, §9.3) and its duplicate choices (§10.2, M1). */
import { useState } from 'react';
import { recordStatementOnly, resolveStatementDuplicate } from '../../persistence/commands';
import { COPY } from '../copy';
import { txAmount, txRef } from '../format';
import { store, useAppState, useDerived } from '../store';
import { AmberChip, NeutralChip } from './Chips';
import { Modal } from './Modal';

export function TransactionDrawer({ transactionId }: { transactionId: string }) {
  const s = useAppState();
  const { view } = useDerived();
  const [error, setError] = useState<string | null>(null);
  const snap = store.snapshot();
  const t = snap.transactions.find((x) => x.id === transactionId);
  if (!t) return null;
  const doc = snap.sourceDocuments.find((d) => d.id === t.sourceDocumentId);
  const flags = view.transactionCases.find((c) => c.transactionId === t.id);
  const match = snap.matches.find((m) => m.status === 'active' && m.transactionId === t.id);
  const ledger = snap.ledger.find((e) => e.status === 'recorded' && e.identityKey === t.id);
  const related = view.cases.filter((c) => c.proposal && [...c.proposal.candidateIds, ...c.proposal.nearCandidateIds, ...c.proposal.heldIds].includes(t.id));
  const duplicate = flags?.flags.includes('duplicate_suspected') ?? false;
  const setAside = t.intake === 'set_aside_duplicate';
  const rows: Array<[string, string]> = [
    [COPY.txAccount, t.accountLabel],
    [COPY.colLabel, t.rawLabel],
    [COPY.txTransactionDate, t.transactionDate ?? '—'],
    [COPY.txPostingDate, t.postingDate],
    [COPY.colAmount, txAmount(t)],
    [COPY.txDirection, t.direction],
    [COPY.txSource, COPY.txRow(t.rowNumber, doc?.fileName ?? t.sourceDocumentId)],
  ];

  const resolve = async (choice: 'keep' | 'set_aside') => {
    setError(null);
    const ref = txRef(t);
    const r = await store.run(`resolving ${ref}`, (repo) => resolveStatementDuplicate(repo, t.id, choice));
    if (r.ok) store.announce(choice === 'keep' ? COPY.keptDone(ref) : COPY.rowSetAsideDone(ref));
    else setError(r.message);
  };

  const missingReceipt = flags?.flags.includes('missing_receipt') ?? false;
  const statementOnly = ledger && ledger.origin === 'statement_only' ? ledger : undefined;

  const recordFromStatement = async () => {
    setError(null);
    let id = '';
    const r = await store.run(`recording ${txRef(t)}`, async (repo) => {
      id = (await recordStatementOnly(repo, t.id)).ledgerEntryId;
    });
    if (r.ok) store.announce(COPY.statementRecorded(id));
    else setError(r.message);
  };

  const footer = duplicate ? (
    <div className="drawer-actions">
      <div className="action-with-help">
        <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void resolve('keep')}>
          {COPY.keepBoth}
        </button>
        <span className="help">{COPY.keepBothHelp}</span>
      </div>
      <div className="action-with-help">
        <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void resolve('set_aside')}>
          {COPY.setAsideRow}
        </button>
        <span className="help">{COPY.setAsideRowHelp}</span>
      </div>
    </div>
  ) : missingReceipt ? (
    <div className="drawer-actions">
      <div className="action-with-help">
        <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void recordFromStatement()}>
          {COPY.recordFromStatement}
        </button>
        <span className="help">{COPY.recordFromStatementHelp}</span>
      </div>
    </div>
  ) : statementOnly ? (
    <div className="drawer-actions">
      <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => store.openDialog({ kind: 'void', ledgerEntryId: statementOnly.id, mode: 'void', receiptId: null })}>
        {COPY.voidEntry}
      </button>
    </div>
  ) : undefined;

  return (
    <Modal variant="drawer" testId="drawer" title={COPY.transactionTitle(txRef(t))} onClose={() => store.closeDrawer()} footer={footer}>
      <section className="drawer-section">
        <table className="table">
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}>
                <th scope="row">{k}</th>
                <td className="num">{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.txStatus}</h3>
        <div className="chip-row">
          {flags ? <AmberChip text={flags.explanation} /> : setAside ? <NeutralChip text={COPY.rowSetAside} /> : <NeutralChip text={COPY.txNoFlags} />}
        </div>
        {error ? (
          <p className="error-text" role="alert">
            {error}
          </p>
        ) : null}
        {match ? <p>{COPY.linkedTo(match.subject.id, ledger?.id ?? match.ledgerEntryId)}</p> : null}
        {statementOnly ? (
          <p>
            {statementOnly.evidence.receiptIds.length > 0
              ? COPY.statementEntryWithReceipt(statementOnly.id, statementOnly.evidence.receiptIds.join(', '))
              : COPY.statementEntry(statementOnly.id)}
          </p>
        ) : null}
        {match || related.length > 0 ? (
          <div className="button-row">
            {[...new Set([...(match ? [match.subject.id] : []), ...related.map((c) => c.receiptId)])].map((id) => (
              <button key={id} type="button" className="btn btn-secondary btn-small" onClick={() => (id.startsWith('INV-') ? store.openInvoice(id) : void store.openCase(id))}>
                {COPY.openCase(id)}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </Modal>
  );
}
