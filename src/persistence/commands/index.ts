/**
 * Write commands and the audit actions each must append (design §4.1). T21
 * compares this table with the exported command list and runs every command
 * on a scenario to check that each listed action is written.
 */
import type { AuditAction } from '../../domain/schemas';
import { addReceipts, applyExtraction, saveFields } from './capture';
import { advanceTourStep, loadDemoBatch } from './demo';
import { resolveDuplicate, resolveStatementDuplicate } from './duplicates';
import { importStatement, rejectDuplicateImport } from './imports';
import { addPayable, attachPayment } from './invoices';
import { confirmCategory, recordStatementOnly, unlinkReceipt, voidEntry } from './ledger';
import { confirmCaseOnly, recordProposal } from './match';
import { activateRule, createDraft, discardDraft, editRule, reactivateRule, recheckKeep, recheckVoid, suspendRule, updateDraft } from './rules';
import { recordAllReady } from './run';
import { setWorkspaceCurrency } from './settings';
import { importKnowledge } from './knowledge';

export * from './capture';
export * from './settings';
export * from './knowledge';
export * from './demo';
export * from './duplicates';
export * from './imports';
export * from './invoices';
export * from './ledger';
export * from './match';
export * from './rules';
export * from './run';

export const COMMANDS = {
  addReceipts,
  addPayable,
  applyExtraction,
  saveFields,
  resolveDuplicate,
  importStatement,
  rejectDuplicateImport,
  resolveStatementDuplicate,
  loadDemoBatch,
  advanceTourStep,
  recordProposal,
  confirmCaseOnly,
  recordAllReady,
  recordStatementOnly,
  attachPayment,
  confirmCategory,
  voidEntry,
  unlinkReceipt,
  createDraft,
  editRule,
  updateDraft,
  discardDraft,
  activateRule,
  suspendRule,
  reactivateRule,
  recheckKeep,
  recheckVoid,
  setWorkspaceCurrency,
  importKnowledge,
} as const;

/**
 * Every action each command may append. Commands with alternatives list all of
 * them (for example `ledger.recorded` for a new entry, `ledger.evidence_attached`
 * when a statement-only entry gains evidence); T21 asserts the scenario's
 * actions are a non-empty subset that includes each command's required ones.
 */
export const COMMAND_AUDIT: Readonly<Record<keyof typeof COMMANDS, readonly AuditAction[]>> = Object.freeze({
  addReceipts: ['capture.receipt_added', 'capture.duplicate_upload_rejected'],
  addPayable: ['capture.payable_added', 'capture.duplicate_upload_rejected'],
  applyExtraction: ['capture.fields_extracted'],
  saveFields: ['capture.fields_confirmed'],
  resolveDuplicate: ['capture.duplicate_resolved'],
  importStatement: ['import.statement_committed'],
  rejectDuplicateImport: ['import.duplicate_file_rejected'],
  resolveStatementDuplicate: ['import.rows_kept', 'import.row_set_aside'],
  loadDemoBatch: ['capture.receipt_added', 'capture.duplicate_upload_rejected', 'import.statement_committed', 'demo.batch_loaded'],
  advanceTourStep: [],
  recordProposal: ['match.confirmed', 'ledger.recorded', 'ledger.evidence_attached'],
  confirmCaseOnly: ['match.confirmed', 'ledger.recorded', 'ledger.evidence_attached'],
  recordAllReady: ['match.confirmed', 'ledger.recorded', 'ledger.evidence_attached'],
  recordStatementOnly: ['ledger.recorded'],
  attachPayment: ['match.confirmed', 'ledger.recorded', 'ledger.evidence_attached', 'payable.paid'],
  confirmCategory: ['category.confirmed', 'ledger.category_changed'],
  voidEntry: ['ledger.voided', 'match.released', 'payable.reopened'],
  unlinkReceipt: ['match.released', 'ledger.evidence_detached'],
  createDraft: ['rule.draft_created'],
  editRule: ['rule.draft_created'],
  updateDraft: ['rule.draft_updated'],
  discardDraft: ['rule.draft_discarded'],
  activateRule: ['rule.activated', 'proposals.invalidated'],
  suspendRule: ['rule.suspended', 'proposals.invalidated'],
  reactivateRule: ['rule.reactivated'],
  recheckKeep: ['recheck.kept'],
  // A re-check only lists receipt entries (§7.7), so no invoice is reopened here.
  recheckVoid: ['ledger.voided', 'match.released'],
  setWorkspaceCurrency: [],
  importKnowledge: ['knowledge.imported', 'rule.draft_created'],
});
