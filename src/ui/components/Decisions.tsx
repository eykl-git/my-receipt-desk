/** "Decisions and outcomes" column (design §9.3): Ready to record / Needs your decision / Recorded. */
import { useMemo, useState, type ReactNode } from 'react';
import type { CaseGroup, CaseView } from '../../domain/matching/caseView';
import { formatRuleRef } from '../../domain/primitives';
import { LIMITS } from '../../domain/limits';
import { recordProposal } from '../../persistence/commands';
import { COPY } from '../copy';
import { batchFilter } from '../filters';
import { receiptAmount, receiptMerchant, txAmount, txRef, txRefClass } from '../format';
import { store, useAppState, useDerived } from '../store';
import { AmberChip, GroupChip, NeutralChip, RuleChip } from './Chips';
import { IconPause } from '../icons';

function newlyReadyRef(caseId: string): string | null {
  const s = store.get();
  const snap = store.snapshot();
  for (const n of s.newlyReady) {
    if (n.workspace !== s.workspace || !n.caseIds.includes(caseId)) continue;
    const head = snap.ruleHeads.find((h) => h.ruleId === n.ruleId);
    if (head?.status === 'active' && head.activeVersion === n.version) return formatRuleRef(n);
  }
  return null;
}

function CaseCard({ c }: { c: CaseView }) {
  const s = useAppState();
  const snap = store.snapshot();
  const receipt = snap.receipts.find((r) => r.id === c.receiptId)!;
  const [error, setError] = useState<string | null>(null);
  const match = c.matchId ? snap.matches.find((m) => m.id === c.matchId) : undefined;
  const refs = c.group === 'recorded' ? (match?.proposalSnapshot.ruleRefs ?? []) : (c.proposal?.ruleRefs ?? []);
  const fresh = c.group === 'ready' ? newlyReadyRef(c.receiptId) : null;
  const pulse = s.pulseCases.includes(c.receiptId);

  const record = async () => {
    const p = c.proposal;
    if (!p) return;
    const r = await store.run(`recording ${c.receiptId}`, (repo) => recordProposal(repo, p));
    if (r.ok) store.announce(COPY.recordedAs(store.derived().view.caseById.get(c.receiptId)?.ledgerEntryId ?? c.receiptId));
    else setError(r.message);
  };

  return (
    <li className={`case-card${pulse ? ' is-pulse' : ''}`} data-testid={`case-${c.receiptId}`}>
      <div className="case-head">
        <span className="case-title">
          <span className="mono">{c.receiptId}</span> {receiptMerchant(receipt)}
        </span>
        <span className="num amount">{receiptAmount(receipt)}</span>
      </div>
      <p className="case-explanation">{c.explanation}</p>
      <div className="chip-row">
        <GroupChip group={c.group!} />
        {fresh ? (
          <span className="chip chip-teal-solid" data-testid="newly-ready">
            {COPY.newlyReadyBadge(fresh)}
          </span>
        ) : null}
        {refs.map((r) => (
          <RuleChip key={formatRuleRef(r)} text={formatRuleRef(r)} />
        ))}
        {c.group === 'recorded' ? suspendedRefs(refs).map((r) => <NeutralChip key={`s-${r}`} text={COPY.recordedUsingSuspended(r)} />) : null}
        {c.group !== 'recorded' && c.voidedEntryIds.length > 0 ? <NeutralChip text={COPY.previousVoided(c.voidedEntryIds.join(', '))} /> : null}
      </div>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="case-actions">
        <button type="button" className="btn btn-secondary btn-small" onClick={() => void store.openCase(c.receiptId)} aria-label={`${COPY.review} ${c.receiptId}`}>
          {COPY.review}
        </button>
        {c.group === 'ready' ? (
          <button type="button" className="btn btn-secondary btn-small" disabled={s.busy || s.recording} onClick={() => void record()} aria-label={`${COPY.record} ${c.receiptId}`}>
            {COPY.record}
          </button>
        ) : null}
        {c.group === 'ready' && s.recording ? <span className="disabled-reason">{COPY.recordingInProgress}</span> : null}
      </div>
    </li>
  );
}

/**
 * "Record all ready" (§6.3, §9.3): records every ready case in the workspace
 * (not just the ones the batch filter shows), at most 50 per run, each checked
 * again in its own write.
 */
function RecordAllReady() {
  const s = useAppState();
  const { view } = useDerived();
  const n = view.groups.ready.length;
  return (
    <>
      <div className="action-with-help record-all">
        <button type="button" className="btn btn-primary btn-small" disabled={s.busy || s.recording} aria-busy={s.recording} aria-describedby="record-all-help" onClick={() => void store.recordAllReady()}>
          {COPY.recordAllReady}
        </button>
        <span id="record-all-help" className="help">
          {s.recording ? COPY.recordingInProgress : COPY.recordAllHelp(n, LIMITS.recordAllReadyMaxCases)}
        </span>
      </div>
      {s.recording ? <PauseProcessing /> : null}
    </>
  );
}

