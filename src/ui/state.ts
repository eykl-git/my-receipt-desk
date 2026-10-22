/** UI state types (design §2: `{ workspace, snapshot, uiState }`). Proposals are never stored here. */
import type { ImpactPreview } from '../domain/knowledge/preview';
import type { ReceiptLocale } from '../domain/capture/ocrLocale';
import type { RuleType } from '../domain/knowledge/schema';
import type { Finding } from '../domain/knowledge/validate';
import type { EvidenceRef, RuleRef, WorkspaceId } from '../domain/primitives';
import type { WorkspaceSnapshot } from '../persistence/repository';
import type { DraftForm } from './draftForm';

export type ListFilter = 'all' | 'needs_decision' | 'ready' | 'recorded' | 'transactions' | 'invoices';
export type TabId = 'data' | 'knowledge' | 'decisions';

export interface LabelOption {
  observedLabel: string;
  accountId: string;
  accountLabel: string;
  evidence: EvidenceRef[];
}

export interface PanelState {
  origin: { kind: 'case'; receiptId: string } | { kind: 'form' } | { kind: 'rule'; ruleId: string };
  /** "Edit" on an active or suspended rule: the first preview writes version n+1 of this rule (editRule). */
  editOf: string | null;
  form: DraftForm;
  seed: { form: DraftForm; evidence: EvidenceRef[] } | null;
  labelOptions: LabelOption[] | null;
  persisted: { ruleId: string; version: number; contentJson: string } | null;
  preview: { contentJson: string; preview: ImpactPreview } | null;
  schemaErrors: Finding[] | null;
  summary: { ruleId: string; version: number; type: RuleType; changed: string[]; notChanged: string[]; newlyReady: string[]; affected: string[] } | null;
  /** Text shown above the form (plain-English rule bar: the sentence used, or why it couldn't be read). */
  intro: string | null;
  confirmDiscard: 'close' | 'back' | null;
  error: string | null;
  busy: boolean;
}

export type DrawerState =
  | { kind: 'case'; receiptId: string; panel: PanelState | null }
  | { kind: 'transaction'; transactionId: string }
  | { kind: 'invoice'; payableId: string }
  | { kind: 'rule'; panel: PanelState };

export type DialogState =
  | { kind: 'audit' }
  | { kind: 'privacy' }
  | { kind: 'reset' }
  | { kind: 'history'; ruleId: string }
  | { kind: 'suspend'; ruleId: string }
  | { kind: 'preview'; ruleId: string }
  | { kind: 'baselineHistory' }
  | { kind: 'discard'; ruleId: string }
  | { kind: 'addReceipts' }
  | { kind: 'import' }
  | { kind: 'compare'; ruleRef: RuleRef }
  | { kind: 'restart' }
  | { kind: 'exports' }
  | { kind: 'importKnowledge' }
  | { kind: 'recheck'; ruleId: string }
  | { kind: 'void'; ledgerEntryId: string; mode: 'void' | 'unlink' | 'recheck'; receiptId: string | null; ruleId?: string }
  | { kind: 'storageProblems' };

/** What the last "Read automatically" found; shown in the drawer until it closes. Never stored. */
export interface OcrOutcome {
  receiptId: string;
  locale: ReceiptLocale;
  notes: string[];
  currency: string | null;
}

export interface Notice {
  text: string;
  tone: 'info' | 'error';
}

export interface AppState {
  ready: boolean;
  workspace: WorkspaceId;
  snapshots: Record<WorkspaceId, WorkspaceSnapshot>;
  view: 'assisted' | 'spreadsheet';
  batchFilter: string;
  listFilter: ListFilter;
  tab: TabId;
  drawer: DrawerState | null;
  dialog: DialogState | null;
  /** "New" badge and outline on a just-activated rule card (4 s, from drawer close). */
  newCard: string | null;
  /** Case cards briefly outlined after an activation (4 s). */
  pulseCases: string[];
  /** "Newly ready — K-… vN" badges; shown while the case is pending and the rule version is active. */
  newlyReady: Array<{ workspace: WorkspaceId; ruleId: string; version: number; caseIds: string[] }>;
  live: string;
  notice: Notice | null;
  demoLoad: 'idle' | 'loading' | 'error';
  exampleCsv: Uint8Array | 'failed' | null;
  busy: boolean;
  /** "Record all ready" is running (single record actions are disabled meanwhile). */
  recording: boolean;
  /** "Pause processing" was pressed; the run stops before its next record. */
  pausing: boolean;
  /** Storage problem shown as a persistent banner (§11.5); null when IndexedDB works. */
  storage: 'unavailable' | 'newer_version' | 'blocking' | null;
  ocrOutcome: OcrOutcome | null;
}
