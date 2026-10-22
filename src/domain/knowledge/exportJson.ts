/**
 * Knowledge JSON export / import (design §12.2, review-3 N9) and the generated
 * KNOWLEDGE.md. The JSON rule records are the only executable source of
 * truth; KNOWLEDGE.md is generated and never parsed (REQ-8.11).
 *
 * Import never activates anything: each rule in the file becomes one new
 * draft with a fresh ID, version 1 and `imported` provenance evidence, and is
 * then validated against THIS workspace like any other draft.
 */
import { z } from 'zod';
import { LIMITS } from '../limits';
import { formatRuleRef, type EvidenceRef } from '../primitives';
import type { WorkspaceState } from './preview';
import { RULE_TYPES, RuleDraftSchema, RuleStatusSchema, RuleVersionSchema, toDraftContent, type RuleDraft, type RuleVersion } from './schema';
import { validateDraft, type Finding } from './validate';
import { activeRulesFrom } from './resolve';
import { withGeneratedText } from './plainEnglish';

export const KNOWLEDGE_FORMAT = 'my-receipt-desk/knowledge';

const ExportHeadSchema = z.strictObject({
  ruleId: z.string().min(1).max(40),
  type: z.enum(RULE_TYPES),
  status: RuleStatusSchema,
  activeVersion: z.number().int().min(1).nullable(),
  lastApprovedVersion: z.number().int().min(1).nullable(),
});

export const KnowledgeFileSchema = z.strictObject({
  format: z.literal(KNOWLEDGE_FORMAT),
  schemaVersion: z.literal(1),
  exportedAt: z.string().min(1).max(40),
  workspace: z.enum(['demo', 'personal']),
  rules: z
    .array(z.strictObject({ head: ExportHeadSchema, versions: z.array(RuleVersionSchema).min(1).max(100) }))
    .max(LIMITS.knowledgeJsonMaxRules),
});
export type KnowledgeFile = z.infer<typeof KnowledgeFileSchema>;

/** Rules with at least one approved version; only approved versions are exported (drafts are left out). */
export function exportKnowledge(state: WorkspaceState, workspace: 'demo' | 'personal', exportedAt: string): KnowledgeFile {
  const rules = [...state.ruleHeads]
    .sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1))
    .flatMap((h) => {
      const versions = state.ruleVersions
        .filter((v) => v.ruleId === h.ruleId && v.approvedAt !== undefined)
        .sort((a, b) => a.version - b.version)
        .map((v) => RuleVersionSchema.parse(stripStored(v)));
      if (versions.length === 0) return [];
      return [{ head: { ruleId: h.ruleId, type: h.type, status: h.status, activeVersion: h.activeVersion, lastApprovedVersion: h.lastApprovedVersion }, versions }];
    });
  return { format: KNOWLEDGE_FORMAT, schemaVersion: 1, exportedAt, workspace, rules };
}

function stripStored(v: RuleVersion): RuleVersion {
  const copy = { ...(v as RuleVersion & { schemaVersion?: number; workspaceId?: string }) };
  delete copy.schemaVersion;
  delete copy.workspaceId;
  return copy;
}

export const KNOWLEDGE_IMPORT_MESSAGES = Object.freeze({
  tooLarge: `The file is larger than ${LIMITS.knowledgeJsonMaxBytes / (1024 * 1024)} MB.`,
  notJson: 'This file isn’t valid JSON.',
  policyExists: 'A matching-policy rule already exists here. Edit it instead.',
  tooMany: `A workspace can hold at most ${LIMITS.workspaceMaxRules} rules.`,
});

export interface ImportedDraftPlan {
  /** e.g. "K-ALIAS-0007 v2" from the other export (provenance text only, never resolved). */
  source: string;
  draft: RuleDraft;
  findings: Finding[];
}

export type KnowledgeImportPlan =
  | { ok: false; issues: string[] }
  | { ok: true; drafts: ImportedDraftPlan[]; skipped: Array<{ source: string; message: string }> };

/** Validate a whole knowledge file and plan one draft per rule (§12.2). Pure; writes nothing. */
export function planKnowledgeImport(text: string, state: WorkspaceState): KnowledgeImportPlan {
  if (new TextEncoder().encode(text).length > LIMITS.knowledgeJsonMaxBytes) return { ok: false, issues: [KNOWLEDGE_IMPORT_MESSAGES.tooLarge] };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, issues: [KNOWLEDGE_IMPORT_MESSAGES.notJson] };
  }
  const parsed = KnowledgeFileSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.slice(0, 20).map((i) => `${i.path.map(String).join('.') || 'file'}: ${i.message}`) };
  }
  if (state.ruleHeads.length + parsed.data.rules.length > LIMITS.workspaceMaxRules) return { ok: false, issues: [KNOWLEDGE_IMPORT_MESSAGES.tooMany] };

  const activeRules = activeRulesFrom(state.ruleHeads, state.ruleVersions);
  let policyTaken = state.ruleHeads.some((h) => h.type === 'posting_window' && h.status !== 'discarded');
  const drafts: ImportedDraftPlan[] = [];
  const skipped: Array<{ source: string; message: string }> = [];
  for (const rule of parsed.data.rules) {
    const wanted = rule.head.lastApprovedVersion;
    const chosen = rule.versions.find((v) => v.version === wanted) ?? [...rule.versions].sort((a, b) => b.version - a.version)[0]!;
    const source = formatRuleRef({ ruleId: rule.head.ruleId, version: chosen.version });
    if (chosen.type === 'posting_window') {
      if (policyTaken) {
        skipped.push({ source, message: KNOWLEDGE_IMPORT_MESSAGES.policyExists });
        continue;
      }
      policyTaken = true;
    }
    const evidenceRefs: EvidenceRef[] = [{ kind: 'imported', ref: source }];
    // The meaning and exclusions are generated here from the structured fields (§7.1); the file's text is untrusted.
    const draft = RuleDraftSchema.parse(withGeneratedText({ ...toDraftContent(chosen), evidenceRefs }, state));
    const findings = validateDraft(draft, {
      receipts: state.receipts,
      transactions: state.transactions,
      payables: state.payables,
      activeRules,
      ruleHeads: state.ruleHeads,
    }).errors;
    drafts.push({ source, draft, findings });
  }
  return { ok: true, drafts, skipped };
}

export const KNOWLEDGE_MD_HEADER = 'Generated from your approved rules. Editing this file changes nothing in the app.';

/** KNOWLEDGE.md: active and suspended rules (their last approved version). Generated only; never parsed. */
export function knowledgeMarkdown(state: WorkspaceState, accountLabels: ReadonlyMap<string, string>): string {
  const lines = ['# KNOWLEDGE.md', '', KNOWLEDGE_MD_HEADER, ''];
  const heads = [...state.ruleHeads].filter((h) => (h.status === 'active' || h.status === 'suspended') && h.lastApprovedVersion !== null).sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
  if (heads.length === 0) lines.push('No approved rules yet.', '');
  for (const h of heads) {
    const v = state.ruleVersions.find((x) => x.ruleId === h.ruleId && x.version === h.lastApprovedVersion);
    if (!v) continue;
    const scope = v.type === 'merchant_alias' ? `Card: ${accountLabels.get(v.scope.accountId ?? '') ?? v.scope.accountId ?? ''}` : 'This workspace';
    lines.push(`## ${formatRuleRef(v)} (${h.status === 'active' ? 'Active' : 'Suspended'})`, '', v.plainEnglish, '', `- Scope: ${scope}`, `- Approved: ${v.approvedAt ?? ''}`, '');
  }
  return lines.join('\n');
}
