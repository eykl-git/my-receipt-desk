/**
 * Knowledge lifecycle commands (design §7.2, §7.5, §7.6). Drafts are saved at
 * the first "Preview impact"; activation re-validates and re-fingerprints the
 * state inside its unit of work, so a stale or blocked draft never activates.
 * No command here writes a receipt, match or ledger record.
 */
import { ValidationError } from '../../domain/errors';
import { decisionId, ruleId as toRuleId } from '../../domain/ids';
import { recheckRecorded } from '../../domain/knowledge/recheck';
import { LEDGER_MESSAGES, voidInContext } from './ledger';
import { LIMITS } from '../../domain/limits';
import { evaluateWorkspace } from '../../domain/matching/evaluate';
import { canonicalJson } from '../../domain/matching/fingerprint';
import { previewImpact, stateFingerprint, type ImpactPreview } from '../../domain/knowledge/preview';
import { refOf } from '../../domain/knowledge/resolve';
import { RuleDraftSchema, ruleKindForType, toDraftContent, type RuleDraft, type RuleHead } from '../../domain/knowledge/schema';
import { validateDraft, validateVersion, type Finding } from '../../domain/knowledge/validate';
import type { StoredRuleVersion } from '../../domain/schemas';
import type { Repository } from '../repository';
import { runCommand, type CommandContext } from './context';

function parseDraftOrThrow(content: unknown): RuleDraft {
  const parsed = RuleDraftSchema.safeParse(content);
  if (parsed.success) return parsed.data;
  const v = validateDraft(content, { receipts: [], transactions: [], payables: [], activeRules: [], ruleHeads: [] });
  throw new ValidationError(v.errors[0]?.code ?? 'INVALID_SCHEMA', v.errors.map((f) => f.message).join(' '), v.errors);
}

function headOf(c: CommandContext, ruleId: string): RuleHead {
  const head = c.state.ruleHeads.find((h) => h.ruleId === ruleId);
  if (!head) throw new ValidationError('UNKNOWN_RULE', `${ruleId} does not exist.`);
  return head;
}

function versionOf(c: CommandContext, ruleId: string, version: number): StoredRuleVersion {
  const v = c.state.ruleVersions.find((x) => x.ruleId === ruleId && x.version === version);
  if (!v) throw new ValidationError('UNKNOWN_RULE', `${ruleId} v${version} does not exist.`);
  return v;
}

function blocked(errors: readonly Finding[]): ValidationError {
  return new ValidationError(errors[0]?.code ?? 'INVALID_SCHEMA', errors.map((f) => f.message).join(' '), errors);
}

/** First "Preview impact" of an unsaved draft (§7.2): allocates the rule ID and writes v1. */
export async function createDraft(repo: Repository, content: unknown): Promise<{ ruleId: string; version: number }> {
  const draft = parseDraftOrThrow(content);
  return runCommand(repo, (c) => {
    if (draft.type === 'posting_window' && c.state.ruleHeads.some((h) => h.type === 'posting_window' && h.status !== 'discarded')) {
      throw new ValidationError('CONFLICT', 'A matching-policy rule already exists here. Edit it instead.');
    }
    if (c.state.ruleHeads.length >= LIMITS.workspaceMaxRules) {
      throw new ValidationError('LIMIT', `A workspace can hold at most ${LIMITS.workspaceMaxRules} rules.`);
    }
    const kind = ruleKindForType(draft.type);
    const ruleId = toRuleId(kind, c.next(`rule:${kind}`));
    c.put('rule_heads', {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      ruleId,
      type: draft.type,
      status: 'draft_only',
      currentVersion: 1,
      activeVersion: null,
      lastApprovedVersion: null,
      draftVersion: 1,
      updatedAt: c.at,
    });
    c.put('rule_versions', { ...draft, ruleId, version: 1, ownerId: 'local-owner', createdAt: c.at, schemaVersion: 1, workspaceId: c.workspaceId } as StoredRuleVersion);
    c.audit({
      action: 'rule.draft_created',
      affected: [{ kind: 'rule', id: ruleId }],
      evidenceRefs: draft.evidenceRefs,
      ruleRefs: [{ ruleId, version: 1 }],
      after: draft,
    });
    return { ruleId, version: 1 };
  });
}

