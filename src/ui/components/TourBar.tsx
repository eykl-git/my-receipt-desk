/**
 * Tour bar (design §9.1, §9.2, brief §24): step indicator, coach text from
 * state, one primary next action, plus "Next batch", "Compare without this
 * rule" (N8) and "Restart demo". Disabled controls show their reason as text.
 */
import { useId } from 'react';
import { coachSentence, coachText } from '../../demo/coach';
import { nextUnloadedBatch } from '../../demo/batches';
import { selectCompareTarget } from '../../demo/compare';
import { formatRuleRef } from '../../domain/primitives';
import { COPY } from '../copy';
import { IconRefresh } from '../icons';
import { store, useAppState, useDerived } from '../store';

export function TourBar() {
  const s = useAppState();
  const { view } = useDerived();
  const nextReasonId = useId();
  const compareReasonId = useId();
  const snap = store.snapshot('demo');
  if (s.workspace !== 'demo' || snap.demoState.loadedBatches.length === 0) return null;
  const step = snap.demoState.tourStep;
  const text = coachText(step, view, snap);
  const next = nextUnloadedBatch(snap.demoState.loadedBatches);
  const loading = s.demoLoad === 'loading';
  const r102 = view.caseById.get('R-102');
  const aliasActive = view.activeRules.some((r) => r.type === 'merchant_alias');
  const aliasSuspended = snap.ruleHeads.some((h) => h.type === 'merchant_alias' && h.status === 'suspended');
  const target = selectCompareTarget(snap.ruleHeads, snap.ruleVersions);

  const nextBatchButton = (primary: boolean) =>
    next ? (
      <button type="button" className={`btn ${primary ? 'btn-primary' : 'btn-secondary'}`} disabled={loading} aria-busy={loading} onClick={() => void store.nextBatch()}>
        {loading ? COPY.loadingDemo : COPY.nextBatch}
      </button>
    ) : (
      <span className="control-with-reason">
        <button type="button" className="btn btn-secondary" disabled aria-describedby={nextReasonId}>
          {COPY.nextBatch}
        </button>
        <span id={nextReasonId} className="disabled-reason">
          {COPY.allBatchesLoaded}
        </span>
      </span>
    );

  let primary;
  if (step === 1) {
    primary = (
      <>
        <button type="button" className="btn btn-primary" onClick={() => void store.continueTour()}>
          {COPY.continue}
        </button>
        {nextBatchButton(false)}
      </>
    );
  } else if (step === 2 && r102 && !aliasActive && !aliasSuspended) {
    primary = (
      <>
        <button type="button" className="btn btn-primary" onClick={() => void store.openCase('R-102')}>
          {COPY.openR102}
        </button>
        {nextBatchButton(false)}
      </>
    );
  } else if (next) {
    primary = nextBatchButton(true);
  } else {
    primary = nextBatchButton(false);
  }

  return (
    <section className="tour-bar" aria-label={COPY.tourLabel}>
      <div className="tour-hud-header">
        <div className="tour-hud-brand">
          <span className="tour-hud-badge">CAMPAIGN 21 · KNOWLEDGE HUD</span>
          <span className="tour-hud-thesis">
            “Correct once. Approve what should be remembered. Reuse safely next time.”
          </span>
        </div>
        <div className="tour-hud-stages" role="group" aria-label="Knowledge Flywheel stages">
          <div className={`tour-hud-stage${step === 1 ? ' is-active' : step > 1 ? ' is-done' : ''}`}>
            <span className="hud-stage-num">1</span>
            <span className="hud-stage-title">Encounter</span>
            <span className="hud-stage-sub">Gap found</span>
          </div>
          <span className="hud-stage-arrow" aria-hidden="true">→</span>
          <div className={`tour-hud-stage${step === 2 ? ' is-active' : step > 2 ? ' is-done' : ''}`}>
            <span className="hud-stage-num">2</span>
            <span className="hud-stage-title">Approve Law</span>
            <span className="hud-stage-sub">K-ALIAS-0001</span>
          </div>
          <span className="hud-stage-arrow" aria-hidden="true">→</span>
          <div className={`tour-hud-stage${step === 3 ? ' is-active' : step > 3 ? ' is-done' : ''}`}>
            <span className="hud-stage-num">3</span>
            <span className="hud-stage-title">Governed Reuse</span>
            <span className="hud-stage-sub">Auto-matched</span>
          </div>
          <span className="hud-stage-arrow" aria-hidden="true">→</span>
          <div className={`tour-hud-stage${step === 4 ? ' is-active' : ''}`}>
            <span className="hud-stage-num">4</span>
            <span className="hud-stage-title">Boundary Holds</span>
            <span className="hud-stage-sub">Refusal to guess</span>
          </div>
        </div>
      </div>
      <div className="tour-main">
        <div className="tour-step">
          <span className="tour-step-label" data-testid="tour-step">
            {COPY.stepOf(step)}
          </span>
          <span className="tour-dots" aria-hidden="true">
            {[1, 2, 3, 4].map((n) => (
              <span key={n} className={`tour-dot${n <= step ? ' tour-dot-done' : ''}${n === step ? ' tour-dot-current' : ''}`} />
            ))}
          </span>
        </div>
        <div className="tour-copy">
          <p className="tour-text" data-testid="coach-text">
            {coachSentence(text)}
          </p>
          {!next && view.groups.ready.length > 0 ? <p className="tour-hint">{COPY.tourNextRecord}</p> : null}
        </div>
        <div className="tour-actions">{primary}</div>
      </div>
      <div className="tour-secondary">
        {target ? (
          <button type="button" className="btn btn-tertiary btn-small" onClick={() => store.openDialog({ kind: 'compare', ruleRef: target })} aria-label={`${COPY.compareWithout} (${formatRuleRef(target)})`}>
            {COPY.compareWithout}
          </button>
        ) : (
          <span className="control-with-reason">
            <button type="button" className="btn btn-tertiary btn-small" disabled aria-describedby={compareReasonId}>
              {COPY.compareWithout}
            </button>
            <span id={compareReasonId} className="disabled-reason">
              {COPY.noRuleToCompare}
            </span>
          </span>
        )}
        <button type="button" className="btn btn-tertiary btn-small" disabled={loading} onClick={() => store.openDialog({ kind: 'restart' })}>
          <IconRefresh />
          {COPY.restartDemo}
        </button>
      </div>
    </section>
  );
}
