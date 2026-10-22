/** Header (design §9.3): title, workspace switch, view toggle, batch filter, audit, privacy, reset. */
import { DEMO_BATCHES } from '../../demo/batches';
import { COPY } from '../copy';
import { IconClock, IconDownload, IconShield, IconTrash } from '../icons';
import { store, useAppState } from '../store';

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className="segmented-option" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Header() {
  const s = useAppState();
  const snap = store.snapshot();
  const batchOptions =
    s.workspace === 'demo'
      ? [{ value: 'all', label: COPY.allBatches }, ...DEMO_BATCHES.filter((b) => snap.demoState.loadedBatches.includes(b.n)).map((b) => ({ value: `batch:${b.n}`, label: b.title }))]
      : [
          { value: 'all', label: COPY.allImports },
          ...snap.sourceDocuments.filter((d) => d.sourceType === 'statement_csv').map((d) => ({ value: `doc:${d.id}`, label: d.fileName.slice(0, 60) })),
        ];
  return (
    <header className="app-header">
      <div className="app-header-row">
        <h1 className="app-title">{COPY.appTitle}</h1>
        <Segmented
          label={COPY.workspaceLabel}
          value={s.workspace}
          options={[
            { value: 'demo', label: COPY.workspaceDemo },
            { value: 'personal', label: COPY.workspacePersonal },
          ]}
          onChange={(ws) => store.switchWorkspace(ws)}
        />
        <Segmented
          label={COPY.viewLabel}
          value={s.view}
          options={[
            { value: 'assisted', label: COPY.viewAssisted },
            { value: 'spreadsheet', label: COPY.viewSpreadsheet },
          ]}
          onChange={(v) => store.setView(v)}
        />
        <label className="field-inline">
          <span className="field-label">{COPY.showBatch}</span>
          <select className="select" value={s.batchFilter} onChange={(e) => store.setBatchFilter(e.target.value)}>
            {batchOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <div className="app-header-actions">
          <button type="button" className="btn btn-tertiary" onClick={() => store.openDialog({ kind: 'exports' })}>
            <IconDownload />
            {COPY.exports}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.openDialog({ kind: 'audit' })}>
            <IconClock />
            {COPY.auditHistory}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.openDialog({ kind: 'privacy' })}>
            <IconShield />
            {COPY.privacy}
          </button>
          <button type="button" className="btn btn-tertiary" onClick={() => store.openDialog({ kind: 'reset' })}>
            <IconTrash />
            {COPY.reset}
          </button>
        </div>
      </div>
    </header>
  );
}
