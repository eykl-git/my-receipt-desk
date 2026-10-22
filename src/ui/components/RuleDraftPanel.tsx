/** Rule draft panel (design §9.3, §7.2–7.5, M2): replaces the drawer body; summary shows here after activation. */
import { stateFingerprint, type CaseSummary } from '../../domain/knowledge/preview';
import { RuleDraftSchema } from '../../domain/knowledge/schema';
import { categoryText, GROUP_LABELS } from '../../domain/knowledge/summary';
import { VALIDATION_MESSAGES } from '../../domain/knowledge/validate';
import { accountsOf } from '../../domain/imports/rows';
import { coveredLabels } from '../../domain/knowledge/resolve';
import { asWorkspaceState } from '../../persistence/commands/context';
import { COPY } from '../copy';
import { knownMerchants } from '../draftForm';
import {
  activatePanel,
  currentPanel,
  currentPreview,
  discardPanel,
  keepEditing,
  leavePanel,
  panelContent,
  panelValidation,
  previewPanel,
  requestLeavePanel,
} from '../panelActions';
import { DraftFormFields } from './DraftFormFields';
import { store, useAppState } from '../store';
import type { PanelState } from '../state';
import { TableWrap } from './TableWrap';

function usePanel(): PanelState | null {
  useAppState();
  return currentPanel();
}

function activationBlock(p: PanelState): string[] {
  const preview = currentPreview(p);
  if (!p.persisted || !preview) return [VALIDATION_MESSAGES.previewFirst];
  const errors = panelValidation(p).errors.map((f) => f.message);
  if (errors.length > 0) return errors;
  const parsed = RuleDraftSchema.safeParse(panelContent(p));
  if (parsed.success && stateFingerprint(asWorkspaceState(store.snapshot()), parsed.data) !== preview.stateFingerprint) return [VALIDATION_MESSAGES.previewStale];
  return [];
}

