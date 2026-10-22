/**
 * Tour coach text (design §9.1, review-3 amendments N1 and N2). A pure
 * function of the current state: it can only describe what the state shows.
 * Rule references are read from proposals and matches, never hard-coded.
 */
import { effectiveFields, fieldIssues, FIELD_LABELS } from '../domain/capture/fields';
import { isUnknownLabelCase } from '../domain/knowledge/discover';
import type { CaseView } from '../domain/matching/caseView';
import { formatRuleRef, type RuleRef } from '../domain/primitives';
import type { AuditEvent, ConfirmedMatch, Receipt, StatementTransaction } from '../domain/schemas';
import type { WorkspaceView } from '../domain/views';
import { capitalize, joinAnd, numberWord } from '../domain/words';
import { batchOfFixture, nextUnloadedBatch } from './batches';

export interface CoachState {
  receipts: readonly Receipt[];
  transactions: readonly StatementTransaction[];
  matches: readonly ConfirmedMatch[];
  audit: readonly AuditEvent[];
  demoState?: { loadedBatches: readonly number[] };
  /** Rule heads, so a suspended rule is described as suspended rather than missing. */
  ruleHeads?: readonly { ruleId: string; type: string; status: string; lastApprovedVersion: number | null }[];
}

const isAliasRef = (r: RuleRef) => r.ruleId.startsWith('K-ALIAS-');

function aliasRefsText(refs: readonly RuleRef[]): string {
  const uniq = [...new Map(refs.filter(isAliasRef).map((r) => [formatRuleRef(r), r])).keys()].sort();
  return joinAnd(uniq);
}

export { isUnknownLabelCase };

function merchantOf(receipts: readonly Receipt[], ids: readonly string[]): string | null {
  const names = new Set(ids.map((id) => effectiveFields(receipts.find((r) => r.id === id)!).merchant));
  return names.size === 1 ? ([...names][0] ?? null) : null;
}

const PLURAL_FIELD: Record<string, string> = { merchant: 'merchants', date: 'dates', amount: 'amounts', currency: 'currencies' };

function step1(view: WorkspaceView, s: CoachState): string {
  const ready = view.groups.ready.length;
  const readySentence =
    ready === 0 ? 'No receipt is ready yet.' : ready === 1 ? 'One receipt is ready.' : `${capitalize(numberWord(ready))} receipts are ready.`;
  const pending = view.groups.needs_decision;
  const unknown: CaseView[] = [];
  const fields: CaseView[] = [];
  const ambiguous: CaseView[] = [];
  const other: CaseView[] = [];
  for (const c of pending) {
    if (c.flags.includes('missing_fields')) fields.push(c);
    else if (isUnknownLabelCase(c)) unknown.push(c);
    else if (c.proposal?.outcome === 'ambiguous') ambiguous.push(c);
    else other.push(c);
  }
  const clauses: string[] = [];
  if (unknown.length > 0) {
    const labels = new Set(unknown.flatMap((c) => c.proposal!.nearCandidateIds.map((id) => s.transactions.find((t) => t.id === id)?.rawLabel ?? '')));
    clauses.push(
      labels.size === 1
        ? `${numberWord(unknown.length)} because the card shows “${[...labels][0]}”, a name the desk doesn't know yet`
        : `${numberWord(unknown.length)} because the card name isn't known yet`,
    );
  }
  if (fields.length > 0) {
    const names = new Set(fields.map((c) => fieldIssues(s.receipts.find((r) => r.id === c.receiptId)!)[0]?.field));
    const field = names.size === 1 ? [...names][0] : undefined;
    const label = field ? FIELD_LABELS[field].toLowerCase() : null;
    clauses.push(
      label
        ? `${numberWord(fields.length)} unclear ${fields.length === 1 ? label : (PLURAL_FIELD[label] ?? label)}`
        : `${numberWord(fields.length)} with unclear fields`,
    );
  }
  if (ambiguous.length > 0) {
    const ks = new Set(ambiguous.map((c) => c.proposal!.candidateIds.length));
    const k = ks.size === 1 ? numberWord([...ks][0]!) : 'several';
    clauses.push(`${numberWord(ambiguous.length)} with ${k} equal payments`);
  }
  if (other.length > 0) clauses.push(`${numberWord(other.length)} for other reasons`);
  const n = pending.length;
  const needsSentence = n === 0 ? '' : ` ${capitalize(numberWord(n))} ${n === 1 ? 'needs' : 'need'} you: ${joinAnd(clauses)}.`;
  return `Step 1 of 4 · Batch 1: First encounter. ${readySentence}${needsSentence}`;
}

