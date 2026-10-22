/** "Import card CSV" wizard (design §12.1): file → account and columns → preview → one atomic commit. */
import { useId, useState } from 'react';
import { DATE_FORMATS, type DateFormat } from '../../domain/dates';
import { decodeCsvBytes, IMPORT_MESSAGES, parseStatementCsv, readCsvGrid, type CsvGrid, type ParsedStatement, type StatementAccount } from '../../domain/imports/parse';
import { AMOUNT_SIGNS, impliedAmountSign, MAPPING_FIELDS, prefillMapping, presetDateFormat, type AmountSign, type ColumnMapping, type MappingField } from '../../domain/imports/mapping';
import { accountsOf, resolveAccount } from '../../domain/imports/rows';
import { LIMITS } from '../../domain/limits';
import { formatMoney } from '../../domain/money';
import { alreadyImportedMessage, importStatement, rejectDuplicateImport } from '../../persistence/commands';
import { PENDING_DOCUMENT_ID, type StatementFile } from '../../persistence/commands/statements';
import { sha256Hex } from '../../persistence/hash';
import { COPY } from '../copy';
import { money } from '../format';
import { store } from '../store';
import { Modal } from './Modal';
import { TableWrap } from './TableWrap';

const REQUIRED: MappingField[] = ['postingDate', 'description'];
const NEW = '__new__';

