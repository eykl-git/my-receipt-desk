/** Pure audit event builder (design §4.1). Persistence assigns seq/id and writes it atomically. */
import { auditId } from '../ids';
import type { EvidenceRef, RuleRef, WorkspaceId } from '../primitives';
import { AuditEventSchema, type AuditAction, type AuditEvent } from '../schemas';

export interface AuditEventInput {
  workspaceId: WorkspaceId;
  seq: number;
  at: string;
  actor?: 'local-owner' | 'system';
  action: AuditAction;
  affected: Array<{ kind: string; id: string }>;
  before?: unknown;
  after?: unknown;
  evidenceRefs?: EvidenceRef[];
  ruleRefs?: RuleRef[];
  reason?: string | null;
}

/** Builds and validates an event; throws a ZodError for an invalid event. */
export function buildAuditEvent(input: AuditEventInput): AuditEvent {
  return AuditEventSchema.parse({
    schemaVersion: 1,
    workspaceId: input.workspaceId,
    id: auditId(input.seq),
    seq: input.seq,
    at: input.at,
    actor: input.actor ?? 'local-owner',
    action: input.action,
    affected: input.affected,
    before: input.before ?? null,
    after: input.after ?? null,
    evidenceRefs: input.evidenceRefs ?? [],
    ruleRefs: input.ruleRefs ?? [],
    reason: input.reason ?? null,
  });
}
