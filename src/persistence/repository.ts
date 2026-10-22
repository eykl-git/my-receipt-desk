/**
 * Repository interface (design §2, §11.3). Every command runs as one unit of
 * work: it reads the workspace state, runs pure domain code synchronously and
 * buffers its writes; the writes are applied all together or not at all.
 * S2 ships MemoryRepository; S4 adds IdbRepository behind the same interface.
 */
import type {
  AuditEvent,
  ConfirmedMatch,
  DemoState,
  LedgerEntry,
  MetaRecord,
  Payable,
  Receipt,
  ReviewDecision,
  RuleHead,
  SourceDocument,
  StatementTransaction,
  StoredRuleVersion,
  WorkspaceCurrency,
  WorkspaceId,
} from '../domain/schemas';

export const STORE_NAMES = [
  'meta',
  'files',
  'source_documents',
  'receipts',
  'transactions',
  'payables',
  'matches',
  'ledger',
  'rule_heads',
  'rule_versions',
  'decisions',
  'audit',
] as const;
export type StoreName = (typeof STORE_NAMES)[number];

export interface StoredFile {
  key: string;
  blob: Blob;
}

export interface StoreRecords {
  meta: MetaRecord;
  files: StoredFile;
  source_documents: SourceDocument;
  receipts: Receipt;
  transactions: StatementTransaction;
  payables: Payable;
  matches: ConfirmedMatch;
  ledger: LedgerEntry;
  rule_heads: RuleHead;
  rule_versions: StoredRuleVersion;
  decisions: ReviewDecision;
  audit: AuditEvent;
}

/** Everything a workspace holds except file bytes. Arrays are sorted by key. */
export interface WorkspaceSnapshot {
  readonly workspaceId: WorkspaceId;
  readonly schemaVersion: number;
  readonly counters: Readonly<Record<string, number>>;
  readonly demoState: DemoState;
  /** Workspace currency (REQ-20). The demo is always HKD. */
  readonly currency: WorkspaceCurrency;
  readonly sourceDocuments: readonly SourceDocument[];
  readonly receipts: readonly Receipt[];
  readonly transactions: readonly StatementTransaction[];
  readonly payables: readonly Payable[];
  readonly matches: readonly ConfirmedMatch[];
  readonly ledger: readonly LedgerEntry[];
  readonly ruleHeads: readonly RuleHead[];
  readonly ruleVersions: readonly StoredRuleVersion[];
  readonly decisions: readonly ReviewDecision[];
  readonly audit: readonly AuditEvent[];
}

export interface Writer {
  put<S extends StoreName>(store: S, record: StoreRecords[S]): void;
}

/** A stored record that failed its schema on load (excluded from evaluation, §11.5). */
export interface StorageProblem {
  store: StoreName;
  id: string;
  error: string;
}

export interface Repository {
  readonly kind: 'memory' | 'indexeddb';
  /** Records excluded on the last load because they failed their schema (always empty in memory). */
  readonly problems?: readonly StorageProblem[];
  /** "Delete this record" for a listed storage problem (IndexedDB only). */
  deleteProblem?(problem: Pick<StorageProblem, 'store' | 'id'>): Promise<void>;
  /** Release the storage connection (IndexedDB) so the database can be deleted. */
  close(): void;
  readonly workspaceId: WorkspaceId;
  /** Timestamp source for the personal workspace (the demo uses the fixed demo clock). */
  readonly systemNow: () => string;
  loadSnapshot(): Promise<WorkspaceSnapshot>;
  getFile(key: string): Promise<Blob | null>;
  /**
   * Run `fn` synchronously on the current state with a buffered writer limited
   * to `stores`. If `fn` throws, or a unique index or schema check fails while
   * applying the writes, nothing is written and the error is rethrown.
   */
  unitOfWork<T>(stores: readonly StoreName[], fn: (state: WorkspaceSnapshot, w: Writer) => T): Promise<T>;
}

export const EMPTY_DEMO_STATE: DemoState = Object.freeze({ loadedBatches: [], tourStep: 1, clockTick: 0 }) as DemoState;