function Summary({ s }: { s: NonNullable<PanelState['summary']> }) {
  return (
    <div className="summary" data-testid="activation-summary">
      <p className="ks-note">{COPY.activated(`${s.ruleId} v${s.version}`)}</p>
      <h3 className="drawer-section-title">{COPY.whatChanged}</h3>
      {s.changed.length === 0 ? (
        <p className="muted">{COPY.noPendingChange}</p>
      ) : (
        <ul className="plain-list">
          {s.changed.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}
      <h3 className="drawer-section-title">{COPY.whatDidNotChange}</h3>
      <ul className="plain-list">
        {s.notChanged.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </div>
  );
}

function CaseCell({ c }: { c: CaseSummary }) {
  return (
    <>
      <strong>{GROUP_LABELS[c.group]}</strong>
      <div className="muted">{c.explanation}</div>
    </>
  );
}

export function RuleDraftPanel() {
  const p = usePanel();
  const snap = store.snapshot();
  if (!p) return null;
  if (p.summary) return <Summary s={p.summary} />;
  if (p.confirmDiscard) return <p className="confirm-text">{COPY.discardPrompt}</p>;

  const content = panelContent(p) as Record<string, unknown> & { plainEnglish?: string; exclusions?: string[]; evidenceRefs?: Array<{ kind: string; ref: string }>; scope?: unknown };
  const validation = panelValidation(p);
  const preview = currentPreview(p);
  const accounts = accountsOf(snap.transactions);
  const merchants = knownMerchants(snap);
  const errors = p.schemaErrors ?? validation.errors;
  const accountLabel = accounts.find((a) => a.accountId === p.form.accountId)?.accountLabel;
  // Every card label in the workspace the alias would cover (brief §25 D: shown for the store-number type).
  const parsedAlias = RuleDraftSchema.safeParse(content);
  const covered =
    parsedAlias.success && parsedAlias.data.type === 'merchant_alias' && parsedAlias.data.condition.match === 'exact_ignoring_store_number'
      ? coveredLabels(parsedAlias.data, snap.transactions)
      : null;

  return (
    <div className="draft-panel" data-testid="draft-panel">
      {p.intro ? (
        <p className="draft-intro" data-testid="draft-intro">
          {p.intro}
        </p>
      ) : null}
      {p.persisted ? <p className="muted">{COPY.draftSavedNote(p.persisted.ruleId, p.persisted.version)}</p> : null}
      {p.error ? (
        <p className="error-text" role="alert">
          {p.error}
        </p>
      ) : null}

      <DraftFormFields p={p} accounts={accounts} merchants={merchants} />

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.meaning}</h3>
        <p>{content.plainEnglish}</p>
      </section>
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.ruleData}</h3>
        <pre className="json">{JSON.stringify({ type: content.type, scope: content.scope, condition: content.condition, action: content.action }, null, 2)}</pre>
      </section>
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.scope}</h3>
        <p>{p.form.type === 'merchant_alias' ? (accountLabel ? COPY.scopeCard(accountLabel) : COPY.chooseAccount) : COPY.scopeWorkspace}</p>
        {covered ? (
          <div data-testid="covered-labels">
            <p className="muted">{covered.length === 0 ? COPY.coversNoLabels : COPY.coversLabels}</p>
            {covered.length > 0 ? (
              <ul className="plain-list mono-list">
                {covered.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </section>
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.doesNotApply}</h3>
        <ul className="plain-list">
          {(content.exclusions ?? []).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      </section>
      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.evidence}</h3>
        {(content.evidenceRefs ?? []).length === 0 ? (
          <p className="muted">{COPY.noEvidence}</p>
        ) : (
          <ul className="plain-list mono-list">
            {(content.evidenceRefs ?? []).map((e) => {
              const t = e.kind === 'transaction' ? snap.transactions.find((x) => x.id === e.ref) : undefined;
              return <li key={`${e.kind}:${e.ref}`}>{`${e.kind}: ${t?.reference ?? e.ref}`}</li>;
            })}
          </ul>
        )}
      </section>
      <section className="drawer-section" data-testid="draft-checks">
        <h3 className="drawer-section-title">{COPY.checks}</h3>
        {errors.length === 0 && validation.warnings.length === 0 ? <p className="muted">{COPY.checksPass}</p> : null}
        <ul className="plain-list">
          {errors.map((f, i) => (
            <li key={`e${i}`} className="error-text">
              {f.code}: {f.message}
            </li>
          ))}
          {validation.warnings.map((f, i) => (
            <li key={`w${i}`} className="muted">
              {f.code}: {f.message}
            </li>
          ))}
        </ul>
      </section>
      <section className="drawer-section" data-testid="draft-pending">
        <h3 className="drawer-section-title">
          {COPY.pendingAffected} <span className="muted">· {COPY.impactActivate}</span>
        </h3>
        {!preview ? (
          <p className="muted">{COPY.pendingNotPreviewed}</p>
        ) : preview.pendingChanges.length === 0 ? (
          <p className="muted">{COPY.noPendingChange}</p>
        ) : (
          <TableWrap label={COPY.pendingAffected}>
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">{COPY.before}</th>
                  <th scope="col">{COPY.after}</th>
                </tr>
              </thead>
              <tbody>
                {preview.pendingChanges.map((c) => (
                  <tr key={c.caseId}>
                    <td className="mono">{c.caseId}</td>
                    <td>
                      <CaseCell c={c.before} />
                    </td>
                    <td>
                      <CaseCell c={c.after} />
                      {categoryText(c.before.category) !== categoryText(c.after.category) ? (
                        <div>{COPY.categoryLine(categoryText(c.before.category), categoryText(c.after.category))}</div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        )}
        {preview ? <p className="muted">{COPY.unchangedCount(preview.unchangedCount)}</p> : null}
        {preview && preview.recordedDifferences.length > 0 ? (
          <>
            <h4 className="list-heading">{COPY.recordedDifferences}</h4>
            <ul className="plain-list">
              {preview.recordedDifferences.map((d) => (
                <li key={d.ledgerEntryId}>
                  <span className="mono">{d.ledgerEntryId}</span>: {d.note}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
      <p className="muted">{COPY.owner}</p>
    </div>
  );
}

export function RuleDraftFooter() {
  const p = usePanel();
  if (!p) return null;
  if (p.summary) {
    return (
      <div className="drawer-actions">
        <button type="button" className="btn btn-primary" onClick={() => leavePanel('close')}>
          {COPY.close}
        </button>
      </div>
    );
  }
  if (p.confirmDiscard) {
    const mode = p.confirmDiscard;
    return (
      <div className="drawer-actions">
        <button type="button" className="btn btn-secondary" onClick={() => leavePanel(mode)}>
          {COPY.discard}
        </button>
        <button type="button" className="btn btn-primary" onClick={keepEditing}>
          {COPY.keepEditing}
        </button>
      </div>
    );
  }
  const block = activationBlock(p);
  return (
    <div className="drawer-actions">
      <button type="button" className="btn btn-secondary" disabled={p.busy} aria-busy={p.busy} onClick={() => void previewPanel()}>
        {COPY.previewImpact}
      </button>
      <div className="action-with-help">
        <button type="button" className="btn btn-primary" disabled={block.length > 0 || p.busy} onClick={() => void activatePanel()}>
          {COPY.activateRule}
        </button>
        {block.length > 0 ? (
          <span className="help" data-testid="activate-reason">
            {block.join(' ')}
          </span>
        ) : null}
      </div>
      <button type="button" className="btn btn-tertiary" disabled={p.busy} onClick={() => void discardPanel()}>
        {COPY.discardDraft}
      </button>
      {p.origin.kind === 'case' ? (
        <button type="button" className="btn btn-tertiary" onClick={() => requestLeavePanel('back')}>
          {COPY.back}
        </button>
      ) : null}
    </div>
  );
}
