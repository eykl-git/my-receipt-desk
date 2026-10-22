/**
 * Rule draft panel flow (design §7.2, §7.4, §7.5, review-3 amendment M2).
 * Opening a panel writes nothing. The first "Preview impact" saves the draft
 * (createDraft), later changed previews save edits (updateDraft). "Activate
 * rule" needs a preview of the current content; the summary then shows in the
 * drawer, and the highlight starts when the drawer closes.
 */
import { parseRulePhrase, type PhraseResult } from '../domain/knowledge/phraseParser';
import { prefillDraftFromCase } from '../domain/knowledge/prefill';
import { previewImpact } from '../domain/knowledge/preview';
import { RuleDraftSchema, toDraftContent } from '../domain/knowledge/schema';
import { activationSummary } from '../domain/knowledge/summary';
import { validateDraft } from '../domain/knowledge/validate';
import { canonicalJson } from '../domain/matching/fingerprint';
import { formatRuleRef } from '../domain/primitives';
import { accountsOf } from '../domain/imports/rows';
import { deriveWorkspaceView } from '../domain/views';
import { activateRule, createDraft, discardDraft, editRule, updateDraft } from '../persistence/commands';
import { BASELINE_POLICY } from '../domain/knowledge/safety';
import { asWorkspaceState } from '../persistence/commands/context';
import { COPY } from './copy';
import { draftFromForm, EMPTY_FORM, formFromDraft, type DraftForm } from './draftForm';
import type { PanelState } from './state';
import { errorMessage, store } from './store';

function basePanel(origin: PanelState['origin'], form: DraftForm, seed: PanelState['seed']): PanelState {
  return { origin, editOf: null, form, seed, labelOptions: null, persisted: null, preview: null, schemaErrors: null, summary: null, intro: null, confirmDiscard: null, error: null, busy: false };
}

/**
 * "Edit" on an active or suspended rule card (§7.2 e, REQ-8.7): the panel is
 * pre-filled from the last approved version; the first "Preview impact" saves
 * it as version n+1 (editRule). A rule with an open draft reopens that draft.
 */
export async function openEdit(ruleId: string): Promise<void> {
  const s = store.snapshot();
  const head = s.ruleHeads.find((h) => h.ruleId === ruleId);
  if (!head) return;
  if (head.draftVersion !== null) {
    await openDraft(ruleId, false);
    return;
  }
  const v = head.lastApprovedVersion !== null ? s.ruleVersions.find((x) => x.ruleId === ruleId && x.version === head.lastApprovedVersion) : undefined;
  if (!v) return;
  const form = formFromDraft(v, s);
  const panel: PanelState = { ...basePanel({ kind: 'rule', ruleId }, form, { form, evidence: v.evidenceRefs }), editOf: ruleId, intro: COPY.editIntro(formatRuleRef(v), head.currentVersion + 1) };
  store.setDrawer({ kind: 'rule', panel });
}

/**
 * "Edit" on the built-in posting-window card (§4, A28): routes to the stored
 * K-POLICY rule if one exists; otherwise opens a new posting-window draft
 * pre-filled with the built-in 3 days.
 */
export async function editBaselinePolicy(): Promise<void> {
  const policy = store.snapshot().ruleHeads.find((h) => h.type === 'posting_window' && h.status !== 'discarded');
  if (policy) {
    if (policy.status === 'draft_only') await openDraft(policy.ruleId, false);
    else await openEdit(policy.ruleId);
    return;
  }
  store.setDrawer({ kind: 'rule', panel: basePanel({ kind: 'form' }, { ...EMPTY_FORM, type: 'posting_window', days: String(BASELINE_POLICY.postingLagMaxDays) }, null) });
}

export function currentPanel(): PanelState | null {
  const d = store.get().drawer;
  return d && (d.kind === 'case' || d.kind === 'rule') ? d.panel : null;
}

function setPanel(panel: PanelState | null): void {
  const d = store.get().drawer;
  if (!d || d.kind === 'transaction' || d.kind === 'invoice') return;
  if (d.kind === 'case') store.setDrawer({ ...d, panel });
  else if (panel) store.setDrawer({ kind: 'rule', panel });
  else store.closeDrawer();
}

function patchPanel(patch: Partial<PanelState>): void {
  const p = currentPanel();
  if (p) setPanel({ ...p, ...patch });
}

export function panelContent(p: PanelState): unknown {
  return draftFromForm(store.snapshot(), p.form, p.seed);
}

export function isUnsaved(p: PanelState): boolean {
  if (p.summary) return false;
  if (!p.persisted) return true;
  return canonicalJson(panelContent(p)) !== p.persisted.contentJson;
}