function batchReceiptIds(s: CoachState, batch: number): Set<string> {
  return new Set(s.receipts.filter((r) => batchOfFixture(r.fixtureId) === batch).map((r) => r.id));
}

function step3(view: WorkspaceView, s: CoachState): string {
  const dupCaught = s.audit.some(
    (e) => e.action === 'capture.duplicate_upload_rejected' && typeof e.after === 'object' && e.after !== null && (e.after as { batch?: unknown }).batch === 2,
  );
  const dup = dupCaught ? ' The re-uploaded file was caught.' : '';
  const ids = batchReceiptIds(s, 2);

  // Variant A (N1): Batch 2 receipts ready because of an alias.
  const readyByAlias = view.groups.ready.filter((c) => ids.has(c.receiptId) && (c.proposal?.ruleRefs ?? []).some(isAliasRef));
  if (readyByAlias.length > 0) {
    const n = readyByAlias.length;
    const name = merchantOf(s.receipts, readyByAlias.map((c) => c.receiptId));
    const refs = aliasRefsText(readyByAlias.flatMap((c) => c.proposal!.ruleRefs));
    return `Step 3 of 4 · Batch 2: Knowledge reused. ${capitalize(numberWord(n))} ${name ? `${name} ` : ''}receipt${n === 1 ? '' : 's'} ${n === 1 ? 'is' : 'are'} ready because of ${refs}.${dup}`;
  }
  const recordedByAlias = s.matches.filter(
    (m) => m.status === 'active' && m.subject.kind === 'receipt' && ids.has(m.subject.id) && m.proposalSnapshot.ruleRefs.some(isAliasRef),
  );
  if (recordedByAlias.length > 0) {
    const n = recordedByAlias.length;
    const name = merchantOf(s.receipts, recordedByAlias.map((m) => m.subject.id));
    const refs = aliasRefsText(recordedByAlias.flatMap((m) => m.proposalSnapshot.ruleRefs));
    return `Step 3 of 4 · Batch 2: Knowledge reused. ${capitalize(numberWord(n))} ${name ? `${name} ` : ''}receipt${n === 1 ? '' : 's'} ${n === 1 ? 'was' : 'were'} recorded using ${refs}.${dup}`;
  }

  // Variant B: Batch 2 receipts still pending because of an unknown card label.
  const unknown = view.groups.needs_decision.filter((c) => ids.has(c.receiptId) && isUnknownLabelCase(c));
  const n = unknown.length;
  if (n === 0) return `Step 3 of 4 · Batch 2 is loaded.${dup}`;
  const name = merchantOf(s.receipts, unknown.map((c) => c.receiptId));
  const what = `new ${name ? `${name} ` : ''}receipt${n === 1 ? '' : 's'}`;
  const count = n === 2 ? 'both' : numberWord(n);
  return `Step 3 of 4 · Batch 2: Without an approved rule, ${count} ${what} still ${n === 1 ? 'needs' : 'need'} your decision.${dup}`;
}