/** Later "Preview impact" with changed content (§7.2). Unchanged content writes nothing. */
export async function updateDraft(repo: Repository, ruleId: string, version: number, content: unknown): Promise<{ changed: boolean }> {
  const draft = parseDraftOrThrow(content);
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    const v = versionOf(c, ruleId, version);
    if (head.draftVersion !== version || v.approvedAt !== undefined || v.discardedAt !== undefined) {
      throw new ValidationError('NOT_A_DRAFT', `${ruleId} v${version} is not an open draft.`);
    }
    if (draft.type !== v.type) throw new ValidationError('INVALID_SCHEMA', 'A draft can’t change its rule type.');
    const before = toDraftContent(v);
    if (canonicalJson(before) === canonicalJson(draft)) {
      c.markNoop();
      return { changed: false };
    }
    c.put('rule_versions', { ...v, ...draft } as StoredRuleVersion);
    c.put('rule_heads', { ...head, updatedAt: c.at });
    c.audit({
      action: 'rule.draft_updated',
      affected: [{ kind: 'rule', id: ruleId }],
      evidenceRefs: draft.evidenceRefs,
      ruleRefs: [{ ruleId, version }],
      before,
      after: draft,
    });
    return { changed: true };
  });
}

export const RULE_MESSAGES = Object.freeze({
  draftOpen: (ruleId: string, v: number) => `${ruleId} already has an open draft (v${v}). Open it instead.`,
  notEditable: (ruleId: string) => `${ruleId} can only be edited while it is active or suspended.`,
  typeChange: 'A new version can’t change its rule type.',
  notListed: 'This entry no longer needs a re-check.',
});

/**
 * "Edit" on an active or suspended rule (§7.2 e, REQ-8.7): the first preview
 * writes version n+1 as a draft. The active version keeps applying until the
 * draft is activated; earlier versions stay readable and immutable.
 */
export async function editRule(repo: Repository, ruleId: string, content: unknown): Promise<{ ruleId: string; version: number }> {
  const draft = parseDraftOrThrow(content);
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    if (head.status !== 'active' && head.status !== 'suspended') throw new ValidationError('NOT_EDITABLE', RULE_MESSAGES.notEditable(ruleId));
    if (head.draftVersion !== null) throw new ValidationError('DRAFT_OPEN', RULE_MESSAGES.draftOpen(ruleId, head.draftVersion));
    if (draft.type !== head.type) throw new ValidationError('INVALID_SCHEMA', RULE_MESSAGES.typeChange);
    const version = head.currentVersion + 1;
    c.put('rule_versions', { ...draft, ruleId, version, ownerId: 'local-owner', createdAt: c.at, schemaVersion: 1, workspaceId: c.workspaceId } as StoredRuleVersion);
    c.put('rule_heads', { ...head, currentVersion: version, draftVersion: version, updatedAt: c.at });
    c.audit({
      action: 'rule.draft_created',
      affected: [{ kind: 'rule', id: ruleId }],
      evidenceRefs: draft.evidenceRefs,
      ruleRefs: [{ ruleId, version }],
      after: draft,
    });
    return { ruleId, version };
  });
}

