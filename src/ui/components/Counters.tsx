/** Counters strip (S13, design §14): every value derived from state; drill-downs computed only when opened. */
import { useState, type ReactNode } from 'react';
import { deriveWorkspaceView } from '../../domain/views';
import { formatMoney } from '../../domain/money';
import { asWorkspaceState } from '../../persistence/commands/context';
import { COPY } from '../copy';
import { money } from '../format';
import { store, useAppState, useDerived } from '../store';

function Row({ label, value, testId }: { label: ReactNode; value: string | number; testId: string }) {
  return (
    <div className="stat-row" data-testid={testId}>
      <dt className="stat-label">{label}</dt>
      <dd className="stat-value">{value}</dd>
    </div>
  );
}

/** Leave-one-out per active rule: pending cases ready now but not without that rule. */
function NewlyReadyByRule() {
  const { view } = useDerived();
  const state = asWorkspaceState(store.snapshot());
  const rows = view.activeRules.map((rule) => {
    const without = deriveWorkspaceView(state, view.activeRules.filter((r) => r.ruleId !== rule.ruleId));
    const ids = view.groups.ready.filter((c) => without.caseById.get(c.receiptId)?.group !== 'ready').map((c) => c.receiptId);
    return { ref: `${rule.ruleId} v${rule.version}`, ids };
  });
  const shown = rows.filter((r) => r.ids.length > 0);
  if (shown.length === 0) return <p className="muted">{COPY.drillNone}</p>;
  return (
    <ul className="plain-list">
      {shown.map((r) => (
        <li key={r.ref}>{COPY.drillByRule(r.ref, r.ids.join(', '))}</li>
      ))}
    </ul>
  );
}

export function Counters() {
  useAppState();
  const { metrics: m } = useDerived();
  const [drill, setDrill] = useState<'newly' | 'rules' | null>(null);
  const drillButton = (kind: 'newly' | 'rules', label: string) => (
    <button type="button" className="link-button stat-link" aria-expanded={drill === kind} onClick={() => setDrill(drill === kind ? null : kind)}>
      {label}
    </button>
  );
  return (
    <section className="counters" aria-labelledby="counters-title">
      <div className="headline-outcome-banner" data-testid="headline-outcome">
        <span className="headline-outcome-dot" />
        <span className="headline-outcome-text">
          {m.uniqueReceipts === 0 ? (
            'Workspace empty · Load demo batch or add your files to begin'
          ) : (
            <>
              <strong>{m.receiptsWithConfirmedMatches + m.safeProposals.x} of {m.uniqueReceipts}</strong> receipts ready
              {m.needsDecision > 0 ? (
                <> · <strong className="text-amber">{m.needsDecision}</strong> need your decision</>
              ) : (
                ' · all clear'
              )}
              {m.activeRules > 0 ? (
                <> · <strong className="text-teal">{m.activeRules}</strong> rules compounding</>
              ) : null}
            </>
          )}
        </span>
      </div>
      <div className="counters-head">
        <h2 id="counters-title" className="section-label">
          {COPY.countersTitle}
        </h2>
        <details className="disclosure">
          <summary>{COPY.howCounted}</summary>
          <div className="disclosure-body">
            <p>{COPY.countsCoverWorkspace}</p>
            <p>{COPY.readyNote}</p>
            <ul className="plain-list">
              {COPY.counterDefinitions.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </div>
        </details>
      </div>
      <div className="stat-groups">
        <div className="stat-group" role="group" aria-label={COPY.counterGroups.receipts}>
          <h3 className="stat-group-title">{COPY.counterGroups.receipts}</h3>
          <dl className="stat-list">
          <Row label={COPY.counters.uniqueReceipts} value={m.uniqueReceipts} testId="m-unique" />
          <Row label={COPY.counters.needsDecision} value={m.needsDecision} testId="m-needs" />
          <Row label={COPY.counters.confirmedMatches} value={m.receiptsWithConfirmedMatches} testId="m-confirmed" />
          <Row label={COPY.counters.safeProposals} value={COPY.ofReceipts(m.safeProposals.x, m.safeProposals.y)} testId="m-safe" />
          </dl>
        </div>
        <div className="stat-group" role="group" aria-label={COPY.counterGroups.card}>
          <h3 className="stat-group-title">{COPY.counterGroups.card}</h3>
          <dl className="stat-list">
          <Row label={COPY.counters.linked} value={m.linkedTransactions} testId="m-linked" />
          <Row label={COPY.counters.cardRows} value={m.cardRowsNeedingAttention} testId="m-cardrows" />
          <Row label={COPY.counters.spendingWithoutRecord} value={money(m.cardSpendingWithoutRecordMinor, m.currency)} testId="m-spending" />
          </dl>
        </div>
        <div className="stat-group stat-group-knowledge" role="group" aria-label={COPY.counterGroups.knowledge}>
          <h3 className="stat-group-title">{COPY.counterGroups.knowledge}</h3>
          <dl className="stat-list">
          <Row label={COPY.counters.activeRules} value={m.activeRules} testId="m-active" />
          <Row label={drillButton('newly', COPY.counters.newlyReady)} value={m.newlyReady.length} testId="m-newly" />
          <Row label={drillButton('rules', COPY.counters.rulesUsed)} value={m.rulesUsedInRecorded.length} testId="m-rules-used" />
          </dl>
        </div>
        <div className="stat-group" role="group" aria-label={COPY.counterGroups.totals}>
          <h3 className="stat-group-title">{COPY.counterGroups.totals}</h3>
          <dl className="stat-list">
          <Row label={COPY.counters.recordedPaid} value={money(m.recordedPaidMinor, m.currency)} testId="m-paid" />
          <Row label={COPY.counters.unpaidInvoices} value={money(m.unpaidInvoicesMinor, m.currency)} testId="m-unpaid" />
          </dl>
          {m.notIncluded.length > 0 ? <p className="muted">{m.notIncluded.map((n) => COPY.notIncluded(formatMoney(n.totalMinor, n.currency))).join(' · ')}</p> : null}
        </div>
      </div>
      {drill === 'newly' ? (
        <div className="drill" aria-live="polite">
          <NewlyReadyByRule />
        </div>
      ) : null}
      {drill === 'rules' ? (
        <div className="drill" aria-live="polite">
          {m.rulesUsedInRecorded.length === 0 ? (
            <p className="muted">{COPY.drillNone}</p>
          ) : (
            <ul className="plain-list">
              {m.rulesUsedInRecorded.map((u) => (
                <li key={u.ruleId}>{COPY.drillByRule(u.ruleId, [...u.ledgerEntryIds, ...u.matchIds].join(', '))}</li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </section>
  );
}
