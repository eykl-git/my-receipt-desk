/**
 * Derived workspace view: one evaluation plus the case views built from it.
 * Pure; the UI memoises it per snapshot (design §2, §14).
 */
import { activeRulesFrom } from './knowledge/resolve';
import type { RuleVersion } from './knowledge/schema';
import type { WorkspaceState } from './knowledge/preview';
import { deriveCaseView, deriveTransactionCases, groupCases, type CaseView, type GroupedCases, type TransactionCase } from './matching/caseView';
import { evaluateWorkspace } from './matching/evaluate';
import type { EvaluationResult } from './matching/types';

export interface WorkspaceView {
  activeRules: RuleVersion[];
  evaluation: EvaluationResult;
  cases: CaseView[];
  caseById: Map<string, CaseView>;
  groups: GroupedCases;
  transactionCases: TransactionCase[];
}

export function deriveWorkspaceView(state: WorkspaceState, rules?: readonly RuleVersion[]): WorkspaceView {
  const activeRules = rules ? [...rules] : activeRulesFrom(state.ruleHeads, state.ruleVersions);
  const evaluation = evaluateWorkspace({
    receipts: state.receipts,
    transactions: state.transactions,
    matches: state.matches,
    ledgerEntries: state.ledger,
    activeRules,
    decisions: state.decisions,
    workspaceCurrency: state.currency,
  });
  const cases = state.receipts.map((r) => deriveCaseView(r, evaluation, state.matches, state.ledger, activeRules));
  return {
    activeRules,
    evaluation,
    cases,
    caseById: new Map(cases.map((c) => [c.receiptId, c])),
    groups: groupCases(cases),
    transactionCases: deriveTransactionCases(evaluation, state.transactions),
  };
}
