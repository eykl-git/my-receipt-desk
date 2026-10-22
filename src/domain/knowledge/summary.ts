/**
 * "What changed / What did not change" after activation (design §7.5). Built
 * only from the preview the activation recorded and the state after it, so it
 * never states an outcome the state does not show.
 */
import { categoryName } from '../categories';
import type { CaseGroup, CaseView } from '../matching/caseView';
import { numberWord } from '../words';
import type { CaseSummary, ImpactPreview } from './preview';
import type { RuleType } from './schema';

export const GROUP_LABELS: Readonly<Record<CaseGroup, string>> = Object.freeze({
  ready: 'Ready to record',
  needs_decision: 'Needs your decision',
  recorded: 'Recorded',
});

export interface ActivationSummary {
  changed: string[];
  notChanged: string[];
}

export function categoryText(c: CaseSummary['category']): string {
  if (c.categoryId === null) return 'none';
  return `${categoryName(c.categoryId)} (${c.status})`;
}

export function activationSummary(type: RuleType, preview: ImpactPreview, pendingAfter: readonly CaseView[]): ActivationSummary {
  const changed: string[] = [];
  const notChanged: string[] = ['Recorded entries were not changed.'];
  const changedIds = new Set(preview.pendingChanges.map((p) => p.caseId));

  for (const p of preview.pendingChanges) {
    const parts: string[] = [];
    if (p.before.group !== p.after.group) parts.push(`${GROUP_LABELS[p.before.group]} → ${GROUP_LABELS[p.after.group]}.`);
    if (p.before.explanation !== p.after.explanation) parts.push(p.after.explanation);
    if (categoryText(p.before.category) !== categoryText(p.after.category)) {
      parts.push(`Category: ${categoryText(p.before.category)} → ${categoryText(p.after.category)}.`);
    }
    changed.push(`${p.caseId}: ${parts.join(' ')}`);
  }

  if (type === 'category_preference') {
    const suggested = preview.pendingChanges.filter((p) => p.after.category.status === 'suggested' && p.before.category.status !== 'suggested');
    const name = suggested[0]?.after.category.categoryId ? categoryName(suggested[0].after.category.categoryId) : null;
    if (name) {
      const n = suggested.length;
      changed.push(`Suggested category ${name} now shows on ${numberWord(n)} pending receipt${n === 1 ? '' : 's'}.`);
    }
  }

  for (const c of pendingAfter) {
    if (c.group === 'needs_decision' && !changedIds.has(c.receiptId)) notChanged.push(`${c.receiptId} still needs your decision: ${c.explanation}`);
  }
  if (type === 'category_preference') {
    notChanged.push('Nothing is confirmed until you choose “Confirm category”. Recorded entries keep their category.');
  } else {
    notChanged.push('Categories were not changed.');
  }
  return { changed, notChanged };
}