/** "Propose reusable knowledge" from a case (§7.2 a, N5). */
export function proposeFromCase(receiptId: string): void {
  const s = store.snapshot();
  const { view } = store.derived();
  const receipt = s.receipts.find((r) => r.id === receiptId);
  if (!receipt) return;
  const c = view.caseById.get(receiptId);
  const prefill = prefillDraftFromCase({ receipt, proposal: c?.proposal ?? null, matches: s.matches, transactions: s.transactions, activeRules: view.activeRules });
  const origin = { kind: 'case' as const, receiptId };
  let panel: PanelState;
  if (prefill.kind === 'alias') {
    const form = formFromDraft(prefill.draft, s);
    panel = basePanel(origin, form, { form, evidence: prefill.draft.evidenceRefs });
  } else if (prefill.kind === 'choose_label') {
    const options = prefill.options.map((o) => ({ observedLabel: o.observedLabel, accountId: o.accountId, accountLabel: o.accountLabel, evidence: o.draft.evidenceRefs }));
    const form = formFromDraft(prefill.options[0]!.draft, s);
    panel = { ...basePanel(origin, form, { form, evidence: options[0]!.evidence }), labelOptions: options };
  } else if (prefill.kind === 'category_only') {
    const form: DraftForm = { ...EMPTY_FORM, type: 'category_preference', merchantName: prefill.merchantName };
    panel = basePanel(origin, form, null);
  } else {
    panel = basePanel(origin, { ...EMPTY_FORM, merchantName: prefill.merchantName ?? '', accountId: defaultAccount() }, null);
  }
  store.setDrawer({ kind: 'case', receiptId, panel });
}

/** "Also suggest a category for …" (a separate category draft). */
export function proposeCategoryFromCase(receiptId: string, merchantName: string): void {
  const form: DraftForm = { ...EMPTY_FORM, type: 'category_preference', merchantName };
  store.setDrawer({ kind: 'case', receiptId, panel: basePanel({ kind: 'case', receiptId }, form, { form, evidence: [{ kind: 'receipt', ref: receiptId }] }) });
}

function defaultAccount(): string {
  const accounts = accountsOf(store.snapshot().transactions);
  return accounts.length === 1 ? accounts[0]!.accountId : '';
}

/** "Propose rule" in the Knowledge Space: the same drawer with the panel as its body (M2). */
export function proposeRule(): void {
  store.setDrawer({ kind: 'rule', panel: basePanel({ kind: 'form' }, { ...EMPTY_FORM, accountId: defaultAccount() }, null) });
}

/**
 * Plain-English rule bar (brief §10, §25 B). A recognised sentence fills the
 * structured form in the same draft panel (nothing is saved until "Preview
 * impact"); an unrecognised one opens the empty form with the reason above
 * it. A refused one opens nothing and its message is shown by the caller.
 */
export function draftFromPhrase(text: string): PhraseResult {
  const result = parseRulePhrase(text);
  if (result.kind === 'refused') return result;
  if (result.kind === 'unrecognised') {
    store.setDrawer({ kind: 'rule', panel: { ...basePanel({ kind: 'form' }, { ...EMPTY_FORM, accountId: defaultAccount() }, null), intro: result.message } });
    return result;
  }
  const f = result.fields;
  const form: DraftForm =
    f.type === 'merchant_alias'
      ? { ...EMPTY_FORM, type: f.type, accountId: defaultAccount(), observedLabel: f.observedLabel, merchantName: f.merchantName, ignoreStoreNumber: f.ignoreStoreNumber === true }
      : f.type === 'category_preference'
        ? { ...EMPTY_FORM, type: f.type, merchantName: f.merchantName, categoryId: f.categoryId }
        : { ...EMPTY_FORM, type: f.type, days: String(f.days) };
  store.setDrawer({ kind: 'rule', panel: { ...basePanel({ kind: 'form' }, form, null), intro: COPY.phraseFrom(text.trim()) } });
  return result;
}

/** Reopen a persisted draft (draft-only card buttons). */
export async function openDraft(ruleId: string, runPreview: boolean): Promise<void> {
  const s = store.snapshot();
  const head = s.ruleHeads.find((h) => h.ruleId === ruleId);
  const v = head?.draftVersion ? s.ruleVersions.find((x) => x.ruleId === ruleId && x.version === head.draftVersion) : undefined;
  if (!head || !v) return;
  const form = formFromDraft(v, s);
  const seed = { form, evidence: v.evidenceRefs };
  // `contentJson` is what is STORED, not what the form regenerates: if they differ
  // (for example stale text), "Preview impact" rewrites the draft through
  // updateDraft first, so the approved version is exactly what the panel showed.
  const panel: PanelState = { ...basePanel({ kind: 'rule', ruleId }, form, seed), persisted: { ruleId, version: v.version, contentJson: canonicalJson(toDraftContent(v)) } };
  store.setDrawer({ kind: 'rule', panel });
  if (runPreview) await previewPanel();
}

export function updateForm(patch: Partial<DraftForm>): void {
  const p = currentPanel();
  if (!p) return;
  patchPanel({ form: { ...p.form, ...patch }, schemaErrors: null, error: null });
}

export function chooseLabel(index: number): void {
  const p = currentPanel();
  const o = p?.labelOptions?.[index];
  if (!p || !o) return;
  const form = { ...p.form, observedLabel: o.observedLabel, accountId: o.accountId };
  patchPanel({ form, seed: { form, evidence: o.evidence }, schemaErrors: null });
}