/** "Pause processing" (§9.3, §11.4): shown only while "Record all ready" runs. */
function PauseProcessing() {
  const s = useAppState();
  return (
    <div className="pause-row" data-testid="pause-row">
      <button type="button" className="btn btn-secondary btn-small" disabled={s.pausing} aria-describedby="pause-help" onClick={() => store.pauseRun()}>
        <IconPause />
        {COPY.pauseProcessing}
      </button>
      <span id="pause-help" className="help">
        {s.pausing ? COPY.pausing : COPY.pauseNote}
      </span>
    </div>
  );
}

/** Rule refs of a recorded case whose rule is now suspended (§7.6). */
function suspendedRefs(refs: readonly { ruleId: string; version: number }[]): string[] {
  const heads = store.snapshot().ruleHeads;
  return refs.filter((r) => heads.find((h) => h.ruleId === r.ruleId)?.status === 'suspended').map(formatRuleRef);
}

function Group({ group, cases, extra }: { group: CaseGroup; cases: CaseView[]; extra?: ReactNode }) {
  return (
    <section className={`group group-${group}`} aria-labelledby={`group-${group}`} data-testid={`group-${group}`}>
      <h3 id={`group-${group}`} className="group-title">
        <GroupChip group={group} />
        <span className="group-count num">{cases.length}</span>
      </h3>
      {group === 'ready' ? <p className="muted">{COPY.readyGroupNote}</p> : null}
      {group === 'ready' && cases.length > 0 ? <RecordAllReady /> : null}
      {cases.length === 0 ? <p className="muted">{COPY.groupEmpty[group]}</p> : <ul className="case-list">{cases.map((c) => <CaseCard key={c.receiptId} c={c} />)}</ul>}
      {extra}
    </section>
  );
}

export function Decisions() {
  const s = useAppState();
  const { view } = useDerived();
  const snap = store.snapshot();
  const filter = useMemo(() => batchFilter(s.batchFilter, snap), [s.batchFilter, snap]);
  const keep = (c: CaseView) => filter.receipt(snap.receipts.find((r) => r.id === c.receiptId)!, c);
  const txCases = view.transactionCases.filter((t) => {
    const tx = snap.transactions.find((x) => x.id === t.transactionId);
    return tx ? filter.transaction(tx) : false;
  });
  const [showAllTx, setShowAllTx] = useState(false);
  const txShown = showAllTx || txCases.length <= 5 ? txCases : txCases.slice(0, 5);

  const txSection =
    txCases.length > 0 ? (
      <div className="tx-check">
        <h4 className="list-heading">{COPY.cardTxToCheck}</h4>
        <ul className="item-list">
          {txShown.map((t) => {
            const tx = snap.transactions.find((x) => x.id === t.transactionId)!;
            return (
              <li key={t.transactionId}>
                <button type="button" className="item-row" onClick={() => void store.openTransaction(tx.id)}>
                  <span className={txRefClass(tx)}>{txRef(tx)}</span>
                  <span className="item-label">{tx.rawLabel}</span>
                  <span className="num amount">{txAmount(tx)}</span>
                  <span className="item-flag">
                    <AmberChip text={t.explanation} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
        {txCases.length > 5 && !showAllTx ? (
          <button type="button" className="btn btn-tertiary btn-small" onClick={() => setShowAllTx(true)}>
            {COPY.showMore(txCases.length - 5)}
          </button>
        ) : null}
      </div>
    ) : null;

  const setAside = view.groups.setAside.filter(keep);
  const setAsideRows = snap.transactions.filter((t) => t.intake === 'set_aside_duplicate' && filter.transaction(t));
  return (
    <section className="column column-decisions" aria-labelledby="col-decisions">
      <div className="column-head">
        <h2 id="col-decisions" className="column-title">
          {COPY.decisions}
        </h2>
      </div>
      <Group group="ready" cases={view.groups.ready.filter(keep)} />
      <Group group="needs_decision" cases={view.groups.needs_decision.filter(keep)} extra={txSection} />
      <Group group="recorded" cases={view.groups.recorded.filter(keep)} />
      {setAside.length > 0 || setAsideRows.length > 0 ? (
        <details className="disclosure" data-testid="set-aside">
          <summary>{COPY.setAsideFootnote}</summary>
          <ul className="item-list">
            {setAside.map((c) => {
              const r = snap.receipts.find((x) => x.id === c.receiptId)!;
              return (
                <li key={c.receiptId}>
                  <button type="button" className="item-row" onClick={() => void store.openCase(c.receiptId)}>
                    <span className="mono">{c.receiptId}</span>
                    <span className="item-label">{receiptMerchant(r)}</span>
                    <span className="num amount">{receiptAmount(r)}</span>
                  </button>
                </li>
              );
            })}
            {setAsideRows.map((t) => (
              <li key={t.id}>
                <button type="button" className="item-row" onClick={() => void store.openTransaction(t.id)}>
                  <span className={txRefClass(t)}>{txRef(t)}</span>
                  <span className="item-label">{t.rawLabel}</span>
                  <span className="num amount">{txAmount(t)}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}