export function ImportWizard() {
  const fileId = useId();
  const [step, setStep] = useState<'file' | 'setup' | 'preview'>('file');
  const [file, setFile] = useState<StatementFile | null>(null);
  const [grid, setGrid] = useState<CsvGrid | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [dateFormat, setDateFormat] = useState<DateFormat | ''>('');
  const [amountSign, setAmountSign] = useState<AmountSign | ''>('');
  const workspaceCurrency = store.snapshot().currency;
  const [currency, setCurrency] = useState<string>(workspaceCurrency);
  const accounts = accountsOf(store.snapshot().transactions);
  const [accountChoice, setAccountChoice] = useState<string>(accounts[0]?.accountId ?? NEW);
  const [accountName, setAccountName] = useState('');
  const [parsed, setParsed] = useState<{ result: ParsedStatement; account: StatementAccount } | null>(null);
  const [validOnly, setValidOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  const onFile = async (list: FileList | null) => {
    const f = list?.[0];
    setMessage(null);
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.csv')) return setMessage(IMPORT_MESSAGES.notCsv);
    if (f.size > LIMITS.csvMaxBytes) return setMessage(IMPORT_MESSAGES.tooLarge);
    const bytes = new Uint8Array(await f.arrayBuffer());
    const decoded = decodeCsvBytes(bytes);
    if (!decoded.ok) return setMessage(decoded.message);
    const sha = await sha256Hex(bytes);
    const existing = store.snapshot().sourceDocuments.find((d) => d.sha256 === sha);
    if (existing) {
      await store.run('the import', (repo) => rejectDuplicateImport(repo, { fileName: f.name, sha256: sha }));
      return setMessage(alreadyImportedMessage(existing.importedAt));
    }
    const g = readCsvGrid(decoded.text);
    if (g.problems.length > 0) return setMessage(g.problems.join(' '));
    const m = prefillMapping(g.header);
    setFile({ fileName: f.name, mimeType: 'text/csv', bytes, sha256: sha });
    setGrid(g);
    setMapping(m);
    setDateFormat(presetDateFormat(g.rows.map((r) => r.cells), m) ?? '');
    setStep('setup');
  };

  const preview = () => {
    if (!grid || !file) return;
    const name = accountChoice === NEW ? accountName : (accounts.find((a) => a.accountId === accountChoice)?.accountLabel ?? '');
    const acct = resolveAccount(name, store.snapshot().transactions);
    if (!acct.ok) return setMessage(acct.message);
    const account = { accountId: acct.accountId, accountLabel: acct.accountLabel };
    const result = parseStatementCsv(
      grid,
      mapping,
      { dateFormat: dateFormat === '' ? null : dateFormat, amountSign: amountSign === '' ? null : amountSign, defaultCurrency: currency.trim() },
      account,
      { sha256: file.sha256, sourceDocumentId: PENDING_DOCUMENT_ID, workspaceId: 'personal', workspaceCurrency },
    );
    if (result.fileErrors.length > 0) return setMessage(result.fileErrors.join(' '));
    setMessage(null);
    setParsed({ result, account });
    setValidOnly(false);
    setStep('preview');
  };

  const commit = async () => {
    if (!file || !parsed) return;
    setBusy(true);
    const r = await store.run('the import', (repo) => importStatement(repo, file, parsed.result, parsed.account, validOnly ? 'valid_rows_only' : 'all_rows'));
    setBusy(false);
    if (!r.ok) return setMessage(r.message);
    store.closeDialog();
    store.notify(COPY.imported(parsed.result.rows.length, file.fileName));
  };

  const implied = impliedAmountSign(mapping);
  const columnSelect = (field: MappingField) => (
    <label key={field} className="field">
      <span className="field-label">
        {COPY.mappingFields[field]} {REQUIRED.includes(field) ? COPY.required : ''}
      </span>
      <select
        className="select"
        value={mapping[field] ?? ''}
        onChange={(e) => {
          const next = { ...mapping };
          if (e.target.value === '') delete next[field];
          else next[field] = Number(e.target.value);
          setMapping(next);
        }}
      >
        <option value="">{COPY.notMapped}</option>
        {grid?.header.map((h, i) => (
          <option key={i} value={i}>
            {h || `Column ${i + 1}`}
          </option>
        ))}
      </select>
    </label>
  );

  let body;
  let footer;
  if (step === 'file') {
    body = (
      <>
        <h3 className="drawer-section-title">{COPY.importStepFile}</h3>
        <label className="field" htmlFor={fileId}>
          <span className="field-label">{COPY.importFile}</span>
        </label>
        <input id={fileId} className="input" type="file" accept=".csv,text/csv" onChange={(e) => void onFile(e.target.files)} />
      </>
    );
  } else if (step === 'setup') {
    body = (
      <>
        <h3 className="drawer-section-title">{COPY.importStepSetup}</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">{COPY.existingAccount}</span>
            <select className="select" value={accountChoice} onChange={(e) => setAccountChoice(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.accountLabel}
                </option>
              ))}
              <option value={NEW}>{COPY.newAccount}</option>
            </select>
          </label>
          {accountChoice === NEW ? (
            <label className="field">
              <span className="field-label">{COPY.accountName}</span>
              <input className="input" maxLength={LIMITS.accountNameMaxChars} value={accountName} onChange={(e) => setAccountName(e.target.value)} />
            </label>
          ) : null}
        </div>
        <h4 className="list-heading">{COPY.mapping}</h4>
        <div className="form-grid">{MAPPING_FIELDS.map(columnSelect)}</div>
        <h4 className="list-heading">{COPY.conventions}</h4>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">{COPY.dateFormat}</span>
            <select className="select" value={dateFormat} onChange={(e) => setDateFormat(e.target.value as DateFormat | '')}>
              <option value="">{COPY.chooseFormat}</option>
              {DATE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">{COPY.amountSign}</span>
            <select className="select" value={implied ?? amountSign} disabled={implied !== null} onChange={(e) => setAmountSign(e.target.value as AmountSign | '')}>
              <option value="">{COPY.chooseFormat}</option>
              {AMOUNT_SIGNS.map((a) => (
                <option key={a} value={a}>
                  {COPY.amountSigns[a]}
                </option>
              ))}
            </select>
          </label>
          {mapping.currency === undefined ? (
            <label className="field">
              <span className="field-label">{COPY.currencyAll}</span>
              <input className="input" value={currency} maxLength={3} onChange={(e) => setCurrency(e.target.value)} />
            </label>
          ) : null}
        </div>
      </>
    );
    footer = (
      <div className="drawer-actions">
        <button type="button" className="btn btn-primary" onClick={preview}>
          {COPY.previewImport}
        </button>
        <button type="button" className="btn btn-tertiary" onClick={() => setStep('file')}>
          {COPY.back}
        </button>
      </div>
    );
  } else if (parsed) {
    const p = parsed.result.preview;
    const errors = parsed.result.errors;
    body = (
      <>
        <h3 className="drawer-section-title">{COPY.importStepPreview}</h3>
        <p className="muted">{COPY.importCurrencyNote(p.currency)}</p>
        <dl className="preview-counts" data-testid="import-preview">
          {[
            [COPY.previewCounts.total, p.totalRows],
            [COPY.previewCounts.valid, p.validRows],
            [COPY.previewCounts.errors, p.errorRows],
            [COPY.previewCounts.quarantined(p.currency), p.quarantinedRows.length],
            [COPY.previewCounts.credits, p.creditRows.length],
            [COPY.previewCounts.hkdRows(p.currency), p.hkdDebitRows],
            [COPY.previewCounts.hkdTotal(p.currency), money(p.hkdDebitTotalMinor, p.currency)],
          ].map(([k, v]) => (
            <div key={String(k)}>
              <dt>{k}</dt>
              <dd className="num">{v}</dd>
            </div>
          ))}
        </dl>
        {p.otherCurrencyTotals.length > 0 ? <p className="muted">{p.otherCurrencyTotals.map((o) => COPY.notIncluded(formatMoney(o.totalMinor, o.currency))).join(' · ')}</p> : null}
        {errors.length > 0 ? (
          <>
            <h4 className="list-heading">{COPY.errorTable}</h4>
            <TableWrap label={COPY.errorTable} scroll>
              <table className="table">
                <thead>
                  <tr>
                    {COPY.errorCols.map((c) => (
                      <th key={c} scope="col">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {errors.map((e, i) => (
                    <tr key={i}>
                      <td className="num">{e.row}</td>
                      <td>{e.column}</td>
                      <td className="mono">{e.value}</td>
                      <td>{e.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
            <label className="check-row">
              <input type="checkbox" checked={validOnly} onChange={(e) => setValidOnly(e.target.checked)} />
              {COPY.validOnly(p.validRows)}
            </label>
          </>
        ) : null}
        <h4 className="list-heading">{COPY.previewRows}</h4>
        <TableWrap label={COPY.previewRows} scroll>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">{COPY.errorCols[0]}</th>
                <th scope="col">{COPY.colReference}</th>
                <th scope="col">{COPY.colLabel}</th>
                <th scope="col">{COPY.colPosted}</th>
                <th scope="col" className="right">
                  {COPY.colAmount}
                </th>
                <th scope="col">{COPY.txDirection}</th>
              </tr>
            </thead>
            <tbody>
              {parsed.result.rows.slice(0, 20).map((r) => (
                <tr key={r.id}>
                  <td className="num">{r.rowNumber}</td>
                  <td className="mono">{r.reference ?? ''}</td>
                  <td>{r.rawLabel}</td>
                  <td className="num">{r.postingDate}</td>
                  <td className="num right">{formatMoney(r.amountMinor, r.currency)}</td>
                  <td>{r.direction}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      </>
    );
    footer = (
      <div className="drawer-actions">
        {errors.length === 0 ? (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void commit()}>
            {COPY.importAll}
          </button>
        ) : (
          <div className="action-with-help">
            <button type="button" className="btn btn-primary" disabled={busy || !validOnly || p.validRows === 0} onClick={() => void commit()}>
              {COPY.importValid}
            </button>
            {!validOnly ? <span className="help">{COPY.fixErrorsFirst}</span> : null}
          </div>
        )}
        <button type="button" className="btn btn-tertiary" onClick={() => setStep('setup')}>
          {COPY.back}
        </button>
      </div>
    );
  }

  return (
    <Modal title={COPY.importTitle} onClose={() => store.closeDialog()} footer={footer} wide>
      {body}
      {message ? (
        <p className="error-text" role="alert">
          {message}
        </p>
      ) : null}
    </Modal>
  );
}