/** Live checks for the current content (§7.3). */
export function panelValidation(p: PanelState) {
  const s = store.snapshot();
  const { view } = store.derived();
  const content = panelContent(p);
  const preview = p.preview && p.preview.contentJson === canonicalJson(content) ? p.preview.preview : null;
  return validateDraft(content, {
    receipts: s.receipts,
    transactions: s.transactions,
    payables: s.payables,
    activeRules: view.activeRules,
    ruleHeads: s.ruleHeads,
    ruleId: p.persisted?.ruleId ?? p.editOf ?? null,
    preview,
  });
}

/** The preview shown, if it belongs to the current content. */
export function currentPreview(p: PanelState) {
  return p.preview && p.preview.contentJson === canonicalJson(panelContent(p)) ? p.preview.preview : null;
}

/** "Preview impact": the save point (§7.2). */
export async function previewPanel(): Promise<void> {
  const p = currentPanel();
  if (!p || p.busy) return;
  const content = panelContent(p);
  const parsed = RuleDraftSchema.safeParse(content);
  if (!parsed.success) {
    patchPanel({ schemaErrors: panelValidation(p).errors, preview: null });
    return;
  }
  const json = canonicalJson(parsed.data);
  patchPanel({ busy: true, error: null, schemaErrors: null });
  const repo = store.repo();
  try {
    let persisted = p.persisted;
    if (!persisted) {
      const { ruleId, version } = p.editOf ? await editRule(repo, p.editOf, parsed.data) : await createDraft(repo, parsed.data);
      persisted = { ruleId, version, contentJson: json };
    } else if (persisted.contentJson !== json) {
      await updateDraft(repo, persisted.ruleId, persisted.version, parsed.data);
      persisted = { ...persisted, contentJson: json };
    }
    const s = await store.refresh();
    const version = s.ruleVersions.find((x) => x.ruleId === persisted.ruleId && x.version === persisted.version)!;
    const preview = previewImpact(asWorkspaceState(s), { kind: 'activate', version });
    patchPanel({ persisted, preview: { contentJson: json, preview }, busy: false });
  } catch (e) {
    await store.refresh();
    patchPanel({ busy: false, error: errorMessage(e, 'the rule draft') });
  }
}

/** "Activate rule" (§7.5). The summary is shown in the drawer (M2); the announcement fires now. */
export async function activatePanel(): Promise<void> {
  const p = currentPanel();
  const preview = p ? currentPreview(p) : null;
  if (!p || !p.persisted || !preview || p.busy) return;
  patchPanel({ busy: true, error: null });
  try {
    const { ruleId, version } = p.persisted;
    const { preview: recorded } = await activateRule(store.repo(), ruleId, version, preview.stateFingerprint);
    const s = await store.refresh();
    const after = deriveWorkspaceView(asWorkspaceState(s));
    const type = s.ruleVersions.find((x) => x.ruleId === ruleId && x.version === version)!.type;
    const summary = activationSummary(type, recorded, after.groups.needs_decision);
    const newlyReady = recorded.pendingChanges.filter((c) => c.before.group !== 'ready' && c.after.group === 'ready').map((c) => c.caseId);
    patchPanel({
      busy: false,
      summary: { ruleId, version, type, ...summary, newlyReady, affected: recorded.pendingChanges.map((c) => c.caseId) },
    });
    store.announce(`${COPY.activated(formatRuleRef({ ruleId, version }))} ${summary.changed.join(' ')}`);
  } catch (e) {
    await store.refresh();
    patchPanel({ busy: false, error: errorMessage(e, 'activating the rule') });
  }
}

/** Close or go back; unsaved content asks first (§7.2). */
export function requestLeavePanel(mode: 'close' | 'back'): void {
  const p = currentPanel();
  if (p && isUnsaved(p)) {
    patchPanel({ confirmDiscard: mode });
    return;
  }
  leavePanel(mode);
}

export function leavePanel(mode: 'close' | 'back'): void {
  const d = store.get().drawer;
  if (mode === 'back' && d?.kind === 'case') {
    const summary = d.panel?.summary;
    store.setDrawer({ ...d, panel: null });
    if (summary) store.startHighlight(summary.ruleId, summary.version, summary.affected, summary.newlyReady);
    return;
  }
  store.closeDrawer();
}

export function keepEditing(): void {
  patchPanel({ confirmDiscard: null });
}

/** "Discard draft": unsaved panels write nothing; persisted drafts call discardDraft. */
export async function discardPanel(): Promise<void> {
  const p = currentPanel();
  if (!p) return;
  if (p.persisted) {
    const r = await store.run('discarding the draft', (repo) => discardDraft(repo, p.persisted!.ruleId));
    if (!r.ok) {
      patchPanel({ error: r.message });
      return;
    }
  }
  leavePanel(p.origin.kind === 'case' ? 'back' : 'close');
}
