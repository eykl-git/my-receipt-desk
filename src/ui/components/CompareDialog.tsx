/**
 * "Compare without this rule" (design §9.2, N8). Replays the immutable fixture
 * snapshot of the loaded batches through the same engine with and without the
 * selected rule. Read-only: it never receives a repository and writes nothing.
 */
import { useEffect, useMemo, useState } from 'react';
import { compareReplay, type FixtureSnapshot, type ReplayCell } from '../../demo/compare';
import { GROUP_LABELS } from '../../domain/knowledge/summary';
import { formatRuleRef, type RuleRef } from '../../domain/primitives';
import { COPY } from '../copy';
import { store, useAppState, useDerived } from '../store';
import { Modal } from './Modal';
import { TableWrap } from './TableWrap';

function Cell({ cell, duplicate }: { cell: ReplayCell | null; duplicate: boolean }) {
  if (duplicate || !cell) return <td className="muted">{COPY.compareDuplicate}</td>;
  return (
    <td>
      <strong className={cell.group === 'ready' ? 'text-knowledge' : undefined}>{GROUP_LABELS[cell.group]}</strong>
      <div className="muted">{cell.explanation}</div>
    </td>
  );
}

export function CompareDialog({ ruleRef }: { ruleRef: RuleRef }) {
  useAppState();
  const { view } = useDerived();
  const [fixture, setFixture] = useState<FixtureSnapshot | 'error' | null>(null);
  useEffect(() => {
    let live = true;
    store.fixtureSnapshot().then(
      (f) => live && setFixture(f),
      (e: unknown) => {
        console.warn('Comparison replay could not be prepared', e);
        if (live) setFixture('error');
      },
    );
    return () => {
      live = false;
    };
  }, []);
  const result = useMemo(() => (fixture && fixture !== 'error' ? compareReplay(fixture, view.activeRules, ruleRef) : null), [fixture, view.activeRules, ruleRef]);
  const ref = formatRuleRef(ruleRef);

  return (
    <Modal title={COPY.compareTitle} onClose={() => store.closeDialog()} wide testId="compare-dialog">
      <p>{COPY.compareSub(ref)}</p>
      {fixture === null ? (
        <p className="muted" aria-busy="true">
          {COPY.compareLoading}
        </p>
      ) : fixture === 'error' || !result ? (
        <p className="error-text" role="alert">
          {COPY.demoAssetsFailed}
        </p>
      ) : (
        <>
          <ul className="plain-list compare-counts" data-testid="compare-counts">
            <li>{COPY.compareCount(COPY.compareColWith(ref), result.counts.readyWith, result.counts.total)}</li>
            <li>{COPY.compareCount(COPY.compareColWithout(ref), result.counts.readyWithout, result.counts.total)}</li>
          </ul>
          <p className="muted">{COPY.compareNote}</p>
          <TableWrap label={COPY.compareTitle}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">{COPY.compareColCase}</th>
                  <th scope="col">{COPY.compareColWith(ref)}</th>
                  <th scope="col">{COPY.compareColWithout(ref)}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.caseId} data-testid={`compare-${r.caseId}`}>
                    <th scope="row" className="mono">
                      {r.caseId}
                    </th>
                    <Cell cell={r.withRule} duplicate={r.duplicateOf !== null} />
                    <Cell cell={r.withoutRule} duplicate={r.duplicateOf !== null} />
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
    </Modal>
  );
}
