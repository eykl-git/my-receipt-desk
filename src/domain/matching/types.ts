import type { EffectivePolicy } from '../knowledge/resolve';
import type { RuleVersion } from '../knowledge/schema';
import type { ReviewFlag } from '../primitives';
import type {
  ConfirmedMatch,
  LedgerEntry,
  MatchProposal,
  Receipt,
  ReviewDecision,
  StatementTransaction,
} from '../schemas';

export type { MatchProposal, TraceStep, MatchOutcome } from '../schemas';

/**
 * Everything the engine reads. Plain arrays; nothing is mutated. The policy is
 * derived from `activeRules` (the single active posting-window rule, else the
 * built-in P-BASE v0), so a caller cannot pass a policy that disagrees with the
 * rules.
 */
export interface EvaluationInput {
  receipts: readonly Receipt[];
  transactions: readonly StatementTransaction[];
  /** Confirmed matches; released ones are ignored. */
  matches: readonly ConfirmedMatch[];
  ledgerEntries: readonly LedgerEntry[];
  activeRules: readonly RuleVersion[];
  /** Review decisions (duplicate resolutions are read). */
  decisions: readonly ReviewDecision[];
  /**
   * Workspace currency (REQ-20, S-1): only this currency can match; anything
   * else is flagged unsupported and never converted. HKD when omitted.
   */
  workspaceCurrency?: string;
}

export interface TransactionFlags {
  flags: ReviewFlag[];
  explanation: string;
}

export interface EvaluationResult {
  /** One proposal per active receipt without an active match, keyed by receipt ID. */
  proposals: ReadonlyMap<string, MatchProposal>;
  /** Flags for card-transaction cases (§5.1), keyed by transaction ID. */
  transactionFlags: ReadonlyMap<string, TransactionFlags>;
  /** Suspected duplicate purchases: receiptId → other receipt IDs. */
  duplicateReceipts: ReadonlyMap<string, readonly string[]>;
  policy: EffectivePolicy;
}
