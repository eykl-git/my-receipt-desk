/** Typed, recoverable domain errors (design §11.5). */

export interface FindingLike {
  code: string;
  message: string;
}

export class ValidationError extends Error {
  readonly code: string;
  readonly findings: readonly FindingLike[];
  constructor(code: string, message: string, findings: readonly FindingLike[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.findings = findings;
  }
}

export type StaleReason = 'transaction_taken' | 'rule_changed' | 'receipt_changed' | 'now_ambiguous';

export const STALE_REASON_TEXT: Readonly<Record<StaleReason, string>> = Object.freeze({
  transaction_taken: 'the card transaction is now linked to another record',
  rule_changed: 'a rule it relied on changed',
  receipt_changed: 'the receipt was changed',
  now_ambiguous: 'it no longer has exactly one matching card transaction',
});

export class StaleProposalError extends Error {
  readonly reason: StaleReason;
  constructor(reason: StaleReason) {
    super(`This case changed since it was shown: ${STALE_REASON_TEXT[reason]}. Review the updated proposal.`);
    this.name = 'StaleProposalError';
    this.reason = reason;
  }
}

export class AlreadyLinkedError extends Error {
  readonly transactionId: string;
  readonly linkedTo: string | null;
  constructor(transactionId: string, linkedTo: string | null) {
    super(
      linkedTo
        ? `That card transaction is already linked to ${linkedTo}.`
        : 'That card transaction is already linked to another record.',
    );
    this.name = 'AlreadyLinkedError';
    this.transactionId = transactionId;
    this.linkedTo = linkedTo;
  }
}

export class DemoAssetsError extends Error {
  constructor(cause?: unknown) {
    super('The demo files couldn\'t be loaded. Check your connection and try again.', { cause });
    this.name = 'DemoAssetsError';
  }
}
