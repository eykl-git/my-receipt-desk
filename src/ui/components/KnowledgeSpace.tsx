/** Knowledge Space column (S6, S9, design §9.3): readable rule cards, the policy card and locked safety checks. */
import { useId, useMemo, useState, type FormEvent } from 'react';
import { isComparable } from '../../demo/compare';
import { discoverKnowledgeGaps, gapText } from '../../domain/knowledge/discover';
import { PHRASE_MAX_CHARS } from '../../domain/knowledge/phraseParser';
import { BASELINE_POLICY, SAFETY_INVARIANTS } from '../../domain/knowledge/safety';
import { asWorkspaceState } from '../../persistence/commands/context';
import type { RuleHead } from '../../domain/knowledge/schema';
import { formatRuleRef } from '../../domain/primitives';
import type { StoredRuleVersion } from '../../domain/schemas';
import { COPY } from '../copy';
import { formatAt } from '../format';
import { IconClock, IconCompare, IconEdit, IconEye, IconLightbulb, IconLock, IconPause, IconPlay, IconPlus, IconTrash } from '../icons';
import { draftFromPhrase, editBaselinePolicy, openDraft, openEdit, proposeRule } from '../panelActions';
import { store, useAppState, useDerived } from '../store';
import { LockChip, NeutralChip, RuleChip } from './Chips';

function shownVersion(head: RuleHead): number {
  return head.activeVersion ?? head.draftVersion ?? head.lastApprovedVersion ?? head.currentVersion;
}

