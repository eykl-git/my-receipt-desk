/** Review drawer for a receipt case (design §9.3, §6.2). The rule draft panel replaces its body (M2). */
import { useId, useState } from 'react';
import { printedTextForDisplay } from '../../domain/capture/display';
import { effectiveFields, FIELD_LABELS } from '../../domain/capture/fields';
import { CATEGORIES, categoryName, type CategoryId } from '../../domain/categories';
import { MANUAL_MESSAGES, pickerCandidates } from '../../domain/matching/manual';
import { rankBySimilarity, sharedWordHint } from '../../domain/matching/similarity';
import { inWindow, postingLag } from '../../domain/matching/helpers';
import { formatMoney } from '../../domain/money';
import { formatRuleRef, type RuleRef } from '../../domain/primitives';
import { FIELD_NAMES, type FieldName, type Receipt, type StatementTransaction } from '../../domain/schemas';
import { canApplyExtraction, confirmCaseOnly, confirmCategory, isUnlinkCase, recordProposal, resolveDuplicate, saveFields, FieldValidationError } from '../../persistence/commands';
import { OcrOutcomeNote, ReadAutomatically } from './ReadAutomatically';
import type { FieldErrors } from '../../domain/capture/edit';
import { COPY } from '../copy';
import { receiptAmount, receiptMerchant, txAmount, txRef } from '../format';
import { useFileUrl } from '../hooks';
import { proposeCategoryFromCase, proposeFromCase, requestLeavePanel } from '../panelActions';
import { errorMessage, store, useAppState, useDerived } from '../store';
import { AmberChip, GroupChip, NeutralChip, RuleChip } from './Chips';
import { Modal } from './Modal';
import { RuleDraftPanel, RuleDraftFooter } from './RuleDraftPanel';
import { TableWrap } from './TableWrap';

function fieldValue(name: FieldName, v: unknown): string {
  if (v === null || v === undefined) return COPY.fieldNoValue;
  if (name === 'amountMinor' && typeof v === 'number') return formatMoney(v, '').trim();
  return String(v);
}

