/**
 * "Exports" (design §9.3, §12.2): ledger CSV, exceptions CSV, knowledge JSON,
 * "Import knowledge JSON" (drafts only, always into My files, N9) and
 * "Download KNOWLEDGE.md". Every export passes the export gate first; missing
 * evidence needs a confirmation and is marked in the file.
 */
import { useId, useState } from 'react';
import { accountsOf } from '../../domain/imports/rows';
import { exportKnowledge, knowledgeMarkdown, planKnowledgeImport, type KnowledgeImportPlan } from '../../domain/knowledge/exportJson';
import { exceptionsCsv, exportFileName, ledgerCsv } from '../../domain/ledger/exportCsv';
import { LIMITS } from '../../domain/limits';
import { importKnowledge } from '../../persistence/commands';
import { asWorkspaceState } from '../../persistence/commands/context';
import { exportGate } from '../../persistence/exportGate';
import { COPY } from '../copy';
import { IconDownload, IconUpload } from '../icons';
import { store, useAppState } from '../store';
import { Modal } from './Modal';

type Kind = 'ledger' | 'exceptions' | 'knowledge' | 'knowledgeMd';

function download(text: string, fileName: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportsDialog() {
  const s = useAppState();
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' } | null>(null);
  const [confirm, setConfirm] = useState<{ kind: Kind; missing: Set<string> } | null>(null);

  const run = async (kind: Kind, acceptMissing = false) => {
    setMessage(null);
    const snap = store.snapshot();
    const gate = await exportGate(store.repo(), snap);
    if (!gate.ok) return setMessage({ text: gate.message, tone: 'error' });
    if (gate.missingEvidence.size > 0 && !acceptMissing && kind === 'ledger') return setConfirm({ kind, missing: gate.missingEvidence });
    setConfirm(null);
    const state = asWorkspaceState(snap);
    const now = new Date().toISOString();
    const ws = snap.workspaceId;
    try {
      if (kind === 'ledger') download(ledgerCsv(state, gate.missingEvidence), exportFileName('ledger', ws, now), 'text/csv');
      else if (kind === 'exceptions') download(exceptionsCsv(state, store.derived().view), exportFileName('exceptions', ws, now), 'text/csv');
      else if (kind === 'knowledge') download(`${JSON.stringify(exportKnowledge(state, ws, now), null, 2)}\n`, exportFileName('knowledge', ws, now, 'json'), 'application/json');
      else {
        const labels = new Map(accountsOf(snap.transactions).map((a) => [a.accountId, a.accountLabel]));
        download(knowledgeMarkdown(state, labels), 'KNOWLEDGE.md', 'text/markdown');
      }
      setMessage({ text: COPY.exportDone, tone: 'info' });
    } catch (e) {
      setMessage({ text: e instanceof Error ? e.message : COPY.notSaved('the export'), tone: 'error' });
    }
  };

  const button = (kind: Kind, label: string) => (
    <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void run(kind)}>
      <IconDownload />
      {label}
    </button>
  );

  return (
    <Modal title={COPY.exportsTitle} onClose={() => store.closeDialog()}>
      <p className="muted">{COPY.exportsNote}</p>
      <div className="button-stack">
        {button('ledger', COPY.exportLedger)}
        {button('exceptions', COPY.exportExceptions)}
        {button('knowledge', COPY.exportKnowledge)}
        {button('knowledgeMd', COPY.downloadKnowledgeMd)}
        <button type="button" className="btn btn-secondary" onClick={() => store.openDialog({ kind: 'importKnowledge' })}>
          <IconUpload />
          {COPY.importKnowledge}
        </button>
      </div>
      {confirm ? (
        <div className="confirm-box" role="group" aria-label={COPY.missingEvidenceTitle}>
          <p>{COPY.missingEvidence([...confirm.missing].sort().join(', '))}</p>
          <div className="button-row">
            <button type="button" className="btn btn-primary" onClick={() => void run(confirm.kind, true)}>
              {COPY.exportAnyway}
            </button>
            <button type="button" className="btn btn-tertiary" onClick={() => setConfirm(null)}>
              {COPY.cancel}
            </button>
          </div>
        </div>
      ) : null}
      {message ? (
        <p className={message.tone === 'error' ? 'error-text' : 'muted'} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      ) : null}
    </Modal>
  );
}

/** "Import knowledge JSON": validated as a whole, previewed, then created as drafts in My files only. */
export function ImportKnowledgeDialog() {
  const s = useAppState();
  const inputId = useId();
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [plan, setPlan] = useState<KnowledgeImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onFile = async (list: FileList | null) => {
    const f = list?.[0];
    setError(null);
    setPlan(null);
    if (!f) return;
    if (f.size > LIMITS.knowledgeJsonMaxBytes) return setError(COPY.knowledgeTooLarge);
    const text = await f.text();
    setFile({ name: f.name, text });
    setPlan(planKnowledgeImport(text, asWorkspaceState(store.snapshot('personal'))));
  };

  const create = async () => {
    if (!file) return;
    if (s.workspace !== 'personal') {
      store.switchWorkspace('personal');
      store.notify(COPY.switchedToPersonalKnowledge);
    }
    let created: string[] = [];
    const r = await store.run('the knowledge import', async (repo) => {
      created = (await importKnowledge(repo, file.name, file.text)).created;
    });
    if (!r.ok) return setError(r.message);
    store.closeDialog();
    store.notify(COPY.knowledgeImported(created.length));
  };

  return (
    <Modal
      title={COPY.importKnowledge}
      onClose={() => store.closeDialog()}
      wide
      footer={
        plan && plan.ok ? (
          <div className="drawer-actions">
            <button type="button" className="btn btn-primary" disabled={s.busy || plan.drafts.length === 0} onClick={() => void create()}>
              {COPY.createDrafts}
            </button>
            <button type="button" className="btn btn-tertiary" onClick={() => store.closeDialog()}>
              {COPY.cancel}
            </button>
          </div>
        ) : undefined
      }
    >
      <p>{COPY.importKnowledgeNote}</p>
      <label className="field" htmlFor={inputId}>
        <span className="field-label">{COPY.importKnowledgeFile}</span>
      </label>
      <input id={inputId} className="input" type="file" accept=".json,application/json" onChange={(e) => void onFile(e.target.files)} />
      {plan && !plan.ok ? (
        <div role="alert">
          <p className="error-text">{COPY.knowledgeRejected}</p>
          <ul className="plain-list">
            {plan.issues.map((i) => (
              <li key={i} className="error-text">
                {i}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {plan && plan.ok ? (
        <div data-testid="knowledge-plan">
          <h3 className="drawer-section-title">{COPY.knowledgePlanTitle(plan.drafts.length)}</h3>
          <ul className="plain-list">
            {plan.drafts.map((d) => (
              <li key={d.source}>
                <span className="mono">{d.source}</span>: {d.draft.plainEnglish}
                {d.findings.length > 0 ? (
                  <ul className="plain-list">
                    {d.findings.map((f, i) => (
                      <li key={i} className="muted">
                        {f.code}: {f.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
            {plan.skipped.map((k) => (
              <li key={k.source} className="muted">
                <span className="mono">{k.source}</span>: {k.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