function step4(view: WorkspaceView, s: CoachState): string {
  const clauses: string[] = [];
  const ambiguousAlias = view.cases
    .filter((c) => c.group !== 'recorded' && c.proposal?.outcome === 'ambiguous' && c.proposal.candidateIds.length >= 2 && c.proposal.ruleRefs.some(isAliasRef))
    .sort((a, b) => (a.receiptId < b.receiptId ? -1 : 1));
  if (ambiguousAlias.length > 0) {
    clauses.push(`a known name still can't pick between ${numberWord(ambiguousAlias[0]!.proposal!.candidateIds.length)} equal payments`);
  } else {
    const ks: Array<{ id: string; k: number }> = [];
    for (const c of view.cases) {
      if (c.group !== 'recorded' && c.proposal?.outcome === 'ambiguous') ks.push({ id: c.receiptId, k: c.proposal.candidateIds.length });
    }
    for (const m of s.matches) {
      if (m.status === 'active' && m.subject.kind === 'receipt' && m.proposalSnapshot.candidateIds.length >= 2) ks.push({ id: m.subject.id, k: m.proposalSnapshot.candidateIds.length });
    }
    ks.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (ks.length > 0) clauses.push(`${numberWord(ks[0]!.k)} equal payments still come back to you`);
  }
  const currencyBlocked = view.cases
    .filter((c) => c.flags.includes('unsupported_input'))
    .map((c) => ({ id: c.receiptId, cur: effectiveFields(s.receipts.find((r) => r.id === c.receiptId)!).currency }))
    .filter((x) => x.cur !== null && x.cur !== 'HKD')
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  if (currencyBlocked.length > 0) clauses.push(`${currencyBlocked[0]!.cur} is not converted`);
  clauses.push("receipt text can't change your rules");
  const sentence =
    clauses.length === 1 ? clauses[0]! : `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
  return `Step 4 of 4 · Batch 3: The boundary still holds. ${capitalize(sentence)}.`;
}

export const STEP_2_TEXT = 'Step 2 of 4 · Open R-102, confirm its card transaction, then propose the card name as reusable knowledge.';

/**
 * Step 2 follows the state (S2 amendment A-S2-1, design §20): the instruction
 * until R-102 is recorded; then what the confirmation did; then, once an alias
 * is active, what it changed and the next action. Never claims more than the
 * current evaluation shows.
 */
function step2(view: WorkspaceView, s: CoachState): string {
  const aliases = view.activeRules.filter((r) => r.type === 'merchant_alias').sort((a, b) => (a.ruleId < b.ruleId ? -1 : 1));
  const next = s.demoState && nextUnloadedBatch(s.demoState.loadedBatches);
  const nextText = next ? ` Next: load Batch ${next.n}.` : '';
  if (aliases.length > 0) {
    const refs = aliases.map(formatRuleRef);
    const ready = view.groups.ready
      .filter((c) => (c.proposal?.ruleRefs ?? []).some((r) => aliases.some((a) => a.ruleId === r.ruleId && a.version === r.version)))
      .map((c) => c.receiptId);
    const rule = `Rule ${joinAnd(refs)} ${refs.length === 1 ? 'is' : 'are'} active.`;
    const effect = ready.length === 0 ? '' : ` ${joinAnd(ready)} ${ready.length === 1 ? 'is' : 'are'} now ready without another decision.`;
    return `Step 2 of 4 · ${rule}${effect}${nextText}`;
  }
  // A suspended alias exists (S5): a rule was created, it just isn't applied now (design §20 A-S5-7).
  const suspended = (s.ruleHeads ?? [])
    .filter((h) => h.type === 'merchant_alias' && h.status === 'suspended' && h.lastApprovedVersion !== null)
    .map((h) => formatRuleRef({ ruleId: h.ruleId, version: h.lastApprovedVersion! }))
    .sort();
  if (suspended.length > 0) {
    return `Step 2 of 4 · Rule ${joinAnd(suspended)} ${suspended.length === 1 ? 'is suspended, so it is' : 'are suspended, so they are'} not applied. Reactivate it from “View history”, or continue without it.${nextText}`;
  }
  const r102Recorded = s.matches.some((m) => m.status === 'active' && m.subject.kind === 'receipt' && m.subject.id === 'R-102');
  if (r102Recorded) {
    return 'Step 2 of 4 · R-102 is recorded for this case only. No rule was created. Next: open R-102 and choose “Propose reusable knowledge”.';
  }
  return STEP_2_TEXT;
}

/** The coach sentence without its "Step N of 4 · " prefix (the tour bar shows the step in its indicator). */
export function coachSentence(text: string): string {
  return text.replace(/^Step [1-4] of 4 · /, '');
}

export function coachText(step: 1 | 2 | 3 | 4, view: WorkspaceView, state: CoachState): string {
  switch (step) {
    case 1:
      return step1(view, state);
    case 2:
      return step2(view, state);
    case 3:
      return step3(view, state);
    case 4:
      return step4(view, state);
  }
}