/** "Keep as recorded" in "Re-check recorded entries" (§7.7): a review decision plus its audit event. */
export function recheckKeep(repo: Repository, ledgerEntryId: string): Promise<{ decisionId: string }> {
  return runCommand(repo, (c) => {
    const item = recheckRecorded(c.workspaceState()).find((i) => i.ledgerEntryId === ledgerEntryId);
    if (!item) throw new ValidationError('NOT_LISTED', RULE_MESSAGES.notListed);
    const id = decisionId(c.next('decision'));
    c.put('decisions', {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id,
      kind: 'historical_recheck',
      subjectIds: [ledgerEntryId, item.receiptId],
      choice: 'keep',
      reason: null,
      at: c.at,
    });
    c.audit({
      action: 'recheck.kept',
      affected: [{ kind: 'ledger', id: ledgerEntryId }, { kind: 'receipt', id: item.receiptId }],
      evidenceRefs: [{ kind: 'ledger', ref: ledgerEntryId }, { kind: 'match', ref: item.matchId }],
      ruleRefs: item.staleRefs.map((s) => s.ref),
      after: { decisionId: id, choice: 'keep' },
    });
    return { decisionId: id };
  });
}

/** "Void and return to review" in the re-check (§7.7): the same as "Void entry", plus the review decision. */
export function recheckVoid(repo: Repository, ledgerEntryId: string, reason: string): Promise<void> {
  const text = reason.trim();
  if (text.length < LIMITS.reasonMinChars || text.length > LIMITS.reasonMaxChars) {
    return Promise.reject(new ValidationError('REASON_LENGTH', LEDGER_MESSAGES.reasonLength));
  }
  return runCommand(repo, (c) => {
    const item = recheckRecorded(c.workspaceState()).find((i) => i.ledgerEntryId === ledgerEntryId);
    if (!item) throw new ValidationError('NOT_LISTED', RULE_MESSAGES.notListed);
    const entry = c.state.ledger.find((e) => e.id === ledgerEntryId && e.status === 'recorded');
    if (!entry) throw new ValidationError('NOT_RECORDED', LEDGER_MESSAGES.notRecorded);
    c.put('decisions', {
      schemaVersion: 1,
      workspaceId: c.workspaceId,
      id: decisionId(c.next('decision')),
      kind: 'historical_recheck',
      subjectIds: [ledgerEntryId, item.receiptId],
      choice: 'void',
      reason: text,
      at: c.at,
    });
    voidInContext(c, entry, text);
  });
}

/** "Discard draft" on a persisted draft (§7.2). The version stays readable in history. */
export function discardDraft(repo: Repository, ruleId: string): Promise<void> {
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    if (head.draftVersion === null) throw new ValidationError('NOT_A_DRAFT', `${ruleId} has no open draft.`);
    const v = versionOf(c, ruleId, head.draftVersion);
    c.put('rule_versions', { ...v, discardedAt: c.at });
    c.put('rule_heads', {
      ...head,
      draftVersion: null,
      status: head.lastApprovedVersion === null ? 'discarded' : head.status,
      updatedAt: c.at,
    });
    c.audit({ action: 'rule.draft_discarded', affected: [{ kind: 'rule', id: ruleId }], ruleRefs: [refOf(v)] });
  });
}

/** "Activate rule" (§7.5). `previewFingerprint` is the fingerprint of the preview the user saw. */
export function activateRule(repo: Repository, ruleId: string, version: number, previewFingerprint: string | null): Promise<{ preview: ImpactPreview }> {
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    const v = versionOf(c, ruleId, version);
    if (head.draftVersion !== version || v.approvedAt !== undefined || v.discardedAt !== undefined) {
      throw new ValidationError('NOT_A_DRAFT', `${ruleId} v${version} is not an open draft.`);
    }
    const state = c.workspaceState();
    const current = c.activeRules();
    const validation = validateVersion(v, {
      receipts: state.receipts,
      transactions: state.transactions,
      payables: state.payables,
      activeRules: current,
      ruleHeads: state.ruleHeads,
      ruleId,
      activation: {
        preview: previewFingerprint === null ? null : { stateFingerprint: previewFingerprint },
        currentFingerprint: stateFingerprint(state, toDraftContent(v)),
      },
    });
    if (validation.errors.length > 0) throw blocked(validation.errors);
    const preview = previewImpact(state, { kind: 'activate', version: v });

    // Superseding a version that pending proposals used invalidates them.
    const superseded = head.activeVersion;
    if (superseded !== null) {
      const affected = [...evaluateWorkspace(c.evaluationInput(current)).proposals.values()]
        .filter((p) => p.ruleRefs.some((r) => r.ruleId === ruleId && r.version === superseded))
        .map((p) => p.subject.id);
      if (affected.length > 0) {
        c.audit({ action: 'proposals.invalidated', actor: 'system', affected: [{ kind: 'rule', id: ruleId }, ...affected.map((id) => ({ kind: 'receipt', id }))], ruleRefs: [{ ruleId, version: superseded }] });
      }
    }
    c.put('rule_versions', { ...v, approvedAt: c.at, approvedBy: 'local-owner' });
    c.put('rule_heads', { ...head, status: 'active', activeVersion: version, lastApprovedVersion: version, draftVersion: null, updatedAt: c.at });
    c.audit({
      action: 'rule.activated',
      affected: [{ kind: 'rule', id: ruleId }, ...preview.pendingChanges.map((p) => ({ kind: 'receipt', id: p.caseId }))],
      evidenceRefs: v.evidenceRefs,
      ruleRefs: [{ ruleId, version }],
      after: preview.pendingChanges,
    });
    return { preview };
  });
}

