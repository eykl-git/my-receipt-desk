/**
 * "Import knowledge JSON" (design §12.2, N9): one unit of work writes every
 * planned draft (fresh IDs from the counters, version 1, `draft_only`) plus
 * `knowledge.imported` and one `rule.draft_created` per draft. Nothing is
 * activated. The UI always runs this against My files.
 */
import { ValidationError } from '../../domain/errors';
import { planKnowledgeImport } from '../../domain/knowledge/exportJson';
import { ruleKindForType } from '../../domain/knowledge/schema';
import { ruleId as toRuleId } from '../../domain/ids';
import type { StoredRuleVersion } from '../../domain/schemas';
import type { Repository } from '../repository';
import { asWorkspaceState, runCommand } from './context';

export interface KnowledgeImportResult {
  created: string[];
  skipped: Array<{ source: string; message: string }>;
}

export function importKnowledge(repo: Repository, fileName: string, text: string): Promise<KnowledgeImportResult> {
  return runCommand(repo, (c) => {
    // Re-planned inside the write from the current state, so IDs and checks match what is stored.
    const plan = planKnowledgeImport(text, asWorkspaceState(c.state));
    if (!plan.ok) throw new ValidationError('KNOWLEDGE_INVALID', plan.issues.join(' '));
    if (plan.drafts.length === 0) {
      c.markNoop();
      return { created: [], skipped: plan.skipped };
    }
    const created: string[] = [];
    for (const { draft, source } of plan.drafts) {
      const kind = ruleKindForType(draft.type);
      const id = toRuleId(kind, c.next(`rule:${kind}`));
      created.push(id);
      c.put('rule_heads', {
        schemaVersion: 1,
        workspaceId: c.workspaceId,
        ruleId: id,
        type: draft.type,
        status: 'draft_only',
        currentVersion: 1,
        activeVersion: null,
        lastApprovedVersion: null,
        draftVersion: 1,
        updatedAt: c.at,
      });
      c.put('rule_versions', { ...draft, ruleId: id, version: 1, ownerId: 'local-owner', createdAt: c.at, schemaVersion: 1, workspaceId: c.workspaceId } as StoredRuleVersion);
      c.audit({
        action: 'rule.draft_created',
        affected: [{ kind: 'rule', id }],
        evidenceRefs: draft.evidenceRefs,
        ruleRefs: [{ ruleId: id, version: 1 }],
        after: { importedFrom: source },
      });
    }
    c.audit({
      action: 'knowledge.imported',
      affected: created.map((id) => ({ kind: 'rule', id })),
      evidenceRefs: plan.drafts.map((d) => d.draft.evidenceRefs[0]!),
      ruleRefs: created.map((id) => ({ ruleId: id, version: 1 })),
      after: { fileName, created, skipped: plan.skipped.map((s) => s.source) },
    });
    return { created, skipped: plan.skipped };
  });
}
