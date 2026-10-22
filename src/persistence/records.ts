/**
 * Record rules shared by both repositories (design §4, §11.1): primary keys,
 * zod schemas checked on every write, write-once rule versions, unique
 * secondary indexes and the snapshot built from the stores. Keeping these in
 * one place means MemoryRepository and IdbRepository produce identical
 * snapshots for identical writes (T20).
 */
import type { z } from 'zod';
import {
  AuditEventSchema,
  ConfirmedMatchSchema,
  DemoStateSchema,
  LedgerEntrySchema,
  MetaRecordSchema,
  PayableSchema,
  ReceiptSchema,
  ReviewDecisionSchema,
  RuleHeadSchema,
  SourceDocumentSchema,
  StatementTransactionSchema,
  StoredRuleVersionSchema,
  type DemoState,
  type MetaRecord,
  type StoredRuleVersion,
  type WorkspaceCurrency,
  type WorkspaceId,
} from '../domain/schemas';
import { canonicalJson } from '../domain/matching/fingerprint';
import { EMPTY_DEMO_STATE, type StoreName, type StoreRecords, type WorkspaceSnapshot } from './repository';

export const SCHEMAS: Partial<Record<StoreName, z.ZodType>> = {
  meta: MetaRecordSchema,
  source_documents: SourceDocumentSchema,
  receipts: ReceiptSchema,
  transactions: StatementTransactionSchema,
  payables: PayableSchema,
  matches: ConfirmedMatchSchema,
  ledger: LedgerEntrySchema,
  rule_heads: RuleHeadSchema,
  rule_versions: StoredRuleVersionSchema,
  decisions: ReviewDecisionSchema,
  audit: AuditEventSchema,
};

/** Primary key of a record as a string (rule versions: `ruleId#version`). */
export function keyOf<S extends StoreName>(store: S, record: StoreRecords[S]): string {
  const r = record as unknown as Record<string, unknown>;
  switch (store) {
    case 'meta':
    case 'files':
      return String(r.key);
    case 'rule_heads':
      return String(r.ruleId);
    case 'rule_versions':
      return `${String(r.ruleId)}#${String(r.version)}`;
    default:
      return String(r.id);
  }
}

/** Unique secondary indexes (design §11.1). Records without the key are not indexed. */
export const UNIQUE_INDEXES: ReadonlyArray<{ store: StoreName; name: string; keyPath: string; key: (r: Record<string, unknown>) => unknown }> = [
  { store: 'source_documents', name: 'bySha', keyPath: 'sha256', key: (r) => r.sha256 },
  { store: 'transactions', name: 'bySourceRowId', keyPath: 'sourceRowId', key: (r) => r.sourceRowId },
  { store: 'matches', name: 'byActiveTxn', keyPath: 'activeTxnKey', key: (r) => r.activeTxnKey },
  { store: 'matches', name: 'byActiveSubject', keyPath: 'activeSubjectKey', key: (r) => r.activeSubjectKey },
  { store: 'ledger', name: 'byActiveIdentity', keyPath: 'activeIdentityKey', key: (r) => r.activeIdentityKey },
  { store: 'audit', name: 'bySeq', keyPath: 'seq', key: (r) => r.seq },
];

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConstraintError';
  }
}

const ONCE_FIELDS = ['approvedAt', 'approvedBy', 'discardedAt'] as const;

/** Content of an approved or discarded version is frozen; once-fields are written once (§4). */
export function checkRuleVersionWrite(existing: StoredRuleVersion | undefined, next: StoredRuleVersion): void {
  if (!existing) return;
  const frozen = existing.approvedAt !== undefined || existing.discardedAt !== undefined;
  for (const f of ONCE_FIELDS) {
    if (existing[f] !== undefined && existing[f] !== next[f]) throw new ConstraintError(`${next.ruleId} v${next.version}: ${f} is already set.`);
  }
  if (!frozen) return;
  const strip = (v: StoredRuleVersion) => {
    const copy: Record<string, unknown> = { ...v };
    for (const f of ONCE_FIELDS) delete copy[f];
    return canonicalJson(copy);
  };
  if (strip(existing) !== strip(next)) throw new ConstraintError(`${next.ruleId} v${next.version} is approved or discarded and can’t be changed.`);
}

/** Records per store (files excluded: bytes are read on demand). */
export type StoreLists = { [S in Exclude<StoreName, 'files'>]: readonly StoreRecords[S][] };

function sortedByKey<S extends StoreName>(store: S, records: readonly StoreRecords[S][]): StoreRecords[S][] {
  return [...records]
    .map((r) => [keyOf(store, r), r] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, r]) => structuredClone(r));
}

export const DEFAULT_WORKSPACE_CURRENCY: WorkspaceCurrency = 'HKD';

/** The workspace snapshot from its records (arrays sorted by primary key; audit by seq). */
export function buildSnapshot(workspaceId: WorkspaceId, lists: StoreLists): WorkspaceSnapshot {
  const meta = new Map<string, MetaRecord>(lists.meta.map((m) => [m.key, m]));
  const counters = meta.get('counters');
  const demo = meta.get('demoState');
  const schema = meta.get('schema');
  const settings = meta.get('settings');
  return {
    workspaceId,
    schemaVersion: schema && schema.key === 'schema' ? schema.version : 1,
    counters: counters && counters.key === 'counters' ? { ...counters.values } : {},
    demoState: demo && demo.key === 'demoState' ? DemoStateSchema.parse(structuredClone(demo.value)) : (structuredClone(EMPTY_DEMO_STATE) as DemoState),
    currency: settings && settings.key === 'settings' ? settings.currency : DEFAULT_WORKSPACE_CURRENCY,
    sourceDocuments: sortedByKey('source_documents', lists.source_documents),
    receipts: sortedByKey('receipts', lists.receipts),
    transactions: sortedByKey('transactions', lists.transactions),
    payables: sortedByKey('payables', lists.payables),
    matches: sortedByKey('matches', lists.matches),
    ledger: sortedByKey('ledger', lists.ledger),
    ruleHeads: sortedByKey('rule_heads', lists.rule_heads),
    ruleVersions: sortedByKey('rule_versions', lists.rule_versions),
    decisions: sortedByKey('decisions', lists.decisions),
    audit: sortedByKey('audit', lists.audit).sort((a, b) => a.seq - b.seq),
  };
}
