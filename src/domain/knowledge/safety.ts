/**
 * Immutable safety invariants (design §7.8). These are code constants, not
 * rules: no rule type or setting can disable them. The rule schema has no field
 * that could express "turn off a check" (unknown keys are UNSUPPORTED_ACTION),
 * and the posting window is capped at MAX_POSTING_LAG (UNSAFE_POLICY).
 */
import { LIMITS } from '../limits';

export interface SafetyInvariant {
  readonly id: string;
  readonly title: string;
  readonly enforcedIn: string;
}

export const SAFETY_INVARIANTS: readonly SafetyInvariant[] = Object.freeze(
  [
    {
      id: 'S-1',
      title: 'Same currency as the workspace (HKD, or MYR in My files); no conversion',
      enforcedIn: 'Matching steps 2 and 5; manual resolution; card CSV intake',
    },
    { id: 'S-2', title: 'Exact amount to the cent', enforcedIn: 'Matching step 5; manual resolution' },
    { id: 'S-3', title: 'One card transaction links to at most one receipt or invoice', enforcedIn: 'Matching step 5, manual resolution and a unique storage index' },
    { id: 'S-4', title: 'More than one plausible match goes to you', enforcedIn: 'Matching steps 7 and 8' },
    { id: 'S-5', title: 'Unclear or unconfirmed fields block automatic matching', enforcedIn: 'Matching step 1' },
    { id: 'S-6', title: 'Suspected duplicates block automatic matching', enforcedIn: 'Matching step 3' },
    { id: 'S-7', title: 'Every proposal is checked again right before it is recorded', enforcedIn: 'Revalidation inside the write' },
    { id: 'S-8', title: 'Receipt and file text is data, never instructions', enforcedIn: 'No code path reads receipt text or file cells for control; text-only rendering' },
    { id: 'S-9', title: 'Aliases are exact labels within one card account', enforcedIn: 'Rule checks (OVERBROAD); matching step 6' },
    { id: 'S-10', title: 'The date window cannot exceed 7 days', enforcedIn: 'Rule checks (UNSAFE_POLICY)' },
  ].map((s) => Object.freeze(s)),
);

export const SAFETY_CARD_LABEL = 'Built-in safety check — cannot be changed';

/** Immutable cap for the tunable posting window. */
export const MAX_POSTING_LAG = LIMITS.postingWindowMaxDays;

/** Built-in baseline policy `P-BASE v0` (a code constant, not a stored rule). */
export const BASELINE_POLICY = Object.freeze({
  ref: Object.freeze({ ruleId: 'P-BASE' as const, version: 0 as const }),
  postingLagMaxDays: LIMITS.postingWindowDefaultDays,
});

/**
 * Generic payment-processor labels (A17: a fixed demo list, not exhaustive).
 * They never establish merchant identity and can never become aliases (A19).
 */
export const GENERIC_PROCESSOR_LABELS: readonly string[] = Object.freeze([
  'SQ',
  'PAYPAL',
  'STRIPE',
  'SUMUP',
  'ALIPAY',
  'WECHAT PAY',
  'OCTOPUS',
  'PAYME',
  'FPS',
]);

/** A normalised label is generic if it equals, or starts with followed by a space, a processor label. */
export function isGenericLabel(normalizedLabel: string): boolean {
  return GENERIC_PROCESSOR_LABELS.some((g) => normalizedLabel === g || normalizedLabel.startsWith(`${g} `));
}
