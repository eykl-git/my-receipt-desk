/** Header and rule-card dialogs (design §9.3, §7.4, §7.6, §11.6). Each one closes with Close, Escape or Cancel. */
import { useId, useMemo, useState } from 'react';
import { previewImpact, type ImpactPreview } from '../../domain/knowledge/preview';
import { recheckRecorded, type StaleRuleRef } from '../../domain/knowledge/recheck';
import { missingEvidence } from '../../domain/ledger/evidence';
import { GROUP_LABELS, categoryText } from '../../domain/knowledge/summary';
import { formatRuleRef } from '../../domain/primitives';
import { LIMITS } from '../../domain/limits';
import { asWorkspaceState } from '../../persistence/commands/context';
import { discardDraft, reactivateRule, recheckKeep, recheckVoid, suspendRule, unlinkReceipt, voidEntry } from '../../persistence/commands';
import { COPY } from '../copy';
import { formatAt } from '../format';
import { store, useAppState } from '../store';
import { Modal } from './Modal';
import { TableWrap } from './TableWrap';

function PreviewTable({ preview }: { preview: ImpactPreview }) {
  return (
    <>
      {preview.pendingChanges.length === 0 ? (
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
                    <strong>{GROUP_LABELS[c.before.group]}</strong>
                    <div className="muted">{c.before.explanation}</div>
                  </td>
                  <td>
                    <strong>{GROUP_LABELS[c.after.group]}</strong>
                    <div className="muted">{c.after.explanation}</div>
                    {categoryText(c.before.category) !== categoryText(c.after.category) ? <div>{COPY.categoryLine(categoryText(c.before.category), categoryText(c.after.category))}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {preview.recordedDifferences.length > 0 ? (
        <>
          <h3 className="list-heading">{COPY.recordedDifferences}</h3>
          <ul className="plain-list">
            {preview.recordedDifferences.map((d) => (
              <li key={d.ledgerEntryId}>
                <span className="mono">{d.ledgerEntryId}</span>: {d.note}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function ruleState(ruleId: string) {
  const snap = store.snapshot();
  const head = snap.ruleHeads.find((h) => h.ruleId === ruleId);
  const version = head?.lastApprovedVersion ? snap.ruleVersions.find((v) => v.ruleId === ruleId && v.version === head.lastApprovedVersion) : undefined;
  return { snap, head, version };
}

/** "Preview impact" on an active (suspension) or suspended (reactivation) card (§7.4). Read-only. */
export function PreviewDialog({ ruleId }: { ruleId: string }) {
  useAppState();
  const { snap, head, version } = ruleState(ruleId);
  const preview = useMemo(() => {
    if (!head || !version) return null;
    const state = asWorkspaceState(snap);
    return head.status === 'active' ? previewImpact(state, { kind: 'suspend', ruleId }) : previewImpact(state, { kind: 'reactivate', ruleId, version });
  }, [snap, head, version, ruleId]);
  if (!head || !preview) return null;
  return (
    <Modal title={head.status === 'active' ? COPY.impactSuspend : COPY.impactReactivate} onClose={() => store.closeDialog()} wide>
      <p className="muted">{COPY.previewDialogNote}</p>
      <PreviewTable preview={preview} />
    </Modal>
  );
}

export function SuspendDialog({ ruleId }: { ruleId: string }) {
  const s = useAppState();
  const { snap, head } = ruleState(ruleId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!head || head.activeVersion === null) return null;
  const preview = previewImpact(asWorkspaceState(snap), { kind: 'suspend', ruleId });
  const ref = formatRuleRef({ ruleId, version: head.activeVersion });
  const valid = reason.trim().length >= LIMITS.reasonMinChars && reason.trim().length <= LIMITS.reasonMaxChars;
  const submit = async () => {
    const r = await store.run(`suspending ${ruleId}`, (repo) => suspendRule(repo, ruleId, reason));
    if (r.ok) {
      store.closeDialog();
      store.notify(`${ref} ${COPY.stateSuspended.toLowerCase()}. ${COPY.suspendNote}`);
    } else setError(r.message);
  };
  return (
    <Modal
      title={COPY.suspendTitle(ref)}
      onClose={() => store.closeDialog()}
      wide
      footer={
        <div className="drawer-actions">
          <button type="button" className="btn btn-primary" disabled={!valid || s.busy} onClick={() => void submit()}>
            {COPY.suspendRule}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.closeDialog()}>
            {COPY.cancel}
          </button>
        </div>
      }
    >
      <p>{COPY.suspendNote}</p>
      <h3 className="drawer-section-title">{COPY.impactSuspend}</h3>
      <PreviewTable preview={preview} />
      <label className="field">
        <span className="field-label">{COPY.suspendReason}</span>
        <textarea className="input" rows={2} maxLength={LIMITS.reasonMaxChars} value={reason} onChange={(e) => setReason(e.target.value)} aria-describedby="suspend-help" />
        <span id="suspend-help" className="muted">{`${LIMITS.reasonMinChars}–${LIMITS.reasonMaxChars}`}</span>
      </label>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function HistoryDialog({ ruleId }: { ruleId: string }) {
  const s = useAppState();
  const { snap, head, version } = ruleState(ruleId);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = useMemo(
    () => (confirming && head?.status === 'suspended' && version ? previewImpact(asWorkspaceState(snap), { kind: 'reactivate', ruleId, version }) : null),
    [confirming, head, version, snap, ruleId],
  );
  if (!head) return null;
  const all = snap.ruleVersions.filter((v) => v.ruleId === ruleId).sort((a, b) => a.version - b.version);
  const versions = all.filter((v) => !v.discardedAt);
  const discarded = all.filter((v) => v.discardedAt);
  const approved = versions.filter((v) => v.approvedAt);
  const supersededBy = (version: number) => approved.find((x) => x.version > version)?.version ?? null;
  const suspensions = snap.audit.filter((e) => e.action === 'rule.suspended' && e.affected.some((a) => a.id === ruleId));
  const reactivate = async () => {
    if (!preview) return;
    const r = await store.run(`reactivating ${ruleId}`, (repo) => reactivateRule(repo, ruleId, preview.stateFingerprint));
    if (r.ok) {
      setConfirming(false);
      store.notify(`${formatRuleRef({ ruleId, version: head.lastApprovedVersion! })} ${COPY.stateActive.toLowerCase()}.`);
    } else setError(r.message);
  };
  return (
    <Modal title={COPY.historyTitle(ruleId)} onClose={() => store.closeDialog()} wide>
      <TableWrap label={COPY.historyTitle(ruleId)}>
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{COPY.versionCol}</th>
              <th scope="col">{COPY.txStatus}</th>
              <th scope="col">{COPY.meaning}</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const later = v.approvedAt ? supersededBy(v.version) : null;
              return (
                <tr key={v.version}>
                  <td className="mono">v{v.version}</td>
                  <td>
                    {head.activeVersion === v.version
                      ? COPY.versionActive
                      : later !== null
                        ? COPY.supersededBy(later)
                        : v.approvedAt
                          ? head.status === 'suspended' && head.lastApprovedVersion === v.version
                            ? COPY.stateSuspended
                            : COPY.versionApproved
                          : COPY.versionDraft}
                    <div className="muted num">{v.approvedAt ? COPY.approvedAt(formatAt(v.approvedAt)) : COPY.notApproved}</div>
                  </td>
                  <td>{v.plainEnglish}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableWrap>
      {discarded.length > 0 ? (
        <>
          <h3 className="list-heading">{COPY.discardedDrafts}</h3>
          <ul className="plain-list" data-testid="discarded-drafts">
            {discarded.map((v) => (
              <li key={v.version}>
                <span className="mono">v{v.version}</span> {COPY.versionDiscarded} ({formatAt(v.discardedAt!)}): {v.plainEnglish}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {head.lastApprovedVersion !== null ? (
        <div className="button-row">
          <button type="button" className="btn btn-secondary" onClick={() => store.openDialog({ kind: 'recheck', ruleId })}>
            {COPY.recheck}
          </button>
        </div>
      ) : null}
      {suspensions.length > 0 ? (
        <ul className="plain-list">
          {suspensions.map((e) => (
            <li key={e.id}>{COPY.suspendedOn(formatAt(e.at), e.reason ?? '')}</li>
          ))}
        </ul>
      ) : null}
      {head.status === 'suspended' ? (
        <div className="drawer-section">
          {!confirming ? (
            <button type="button" className="btn btn-secondary" onClick={() => setConfirming(true)}>
              {COPY.reactivate}
            </button>
          ) : preview ? (
            <>
              <h3 className="drawer-section-title">{COPY.impactReactivate}</h3>
              <PreviewTable preview={preview} />
              <div className="button-row">
                <button type="button" className="btn btn-primary" disabled={s.busy} onClick={() => void reactivate()}>
                  {COPY.reactivateRule}
                </button>
                <button type="button" className="btn btn-tertiary" onClick={() => setConfirming(false)}>
                  {COPY.cancel}
                </button>
              </div>
            </>
          ) : null}
          {error ? (
            <p className="error-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}

function staleText(s: StaleRuleRef): string {
  const ref = formatRuleRef(s.ref);
  if (s.state === 'suspended') return COPY.recheckStale.suspended(ref);
  if (s.state === 'superseded' && s.activeVersion !== null) return COPY.recheckStale.superseded(ref, s.activeVersion);
  return COPY.recheckStale.inactive(ref);
}

/**
 * "Re-check recorded entries" (§7.7): read-only list; each entry is kept or
 * voided only by its own button. Closing returns to the rule's history.
 */
export function RecheckDialog({ ruleId }: { ruleId: string }) {
  const s = useAppState();
  const snap = store.snapshot();
  const items = useMemo(() => recheckRecorded(asWorkspaceState(snap)), [snap]);
  const [error, setError] = useState<string | null>(null);
  const keep = async (ledgerEntryId: string) => {
    setError(null);
    const r = await store.run(`keeping ${ledgerEntryId}`, (repo) => recheckKeep(repo, ledgerEntryId));
    if (r.ok) store.announce(COPY.recheckKeptDone(ledgerEntryId));
    else setError(r.message);
  };
  return (
    <Modal title={COPY.recheckTitle} onClose={() => store.openDialog({ kind: 'history', ruleId })} wide testId="recheck-dialog">
      <p className="muted">{COPY.recheckIntro}</p>
      {items.length === 0 ? (
        <p className="empty-state">{COPY.recheckNone}</p>
      ) : (
        <ul className="recheck-list">
          {items.map((i) => (
            <li key={`${i.ledgerEntryId}|${i.receiptId}`} className="recheck-item" data-testid={`recheck-${i.ledgerEntryId}`}>
              <p className="mono">{COPY.recheckEntry(i.ledgerEntryId, i.receiptId)}</p>
              <ul className="plain-list">
                {i.staleRefs.map((x) => (
                  <li key={formatRuleRef(x.ref)}>{staleText(x)}</li>
                ))}
                {i.now.explanation ? <li>{COPY.recheckNow(i.now.explanation)}</li> : null}
              </ul>
              <div className="button-row">
                <button type="button" className="btn btn-secondary btn-small" disabled={s.busy} onClick={() => void keep(i.ledgerEntryId)}>
                  {COPY.keepAsRecorded}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-small"
                  disabled={s.busy}
                  onClick={() => store.openDialog({ kind: 'void', ledgerEntryId: i.ledgerEntryId, mode: 'recheck', receiptId: i.receiptId, ruleId })}
                >
                  {COPY.voidAndReturn}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/**
 * Confirm dialog for "Void entry", "Unlink this receipt" and the re-check's
 * "Void and return to review" (§6.8, §7.7). A reason of 3–500 characters is
 * required. It opens over the drawer and returns focus to the button that
 * opened it.
 */
export function VoidDialog({ ledgerEntryId, mode, receiptId, ruleId }: { ledgerEntryId: string; mode: 'void' | 'unlink' | 'recheck'; receiptId: string | null; ruleId?: string }) {
  const s = useAppState();
  const reasonId = useId();
  const helpId = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const entry = store.snapshot().ledger.find((e) => e.id === ledgerEntryId);
  if (!entry) return null;
  const unlink = mode === 'unlink' && receiptId !== null;
  const valid = reason.trim().length >= LIMITS.reasonMinChars && reason.trim().length <= LIMITS.reasonMaxChars;
  const close = () => (mode === 'recheck' && ruleId ? store.openDialog({ kind: 'recheck', ruleId }) : store.closeDialog());
  const submit = async () => {
    setError(null);
    const r = await store.run(unlink ? `unlinking ${receiptId}` : `voiding ${ledgerEntryId}`, (repo) =>
      unlink ? unlinkReceipt(repo, ledgerEntryId, receiptId, reason) : mode === 'recheck' ? recheckVoid(repo, ledgerEntryId, reason) : voidEntry(repo, ledgerEntryId, reason),
    );
    if (!r.ok) {
      setError(r.message);
      return;
    }
    store.announce(unlink ? COPY.unlinkDone(receiptId, ledgerEntryId) : COPY.voidDone(ledgerEntryId));
    close();
  };
  const text = unlink
    ? COPY.unlinkConfirm(receiptId, ledgerEntryId)
    : entry.evidence.receiptIds.length === 0 && entry.evidence.payableIds.length === 0
      ? COPY.voidConfirmStatement(ledgerEntryId)
      : COPY.voidConfirm(ledgerEntryId);
  return (
    <Modal
      title={unlink ? COPY.unlinkTitle(receiptId) : COPY.voidTitle(ledgerEntryId)}
      onClose={close}
      testId="void-dialog"
      footer={
        <div className="drawer-actions">
          <button type="button" className="btn btn-danger" disabled={!valid || s.busy} onClick={() => void submit()}>
            {unlink ? COPY.unlinkReceipt : mode === 'recheck' ? COPY.voidAndReturn : COPY.voidEntry}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={close}>
            {COPY.cancel}
          </button>
        </div>
      }
    >
      <p>{text}</p>
      <label className="field" htmlFor={reasonId}>
        <span className="field-label">{unlink ? COPY.unlinkReason : COPY.voidReason}</span>
      </label>
      <textarea
        id={reasonId}
        className="input"
        rows={2}
        maxLength={LIMITS.reasonMaxChars}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        aria-describedby={helpId}
      />
      <span id={helpId} className="muted">
        {COPY.reasonHelp}
      </span>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

/** "Storage problems" panel (§11.5): invalid stored records and broken evidence. Nothing is repaired automatically. */
export function StorageProblemsDialog() {
  const s = useAppState();
  const snap = store.snapshot();
  const problems = store.storageProblems();
  const broken = missingEvidence(snap.ledger, snap);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={COPY.storageProblems} onClose={() => store.closeDialog()} wide testId="storage-problems">
      <p className="muted">{COPY.storageProblemsNote}</p>
      {problems.length > 0 ? (
        <ul className="plain-list">
          {problems.map((p) => (
            <li key={`${p.store}|${p.id}`}>
              <span className="mono">{COPY.storageProblemRow(p.store, p.id, p.error)}</span>{' '}
              <button
                type="button"
                className="btn btn-secondary btn-small"
                disabled={s.busy}
                onClick={() =>
                  void store.deleteProblem(p).then((r) => {
                    if (!r.ok) setError(r.message);
                  })
                }
              >
                {COPY.deleteThisRecord}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {broken.size > 0 ? (
        <ul className="plain-list">
          {[...broken.entries()].map(([id, missing]) => (
            <li key={id}>
              <span className="mono">{id}</span>: {COPY.evidenceMissing(missing.join(', '))}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function BaselineHistoryDialog() {
  return (
    <Modal title={COPY.policyCard(3)} onClose={() => store.closeDialog()}>
      <p>{COPY.baselineHistory}</p>
    </Modal>
  );
}

export function DiscardDialog({ ruleId }: { ruleId: string }) {
  const s = useAppState();
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const r = await store.run(`discarding the draft of ${ruleId}`, (repo) => discardDraft(repo, ruleId));
    if (r.ok) store.closeDialog();
    else setError(r.message);
  };
  return (
    <Modal
      title={COPY.discardDraftTitle(ruleId)}
      onClose={() => store.closeDialog()}
      footer={
        <div className="drawer-actions">
          <button type="button" className="btn btn-primary" disabled={s.busy} onClick={() => void submit()}>
            {COPY.discardDraft}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.closeDialog()}>
            {COPY.cancel}
          </button>
        </div>
      }
    >
      <p>{COPY.discardDraftNote}</p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}

export function AuditDialog() {
  useAppState();
  const snap = store.snapshot();
  const events = [...snap.audit].reverse();
  return (
    <Modal title={COPY.auditTitle} onClose={() => store.closeDialog()} wide>
      <p className="muted">
        {COPY.auditNote} {COPY.auditDeletedNote}
      </p>
      {events.length === 0 ? (
        <p className="empty-state">{COPY.auditEmpty}</p>
      ) : (
        <TableWrap label={COPY.auditTitle} scroll>
          <table className="table" data-testid="audit-table">
            <thead>
              <tr>
                {COPY.auditCols.map((c) => (
                  <th key={c} scope="col">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="num">{e.seq}</td>
                  <td className="num">{formatAt(e.at)}</td>
                  <td className="mono">{e.action}</td>
                  <td className="mono">{e.affected.map((a) => a.id).join(', ')}</td>
                  <td className="mono">{e.ruleRefs.map(formatRuleRef).join(', ')}</td>
                  <td>{e.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
    </Modal>
  );
}

function DeleteButtons() {
  const [confirm, setConfirm] = useState<'demo' | 'personal' | 'all' | null>(null);
  if (confirm) {
    return (
      <div className="confirm-box" role="group" aria-label={COPY.resetConfirm[confirm]}>
        <p>{COPY.resetConfirm[confirm]}</p>
        <div className="button-row">
          <button type="button" className="btn btn-danger" onClick={() => void store.reset(confirm)}>
            {COPY.confirmDelete}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => setConfirm(null)}>
            {COPY.cancel}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="button-stack">
      <button type="button" className="btn btn-secondary" onClick={() => setConfirm('demo')}>
        {COPY.resetDemo}
      </button>
      <button type="button" className="btn btn-secondary" onClick={() => setConfirm('personal')}>
        {COPY.deletePersonal}
      </button>
      <button type="button" className="btn btn-secondary" onClick={() => setConfirm('all')}>
        {COPY.deleteAll}
      </button>
    </div>
  );
}

export function PrivacyDialog() {
  const repoKind = store.repo().kind;
  return (
    <Modal title={COPY.privacyTitle} onClose={() => store.closeDialog()}>
      <p data-testid="privacy-text">{repoKind === 'indexeddb' ? COPY.privacyIdb : COPY.privacyMemory}</p>
      <p>{COPY.privacyNoTelemetry}</p>
      <p>{COPY.privacyOcr}</p>
      <DeleteButtons />
    </Modal>
  );
}

export function ResetDialog() {
  return (
    <Modal title={COPY.resetTitle} onClose={() => store.closeDialog()}>
      <DeleteButtons />
    </Modal>
  );
}
