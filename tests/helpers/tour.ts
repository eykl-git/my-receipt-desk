/** Drives the guided tour through the real commands (on the repository kind of the running suite). */
import { activateRule, advanceTourStep, confirmCaseOnly, createDraft, loadDemoBatch } from '../../src/persistence/commands';
import type { Repository, WorkspaceSnapshot } from '../../src/persistence/repository';
import { makeRepo } from './repos';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { prefillDraftFromCase } from '../../src/domain/knowledge/prefill';
import { previewImpact } from '../../src/domain/knowledge/preview';
import { deriveWorkspaceView, type WorkspaceView } from '../../src/domain/views';
import { loadDemoAssetsFromDisk } from './demoAssets';

export const TOUR_REASON = 'Receipt and card transaction show the same amount and date';

export const assets = loadDemoAssetsFromDisk();

/** A fresh demo workspace: MemoryRepository, or IdbRepository inside `describeEachRepo`. */
export function demoRepo(): Repository {
  return makeRepo('demo');
}

export function viewOf(s: WorkspaceSnapshot, rules?: Parameters<typeof deriveWorkspaceView>[1]): WorkspaceView {
  return deriveWorkspaceView(asWorkspaceState(s), rules);
}

export function txIdByRef(s: WorkspaceSnapshot, ref: string): string {
  const t = s.transactions.find((x) => x.reference === ref);
  if (!t) throw new Error(`No transaction ${ref}`);
  return t.id;
}

/** Step 1 → step 2 with R-102 confirmed once (both paths share this). */
export async function tourToConfirmedR102(repo = demoRepo()) {
  await loadDemoBatch(repo, 1, assets);
  await advanceTourStep(repo, 2);
  const s = await repo.loadSnapshot();
  await confirmCaseOnly(repo, { receiptId: 'R-102', transactionId: txIdByRef(s, 'S-102'), reason: TOUR_REASON });
  return repo;
}

/** The teach path: propose the alias from R-102, preview, activate. */
export async function teachAlias(repo: Repository) {
  const s = await repo.loadSnapshot();
  const prefill = prefillDraftFromCase({
    receipt: s.receipts.find((r) => r.id === 'R-102')!,
    proposal: null,
    matches: s.matches,
    transactions: s.transactions,
    activeRules: viewOf(s).activeRules,
  });
  if (prefill.kind !== 'alias') throw new Error(`expected an alias prefill, got ${prefill.kind}`);
  const { ruleId, version } = await createDraft(repo, prefill.draft);
  const s2 = await repo.loadSnapshot();
  const v = s2.ruleVersions.find((x) => x.ruleId === ruleId && x.version === version)!;
  const preview = previewImpact(asWorkspaceState(s2), { kind: 'activate', version: v });
  const result = await activateRule(repo, ruleId, version, preview.stateFingerprint);
  return { ruleId, version, preview, result };
}