function RuleCard({ head }: { head: RuleHead }) {
  const s = useAppState();
  const snap = store.snapshot();
  const [showUsage, setShowUsage] = useState(false);
  const versionNo = head.status === 'draft_only' ? head.draftVersion! : head.status === 'suspended' ? head.lastApprovedVersion! : shownVersion(head);
  const v = snap.ruleVersions.find((x) => x.ruleId === head.ruleId && x.version === versionNo) as StoredRuleVersion | undefined;
  if (!v) return null;
  const usedBy = snap.ledger.filter((e) => e.status === 'recorded' && e.ruleRefs.some((r) => r.ruleId === head.ruleId)).map((e) => e.id);
  const accountLabel = v.type === 'merchant_alias' ? (snap.transactions.find((t) => t.accountId === v.scope.accountId)?.accountLabel ?? v.scope.accountId ?? '') : null;
  const isNew = s.newCard === head.ruleId;
  const ref = formatRuleRef(v);
  return (
    <article className={`rule-card${isNew ? ' is-new' : ''}${head.status === 'suspended' ? ' is-suspended' : ''}`} data-testid={`rule-${head.ruleId}`} aria-label={ref}>
      <div className="rule-card-head">
        <RuleChip text={ref} />
        {head.status === 'active' ? <span className="chip chip-green">{COPY.stateActive}</span> : null}
        {head.status === 'suspended' ? <span className="chip chip-amber">{COPY.stateSuspended}</span> : null}
        {head.draftVersion !== null ? <NeutralChip text={COPY.stateDraft(head.draftVersion)} /> : null}
        {isNew ? <span className="chip chip-teal-solid">{COPY.stateNew}</span> : null}
      </div>
      <p className="rule-text">{v.plainEnglish}</p>
      <dl className="rule-meta">
        <div>
          <dt className="sr-only">{COPY.scope}</dt>
          <dd>{accountLabel !== null ? COPY.scopeCard(accountLabel) : COPY.scopeWorkspace}</dd>
        </div>
        <div>
          <dd className="num">{v.approvedAt ? COPY.approvedAt(formatAt(v.approvedAt)) : COPY.notApproved}</dd>
        </div>
        {head.lastApprovedVersion !== null ? (
          <div>
            <dd>
              <button type="button" className="link-button" aria-expanded={showUsage} onClick={() => setShowUsage(!showUsage)}>
                {COPY.usedIn(usedBy.length)}
              </button>
              {showUsage ? <span className="muted"> {usedBy.length > 0 ? COPY.usedInList(usedBy.join(', ')) : COPY.drillNone}</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      <div className="rule-actions">
        {head.status === 'draft_only' ? (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void openDraft(head.ruleId, true)}>
              <IconEye />
              {COPY.previewImpact}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void openDraft(head.ruleId, false)}>
              <IconPlay />
              {COPY.activateRule}
            </button>
            <button type="button" className="btn btn-tertiary btn-small" onClick={() => store.openDialog({ kind: 'discard', ruleId: head.ruleId })}>
              <IconTrash />
              {COPY.discardDraft}
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => store.openDialog({ kind: 'preview', ruleId: head.ruleId })}>
              <IconEye />
              {COPY.previewImpact}
            </button>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => store.openDialog({ kind: 'history', ruleId: head.ruleId })}>
              <IconClock />
              {COPY.viewHistory}
            </button>
            {s.workspace === 'demo' && isComparable(head) ? (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => store.openDialog({ kind: 'compare', ruleRef: { ruleId: head.ruleId, version: head.activeVersion! } })}
                aria-label={`${COPY.compareWithout} (${ref})`}
              >
                <IconCompare />
                {COPY.compareWithout}
              </button>
            ) : null}
            {head.status === 'active' ? (
              <button type="button" className="btn btn-tertiary btn-small" onClick={() => store.openDialog({ kind: 'suspend', ruleId: head.ruleId })}>
                <IconPause />
                {COPY.suspend}
              </button>
            ) : null}
            <button type="button" className="btn btn-tertiary btn-small" onClick={() => void openEdit(head.ruleId)} aria-label={`${COPY.edit} ${head.ruleId}`}>
              <IconEdit />
              {COPY.edit}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

/** "Knowledge gaps found in your data" (brief §25 A). Read-only; hidden when there are none. */
function KnowledgeGaps() {
  const { view } = useDerived();
  const snap = store.snapshot();
  const gaps = useMemo(() => discoverKnowledgeGaps(asWorkspaceState(snap), view), [snap, view]);
  if (gaps.length === 0) return null;
  return (
    <section className="ks-section ks-gaps" aria-labelledby="ks-gaps-title" data-testid="knowledge-gaps">
      <h3 id="ks-gaps-title" className="ks-section-title">
        <IconLightbulb />
        {COPY.gapsHeading}
      </h3>
      <ul className="gap-list">
        {gaps.map((g) => (
          <li key={`${g.accountId}|${g.observedLabel}|${g.merchantId}`} className="gap-card" data-testid="gap-card">
            <p className="gap-text">{gapText(g)}</p>
            <button type="button" className="btn btn-secondary btn-small" onClick={() => void store.openCase(g.reviewReceiptId)}>
              {COPY.reviewCase(g.reviewReceiptId)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Write a rule in plain English" (brief §10, §25 B): a few fixed sentence patterns, drafts only. */
function PhraseBar() {
  const [text, setText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const inputId = useId();
  const helpId = useId();
  const errorId = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() === '') return;
    const r = draftFromPhrase(text);
    if (r.kind === 'refused') setRefusal(r.message);
    else {
      setRefusal(null);
      setText('');
    }
  };
  return (
    <form className="phrase-bar" onSubmit={submit} data-testid="phrase-bar">
      <label htmlFor={inputId} className="field-label">
        {COPY.phraseLabel}
      </label>
      <div className="phrase-row">
        <input
          id={inputId}
          className="input"
          type="text"
          maxLength={PHRASE_MAX_CHARS}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setRefusal(null);
          }}
          aria-describedby={refusal ? `${helpId} ${errorId}` : helpId}
          aria-invalid={refusal ? true : undefined}
        />
        <button type="submit" className="btn btn-secondary btn-small" disabled={text.trim() === ''}>
          {COPY.phraseSubmit}
        </button>
      </div>
      <div id={helpId} className="help">
        {COPY.phraseHelp}
        <ul className="phrase-examples">
          {COPY.phraseExamples.map((x) => (
            <li key={x}>
              <button
                type="button"
                className="phrase-example-pill"
                onClick={() => {
                  setText(x);
                  setRefusal(null);
                }}
                title="Click to try this phrase"
              >
                “{x}”
              </button>
            </li>
          ))}
        </ul>
      </div>
      {refusal ? (
        <p id={errorId} className="error-text" role="alert">
          {refusal}
        </p>
      ) : null}
    </form>
  );
}

function Section({ title, heads }: { title: string; heads: RuleHead[] }) {
  if (heads.length === 0) return null;
  return (
    <section className="ks-section" aria-label={title}>
      <h3 className="ks-section-title">{title}</h3>
      {heads.map((h) => (
        <RuleCard key={h.ruleId} head={h} />
      ))}
    </section>
  );
}

export function KnowledgeSpace() {
  useAppState();
  const snap = store.snapshot();
  const heads = snap.ruleHeads.filter((h) => h.status !== 'discarded');
  const aliases = heads.filter((h) => h.type === 'merchant_alias');
  const categories = heads.filter((h) => h.type === 'category_preference');
  const policies = heads.filter((h) => h.type === 'posting_window');
  const activePolicy = policies.find((h) => h.status === 'active');
  const anyApproved = heads.some((h) => h.lastApprovedVersion !== null);

  return (
    <section className="column column-knowledge" aria-labelledby="col-knowledge">
      <div className="column-head">
        <h2 id="col-knowledge" className="column-title">
          {COPY.knowledgeSpace}
        </h2>
        <div className="ks-head-controls">
          <span className="ks-intelligence-badge">✨ Knowledge Loop</span>
          <button type="button" className="btn btn-secondary btn-small" onClick={proposeRule}>
            <IconPlus />
            {COPY.proposeRule}
          </button>
        </div>
      </div>
      <div className="ks-explain-wrap">
        <p className="ks-explain">{COPY.knowledgeExplain}</p>
        <p className="ks-line">{COPY.knowledgeLine}</p>
        <p className="ks-note">{COPY.notRetrained}</p>
      </div>
      <KnowledgeGaps />
      {!anyApproved ? <p className="empty-state">{COPY.noRules}</p> : null}

      <Section title={COPY.merchantNames} heads={aliases} />
      <Section title={COPY.categoryPreferences} heads={categories} />
      <PhraseBar />

      <section className="ks-section" aria-label={COPY.matchingPolicy}>
        <h3 className="ks-section-title">{COPY.matchingPolicy}</h3>
        {activePolicy ? null : (
          <article className="rule-card" data-testid="policy-baseline" aria-label={COPY.policyCard(BASELINE_POLICY.postingLagMaxDays)}>
            <div className="rule-card-head">
              <RuleChip text={formatRuleRef(BASELINE_POLICY.ref)} />
              <span className="chip chip-green">{COPY.inUseBaseline}</span>
            </div>
            <p className="rule-text">{COPY.policyCard(BASELINE_POLICY.postingLagMaxDays)}</p>
            <div className="rule-actions">
              <button type="button" className="btn btn-secondary btn-small" onClick={() => store.openDialog({ kind: 'baselineHistory' })}>
                <IconClock />
                {COPY.viewHistory}
              </button>
              <button type="button" className="btn btn-tertiary btn-small" onClick={() => void editBaselinePolicy()} aria-label={`${COPY.edit} ${formatRuleRef(BASELINE_POLICY.ref)}`}>
                <IconEdit />
                {COPY.edit}
              </button>
            </div>
          </article>
        )}
        {policies.map((h) => (
          <RuleCard key={h.ruleId} head={h} />
        ))}
      </section>

      <section className="ks-section" aria-label={COPY.safetyChecks}>
        <details className="ks-safety-disclosure" data-testid="safety-disclosure">
          <summary className="ks-safety-summary">
            <span className="ks-safety-summary-left">
              <IconLock />
              <span className="ks-safety-title-text">{COPY.safetyChecks}</span>
              <span className="badge-quiet">10 built-in rules active</span>
            </span>
            <span className="ks-safety-toggle-hint">View guardrails ▾</span>
          </summary>
          <ul className="safety-list">
            {SAFETY_INVARIANTS.map((inv) => (
              <li key={inv.id} className="safety-card" aria-label={`${inv.id} ${inv.title}. ${COPY.safetyCardLabel}`}>
                <span className="safety-head">
                  <span className="mono">{inv.id}</span>
                  <LockChip text={COPY.safetyBadge} />
                </span>
                <span className="safety-title">{inv.title}</span>
              </li>
            ))}
          </ul>
        </details>
      </section>
    </section>
  );
}
