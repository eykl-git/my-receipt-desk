/** Structured rule form fields (design §7.2 b): the editor for every draft source. */
import { CATEGORIES } from '../../domain/categories';
import { COPY } from '../copy';
import { chooseLabel, updateForm } from '../panelActions';
import type { PanelState } from '../state';
import { Field } from './Field';

interface Props {
  p: PanelState;
  accounts: Array<{ accountId: string; accountLabel: string }>;
  merchants: string[];
}

export function DraftFormFields({ p, accounts, merchants }: Props) {
  const typeLocked = p.persisted !== null;
  return (
    <form className="form-grid" onSubmit={(e) => e.preventDefault()}>
      <Field label={COPY.ruleType}>
        {(id) => (
          <select id={id} className="select" value={p.form.type} disabled={typeLocked} onChange={(e) => updateForm({ type: e.target.value as PanelState['form']['type'] })}>
            <option value="merchant_alias">{COPY.typeAlias}</option>
            <option value="category_preference">{COPY.typeCategory}</option>
            <option value="posting_window">{COPY.typePolicy}</option>
          </select>
        )}
      </Field>
      {p.labelOptions && p.labelOptions.length > 1 ? (
        <Field label={COPY.chooseLabel}>
          {(id) => (
            <select
              id={id}
              className="select"
              value={p.labelOptions!.findIndex((o) => o.observedLabel === p.form.observedLabel && o.accountId === p.form.accountId)}
              onChange={(e) => chooseLabel(Number(e.target.value))}
            >
              {p.labelOptions!.map((o, i) => (
                <option key={`${o.accountId}|${o.observedLabel}`} value={i}>
                  {o.observedLabel} · {o.accountLabel}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      {p.form.type === 'merchant_alias' ? (
        <>
          <Field label={COPY.cardAccount}>
            {(id) => (
              <select id={id} className="select" required value={p.form.accountId} onChange={(e) => updateForm({ accountId: e.target.value })}>
                <option value="">{COPY.chooseAccount}</option>
                {accounts.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.accountLabel}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={COPY.observedLabel}>
            {(id) => <input id={id} className="input" value={p.form.observedLabel} onChange={(e) => updateForm({ observedLabel: e.target.value })} />}
          </Field>
          <Field label={COPY.merchantName}>
            {(id) => <input id={id} className="input" value={p.form.merchantName} onChange={(e) => updateForm({ merchantName: e.target.value })} />}
          </Field>
          <label className="check-row check-row-wide">
            <input type="checkbox" checked={p.form.ignoreStoreNumber} onChange={(e) => updateForm({ ignoreStoreNumber: e.target.checked })} />
            {COPY.ignoreStoreNumber}
          </label>
        </>
      ) : null}
      {p.form.type === 'category_preference' ? (
        <>
          <Field label={COPY.merchantName}>
            {(id) => (
              <select id={id} className="select" value={p.form.merchantName} onChange={(e) => updateForm({ merchantName: e.target.value })}>
                <option value="">{COPY.chooseMerchant}</option>
                {[...new Set([...merchants, ...(p.form.merchantName ? [p.form.merchantName] : [])])].map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label={COPY.category}>
            {(id) => (
              <select id={id} className="select" value={p.form.categoryId} onChange={(e) => updateForm({ categoryId: e.target.value as PanelState['form']['categoryId'] })}>
                <option value="">{COPY.chooseCategory}</option>
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </>
      ) : null}
      {p.form.type === 'posting_window' ? (
        <Field label={COPY.postingDays}>
          {(id) => <input id={id} className="input" inputMode="numeric" value={p.form.days} onChange={(e) => updateForm({ days: e.target.value })} />}
        </Field>
      ) : null}
    </form>
  );
}