/** "Suspend rule" (§7.6): keeps history and recorded entries; pending proposals that used it are invalidated. */
export function suspendRule(repo: Repository, ruleId: string, reason: string): Promise<{ affected: string[] }> {
  const text = reason.trim();
  if (text.length < LIMITS.reasonMinChars || text.length > LIMITS.reasonMaxChars) {
    return Promise.reject(new ValidationError('REASON_LENGTH', `Reason must be ${LIMITS.reasonMinChars}–${LIMITS.reasonMaxChars} characters.`));
  }
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    if (head.status !== 'active' || head.activeVersion === null) throw new ValidationError('NOT_ACTIVE', `${ruleId} is not active.`);
    const ref = { ruleId, version: head.activeVersion };
    const affected = [...evaluateWorkspace(c.evaluationInput()).proposals.values()]
      .filter((p) => p.ruleRefs.some((r) => r.ruleId === ruleId))
      .map((p) => p.subject.id)
      .sort();
    c.put('rule_heads', { ...head, status: 'suspended', activeVersion: null, updatedAt: c.at });
    c.audit({ action: 'rule.suspended', affected: [{ kind: 'rule', id: ruleId }], ruleRefs: [ref], reason: text });
    // The rule is always named, so the event has an affected ID even when no pending proposal used it.
    c.audit({ action: 'proposals.invalidated', actor: 'system', affected: [{ kind: 'rule', id: ruleId }, ...affected.map((id) => ({ kind: 'receipt', id }))], ruleRefs: [ref] });
    return { affected };
  });
}

/** "Reactivate" (§7.6): re-validates against current rules with a fresh reactivation preview; no new version. */
export function reactivateRule(repo: Repository, ruleId: string, previewFingerprint: string | null): Promise<void> {
  return runCommand(repo, (c) => {
    const head = headOf(c, ruleId);
    if (head.status !== 'suspended' || head.lastApprovedVersion === null) throw new ValidationError('NOT_SUSPENDED', `${ruleId} is not suspended.`);
    const v = versionOf(c, ruleId, head.lastApprovedVersion);
    const state = c.workspaceState();
    const validation = validateVersion(v, {
      receipts: state.receipts,
      transactions: state.transactions,
      payables: state.payables,
      activeRules: c.activeRules(),
      ruleHeads: state.ruleHeads,
      ruleId,
      activation: {
        preview: previewFingerprint === null ? null : { stateFingerprint: previewFingerprint },
        currentFingerprint: stateFingerprint(state, null),
      },
    });
    if (validation.errors.length > 0) throw blocked(validation.errors);
    c.put('rule_heads', { ...head, status: 'active', activeVersion: v.version, updatedAt: c.at });
    c.audit({ action: 'rule.reactivated', affected: [{ kind: 'rule', id: ruleId }], evidenceRefs: v.evidenceRefs, ruleRefs: [refOf(v)] });
  });
}