function FieldsTable({ receipt }: { receipt: Receipt }) {
  return (
    <table className="table">
      <thead>
        <tr>
          <th scope="col">{COPY.colName}</th>
          <th scope="col">{COPY.fieldOriginal}</th>
          <th scope="col">{COPY.fieldCorrection}</th>
        </tr>
      </thead>
      <tbody>
        {FIELD_NAMES.map((name) => {
          const f = receipt.fields[name];
          const original = f.original.value === null && f.original.raw ? `“${f.original.raw}”` : fieldValue(name, f.original.value);
          return (
            <tr key={name}>
              <th scope="row">{FIELD_LABELS[name]}</th>
              <td className="num">
                {original} {f.original.clarity === 'unclear' && f.correction === null ? <AmberChip text={COPY.unclear} /> : null}
              </td>
              <td className="num">{f.correction ? fieldValue(name, f.correction.value) : '—'}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function EditFields({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  const f = effectiveFields(receipt);
  const [values, setValues] = useState({
    merchant: f.merchant ?? '',
    date: f.date ?? '',
    amount: f.amountMinor !== null ? formatMoney(f.amountMinor, '').trim() : '',
    currency: f.currency ?? store.snapshot().currency,
  });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      await saveFields(store.repo(), receipt.id, values);
      await store.refresh();
      store.announce(`${receipt.id}: ${COPY.saveFields}.`);
      onDone();
    } catch (e) {
      if (e instanceof FieldValidationError) setErrors(e.fieldErrors);
      setError(errorMessage(e, 'the fields'));
    }
  };
  const input = (key: keyof typeof values, field: FieldName, type = 'text') => (
    <label className="field">
      <span className="field-label">{FIELD_LABELS[field]}</span>
      <input
        className="input"
        type={type}
        value={values[key]}
        onChange={(e) => setValues({ ...values, [key]: e.target.value })}
        aria-invalid={errors[field] ? true : undefined}
        aria-describedby={errors[field] ? `err-${field}` : undefined}
        inputMode={key === 'amount' ? 'decimal' : undefined}
      />
      {errors[field] ? (
        <span id={`err-${field}`} className="error-text">
          {errors[field]}
        </span>
      ) : null}
    </label>
  );
  return (
    <form
      className="form-grid"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {input('merchant', 'merchant')}
      {input('date', 'date', 'date')}
      {input('amount', 'amountMinor')}
      {input('currency', 'currency')}
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" className="btn btn-secondary">
          {COPY.saveFields}
        </button>
        <button type="button" className="btn btn-tertiary" onClick={onDone}>
          {COPY.cancel}
        </button>
      </div>
    </form>
  );
}

interface CandidateRow {
  t: StatementTransaction;
  role: string;
  nameSame: boolean | null;
  /** "Shares the word “X”" for near candidates (brief §25 C); never a number. */
  hint: string | null;
}

function TransactionsTable({ receipt, rows }: { receipt: Receipt; rows: CandidateRow[] }) {
  const f = effectiveFields(receipt);
  const policyDays = store.derived().view.evaluation.policy.postingLagMaxDays;
  if (rows.length === 0) return <p className="muted">{COPY.noCandidates}</p>;
  return (
    <TableWrap label={COPY.cardTransactions}>
      <table className="table" data-testid="candidate-table">
        <thead>
          <tr>
            <th scope="col">{COPY.colReference}</th>
            <th scope="col">{COPY.colLabel}</th>
            <th scope="col" className="right">
              {COPY.colAmount}
            </th>
            <th scope="col">{COPY.colDate}</th>
            <th scope="col">{COPY.colName}</th>
            <th scope="col">{COPY.colRole}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ t, role, nameSame, hint }) => {
            const amountCell =
              f.amountMinor === null ? (
                <NeutralChip text={COPY.notCompared} />
              ) : f.amountMinor === t.amountMinor && f.currency === t.currency ? (
                <NeutralChip text={COPY.same} />
              ) : (
                <AmberChip text={`${COPY.different}: ${txAmount(t)} vs ${formatMoney(f.amountMinor, f.currency ?? '')}`} />
              );
            const lag = f.date ? postingLag(f.date, t) : null;
            const dateCell =
              f.date === null || lag === null ? (
                <NeutralChip text={COPY.notCompared} />
              ) : inWindow(f.date, t, policyDays) ? (
                <NeutralChip text={`${COPY.same}: +${lag}d`} />
              ) : (
                <AmberChip text={`${COPY.different}: ${lag >= 0 ? '+' : ''}${lag}d`} />
              );
            return (
              <tr key={t.id}>
                <td className="mono">{txRef(t)}</td>
                <td>{t.rawLabel}</td>
                <td className="num right">
                  {txAmount(t)}
                  <div>{amountCell}</div>
                </td>
                <td className="num">
                  {t.postingDate}
                  <div>{dateCell}</div>
                </td>
                <td>{nameSame === null ? <NeutralChip text={COPY.notCompared} /> : nameSame ? <NeutralChip text={COPY.same} /> : <AmberChip text={COPY.different} />}</td>
                <td>
                  {role}
                  {hint ? (
                    <div>
                      <NeutralChip text={hint} />
                    </div>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableWrap>
  );
}

function pickerInput() {
  const snap = store.snapshot();
  return {
    receipts: snap.receipts,
    transactions: snap.transactions,
    matches: snap.matches,
    ledgerEntries: snap.ledger,
    activeRules: store.derived().view.activeRules,
    decisions: snap.decisions,
    workspaceCurrency: snap.currency,
  };
}

function ManualConfirm({ receipt, onDone }: { receipt: Receipt; onDone: () => void }) {
  const s = useAppState();
  const rows = pickerCandidates(pickerInput(), receipt.id);
  const [selected, setSelected] = useState<string | null>(rows.length === 1 ? rows[0]!.transaction.id : null);
  const [reason, setReason] = useState<string>(s.workspace === 'demo' ? COPY.tourReason : '');
  const [error, setError] = useState<string | null>(null);
  const disabledReason = s.recording ? COPY.recordingInProgress : rows.length === 0 ? COPY.pickerEmpty : selected === null ? COPY.chooseOne : null;
  const submit = async () => {
    if (!selected) return;
    const r = await store.run(`confirming ${receipt.id}`, (repo) => confirmCaseOnly(repo, { receiptId: receipt.id, transactionId: selected, reason }));
    if (r.ok) {
      store.announce(COPY.recordedAs(store.derived().view.caseById.get(receipt.id)?.ledgerEntryId ?? receipt.id));
      onDone();
    } else setError(r.message);
  };
  return (
    <form
      className="manual-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <fieldset className="fieldset">
        <legend className="field-label">{COPY.chooseTransaction}</legend>
        {rows.length === 0 ? <p className="muted">{COPY.pickerEmpty}</p> : null}
        {rows.map((r) => (
          <label key={r.transaction.id} className="radio-row">
            <input type="radio" name="txn" value={r.transaction.id} checked={selected === r.transaction.id} onChange={() => setSelected(r.transaction.id)} />
            <span className="mono">{txRef(r.transaction)}</span>
            <span>{r.transaction.rawLabel}</span>
            <span className="num">{r.transaction.postingDate}</span>
            <span className="num">{txAmount(r.transaction)}</span>
            <span className="chip-row">
              {r.tags.map((t) => (t === COPY.nameMatches ? <NeutralChip key={t} text={t} /> : <AmberChip key={t} text={t} />))}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span className="field-label">{COPY.reasonLabel}</span>
        <textarea className="input" rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <div className="button-row">
        <button type="submit" className="btn btn-primary" disabled={disabledReason !== null || s.busy}>
          {COPY.confirmAndRecord}
        </button>
        <button type="button" className="btn btn-tertiary" onClick={onDone}>
          {COPY.cancel}
        </button>
      </div>
      {disabledReason ? <p className="muted">{disabledReason}</p> : null}
    </form>
  );
}

/** "Confirm category" (§6.7): category only; never touches matching. */
function CategoryForm({ receiptId, current, suggestionRef }: { receiptId: string; current: CategoryId | null; suggestionRef: RuleRef | null }) {
  const s = useAppState();
  const id = useId();
  const helpId = useId();
  const [value, setValue] = useState<CategoryId | ''>(current ?? '');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (value === '') return;
    setError(null);
    const r = await store.run(`confirming the category of ${receiptId}`, (repo) => confirmCategory(repo, receiptId, value));
    if (r.ok) store.announce(COPY.categoryDone(receiptId, categoryName(value)));
    else setError(r.message);
  };
  return (
    <form
      className="category-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="field">
        <label className="field-label" htmlFor={id}>
          {COPY.categorySelect}
        </label>
        <select id={id} className="select" value={value} onChange={(e) => setValue(e.target.value as CategoryId | '')} aria-describedby={helpId}>
          <option value="">{COPY.chooseCategory}</option>
          {CATEGORIES.map((cat) => (
            <option key={cat.id} value={cat.id}>
              {cat.name}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn btn-secondary btn-small" disabled={value === '' || s.busy}>
        {COPY.confirmCategory}
      </button>
      <p id={helpId} className="help full-width">
        {suggestionRef ? `${COPY.categorySuggestionSource(formatRuleRef(suggestionRef))}. ` : ''}
        {value === '' ? COPY.chooseCategory : COPY.confirmCategoryHelp}
      </p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}

export function CaseDrawer({ receiptId }: { receiptId: string }) {
  const s = useAppState();
  const { view } = useDerived();
  const snap = store.snapshot();
  const drawer = s.drawer?.kind === 'case' ? s.drawer : null;
  const [manualOpen, setManualOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const receipt = snap.receipts.find((r) => r.id === receiptId);
  const c = view.caseById.get(receiptId);
  const doc = receipt ? snap.sourceDocuments.find((d) => d.id === receipt.sourceDocumentId) : undefined;
  const url = useFileUrl(doc?.fileKey ?? null);
  if (!receipt || !c || !drawer) return null;

  if (drawer.panel) {
    return (
      <Modal variant="drawer" title={COPY.draftTitle} onClose={() => requestLeavePanel('close')} footer={<RuleDraftFooter />} testId="drawer">
        <RuleDraftPanel />
      </Modal>
    );
  }

  const match = c.matchId ? snap.matches.find((m) => m.id === c.matchId) : undefined;
  const p = c.proposal;
  const merchant = effectiveFields(receipt).merchant;
  const rows: CandidateRow[] = [];
  const add = (ids: readonly string[], role: string, nameSame: boolean | null, rank = false) => {
    const found = ids.flatMap((id) => snap.transactions.filter((x) => x.id === id));
    // Near candidates are ordered by label similarity only (brief §25 C); outcomes are unchanged.
    const ordered = rank && merchant ? rankBySimilarity(found, merchant) : found;
    for (const t of ordered) {
      if (!rows.some((r) => r.t.id === t.id)) rows.push({ t, role, nameSame, hint: rank && merchant && nameSame === false ? sharedWordHint(t.rawLabel, merchant) : null });
    }
  };
  if (match) add([match.transactionId], COPY.roleMatched, match.method === 'manual_resolution' ? null : true);
  if (p) {
    add(p.candidateIds, COPY.roleCandidate, true);
    add(p.heldIds, COPY.roleHeld, true);
    add(p.nearCandidateIds, c.flags.includes('missing_fields') ? COPY.roleNearUnclear : COPY.roleNear, c.flags.includes('missing_fields') ? true : false, true);
  }
  const refs: RuleRef[] = match ? match.proposalSnapshot.ruleRefs : (p?.ruleRefs ?? []);
  const policyRef = match ? match.proposalSnapshot.policyRef : (p?.policyRef ?? view.evaluation.policy.ref);
  const trace = match ? match.proposalSnapshot.trace : (p?.trace ?? []);
  const problems = (p?.trace ?? []).filter((t) => t.result === 'fail');
  const printed = printedTextForDisplay(receipt);
  const setAside = c.group === null;
  const pending = c.group !== 'recorded' && !setAside;
  const duplicate = c.flags.includes('duplicate_suspected');
  const ledger = c.ledgerEntryId ? snap.ledger.find((e) => e.id === c.ledgerEntryId) : undefined;
  const pickerEmpty = pickerCandidates(pickerInput(), receipt.id).length === 0;
  const confirmDisabled = c.capture !== 'validated' ? COPY.checkFieldsFirst : duplicate ? MANUAL_MESSAGES.duplicateFirst : pickerEmpty ? COPY.pickerEmpty : null;

  const record = async () => {
    if (!p) return;
    const r = await store.run(`recording ${receipt.id}`, (repo) => recordProposal(repo, p));
    if (r.ok) store.announce(COPY.recordedAs(store.derived().view.caseById.get(receipt.id)?.ledgerEntryId ?? receipt.id));
    else setError(r.message);
  };

  const resolve = async (choice: 'distinct' | 'set_aside') => {
    setError(null);
    const r = await store.run(`resolving ${receipt.id}`, (repo) => resolveDuplicate(repo, receipt.id, choice));
    if (r.ok) store.announce(choice === 'distinct' ? COPY.distinctDone(receipt.id) : COPY.setAsideDone(receipt.id));
    else setError(r.message);
  };

  const footer = setAside ? undefined : (
    <div className="drawer-actions">
      {pending && duplicate ? (
        <>
          <div className="action-with-help">
            <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void resolve('distinct')}>
              {COPY.differentPurchases}
            </button>
            <span className="help">{COPY.differentPurchasesHelp}</span>
          </div>
          <div className="action-with-help">
            <button type="button" className="btn btn-secondary" disabled={s.busy} onClick={() => void resolve('set_aside')}>
              {COPY.setAsideReceipt}
            </button>
            <span className="help">{COPY.setAsideReceiptHelp}</span>
          </div>
        </>
      ) : null}
      {pending ? (
        <div className="action-with-help">
          <button type="button" className="btn btn-secondary" disabled={confirmDisabled !== null || manualOpen} onClick={() => setManualOpen(true)}>
            {COPY.confirmCaseOnly}
          </button>
          <span className="help">{confirmDisabled ?? COPY.confirmCaseOnlyHelp}</span>
        </div>
      ) : null}
      <div className="action-with-help">
        <button type="button" className="btn btn-secondary" onClick={() => proposeFromCase(receipt.id)}>
          {COPY.proposeKnowledge}
        </button>
        <span className="help">{pending ? COPY.proposeKnowledgeHelp : COPY.confirmationSaved}</span>
      </div>
      {!pending && merchant ? (
        <button type="button" className="btn btn-tertiary" onClick={() => proposeCategoryFromCase(receipt.id, merchant)}>
          {COPY.alsoSuggestCategory(merchant)}
        </button>
      ) : null}
      {!pending && ledger ? (
        <button
          type="button"
          className="btn btn-secondary"
          disabled={s.busy}
          onClick={() => store.openDialog({ kind: 'void', ledgerEntryId: ledger.id, mode: isUnlinkCase(ledger) ? 'unlink' : 'void', receiptId: receipt.id })}
        >
          {isUnlinkCase(ledger) ? COPY.unlinkReceipt : COPY.voidEntry}
        </button>
      ) : null}
      {c.group === 'ready' && !manualOpen ? (
        <div className="action-with-help">
          <button type="button" className="btn btn-primary" disabled={s.busy} onClick={() => void record()}>
            {COPY.record}
          </button>
          {s.recording ? <span className="help">{COPY.recordingInProgress}</span> : null}
        </div>
      ) : null}
    </div>
  );

  return (
    <Modal
      variant="drawer"
      testId="drawer"
      title={
        <>
          <span className="mono">{receipt.id}</span> {receiptMerchant(receipt)} <span className="num">{receiptAmount(receipt)}</span>
        </>
      }
      onClose={() => store.closeDrawer()}
      footer={footer}
    >
      <div className="chip-row">
        {c.group ? <GroupChip group={c.group} /> : null}
        {refs.map((r) => (
          <RuleChip key={formatRuleRef(r)} text={formatRuleRef(r)} />
        ))}
      </div>
      <p className="case-explanation">{c.explanation}</p>
      {error ? (
        <p className="error-text" role="alert">
          {error}
        </p>
      ) : null}

      {manualOpen ? (
        <section className="drawer-section" aria-label={COPY.confirmCaseOnly}>
          <h3 className="drawer-section-title">{COPY.confirmCaseOnly}</h3>
          <ManualConfirm receipt={receipt} onDone={() => setManualOpen(false)} />
        </section>
      ) : null}

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.originalReceipt}</h3>
        <figure className="receipt-figure">
          {url ? <img src={url} alt={COPY.receiptImageAlt(receipt.id)} className="receipt-image" /> : null}
          <figcaption className="muted" title={doc?.fileName}>
            {doc ? (doc.fileName.length > 200 ? `${doc.fileName.slice(0, 200)}…` : doc.fileName) : ''}
          </figcaption>
        </figure>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.extractedFields}</h3>
        <p className="disclosure-label">
          {receipt.adapter.kind === 'demo-fixture' ? COPY.demoExtraction : receipt.adapter.kind === 'ocr' ? COPY.ocrDisclosure : COPY.manualExtraction}
        </p>
        {pending && !editOpen && canApplyExtraction(receipt) ? <ReadAutomatically receipt={receipt} /> : null}
        {s.ocrOutcome && s.ocrOutcome.receiptId === receipt.id ? <OcrOutcomeNote outcome={s.ocrOutcome} workspaceCurrency={snap.currency} /> : null}
        {editOpen ? <EditFields receipt={receipt} onDone={() => setEditOpen(false)} /> : <FieldsTable receipt={receipt} />}
        {pending && !editOpen ? (
          <button type="button" className="btn btn-tertiary btn-small" onClick={() => setEditOpen(true)}>
            {COPY.editFields}
          </button>
        ) : null}
      </section>

      {printed ? (
        <section className="drawer-section">
          <h3 className="drawer-section-title">{COPY.printedText}</h3>
          <pre className="printed-text">{printed}</pre>
          <p className="muted">{COPY.printedTextNote}</p>
        </section>
      ) : null}

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.cardTransactions}</h3>
        <TransactionsTable receipt={receipt} rows={rows} />
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.rulesUsed}</h3>
        {refs.length === 0 ? <p className="muted">{COPY.noRulesUsed}</p> : null}
        <div className="chip-row">
          {refs.map((r) => (
            <RuleChip key={formatRuleRef(r)} text={formatRuleRef(r)} />
          ))}
          <NeutralChip text={COPY.policyVersion(formatRuleRef(policyRef))} />
          <NeutralChip text={COPY.engineVersion('match-engine/1')} />
        </div>
        {match
          ? refs
              .filter((r) => snap.ruleHeads.find((h) => h.ruleId === r.ruleId)?.status === 'suspended')
              .map((r) => (
                <p key={`s-${formatRuleRef(r)}`} className="muted">
                  {COPY.recordedUsingSuspended(formatRuleRef(r))}
                </p>
              ))
          : null}
        {pending && c.voidedEntryIds.length > 0 ? <p className="muted">{COPY.previousVoided(c.voidedEntryIds.join(', '))}</p> : null}
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.missingHeading}</h3>
        {problems.length === 0 ? (
          <p className="muted">{COPY.nothingMissing}</p>
        ) : (
          <ul className="plain-list">
            {problems.map((t, i) => (
              <li key={i}>{t.message}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="drawer-section">
        <details className="disclosure">
          <summary>{COPY.decisionTrace}</summary>
          <ol className="trace">
            {trace.map((t, i) => (
              <li key={i} className={`trace-${t.result}`}>
                <span className="chip chip-muted">{t.result}</span> {t.message}
              </li>
            ))}
          </ol>
        </details>
      </section>

      <section className="drawer-section">
        <h3 className="drawer-section-title">{COPY.categoryHeading}</h3>
        <p>
          {ledger && ledger.category.categoryId
            ? COPY.categoryRecorded(categoryName(ledger.category.categoryId))
            : c.category.status === 'suggested' && c.category.categoryId && c.category.ruleRef
              ? COPY.categorySuggested(categoryName(c.category.categoryId), formatRuleRef(c.category.ruleRef))
              : c.category.status === 'confirmed' && c.category.categoryId
                ? COPY.categoryConfirmed(categoryName(c.category.categoryId))
                : COPY.categoryNone}
        </p>
        {!setAside ? <CategoryForm receiptId={receipt.id} current={ledger?.category.categoryId ?? c.category.categoryId} suggestionRef={c.category.status === 'suggested' ? c.category.ruleRef : null} /> : null}
      </section>
    </Modal>
  );
}
