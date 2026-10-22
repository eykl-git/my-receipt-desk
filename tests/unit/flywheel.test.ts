/**
 * The knowledge flywheel through the real commands (S2): apply once vs teach,
 * draft persistence, activation, reuse in Batch 2, re-upload detection.
 */
import { expect, it } from 'vitest';
import {
  activateRule,
  advanceTourStep,
  COMMAND_AUDIT,
  COMMANDS,
  confirmCaseOnly,
  createDraft,
  discardDraft,
  loadDemoBatch,
  reactivateRule,
  recordProposal,
  suspendRule,
  updateDraft,
} from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { previewImpact, stateFingerprint } from '../../src/domain/knowledge/preview';
import { activationSummary } from '../../src/domain/knowledge/summary';
import { categoryDraft } from '../../src/domain/knowledge/prefill';
import { AlreadyLinkedError, StaleProposalError, ValidationError } from '../../src/domain/errors';
import { assets, demoRepo, teachAlias, tourToConfirmedR102, TOUR_REASON, txIdByRef, viewOf } from '../helpers/tour';
import { describeEachRepo } from '../helpers/repos';

const counts = (s: Awaited<ReturnType<ReturnType<typeof demoRepo>['loadSnapshot']>>) => ({
  receipts: s.receipts.length,
  transactions: s.transactions.length,
  matches: s.matches.length,
  ledger: s.ledger.length,
  documents: s.sourceDocuments.length,
});

describeEachRepo('flywheel through commands', () => {
  it('T02 a one-off confirmation records R-102 but teaches nothing: R-103, R-201, R-202 still need a decision', async () => {
    const repo = await tourToConfirmedR102();
    await loadDemoBatch(repo, 2, assets);
    const s = await repo.loadSnapshot();
    expect(s.ruleHeads).toEqual([]);
    expect(s.matches.map((m) => [m.id, m.subject.id, m.method, m.reason, m.proposalSnapshot.ruleRefs])).toEqual([
      ['M-0001', 'R-102', 'manual_resolution', TOUR_REASON, []],
    ]);
    expect(s.ledger.map((e) => [e.id, e.status, e.ruleRefs, e.amountMinor])).toEqual([['L-0001', 'recorded', [], 4800]]);
    const v = viewOf(s);
    for (const id of ['R-103', 'R-201', 'R-202']) {
      const c = v.caseById.get(id)!;
      expect(c.group, id).toBe('needs_decision');
      expect(c.explanation, id).toMatch(/Card label “MC COFFEE HK” is not a known name for Morning Cup\./);
      expect(c.proposal!.ruleRefs, id).toEqual([]);
    }
    expect(v.caseById.get('R-102')!.group).toBe('recorded');
    expect(s.audit.filter((a) => a.action.startsWith('rule.'))).toEqual([]);
  });

  it('T03 an approved scoped alias makes R-103 eligible without another decision and Batch 2 cites K-ALIAS-0001 v1', async () => {
    const repo = await tourToConfirmedR102();
    const before = await repo.loadSnapshot();
    const { ruleId, preview } = await teachAlias(repo);
    expect(ruleId).toBe('K-ALIAS-0001');
    expect(preview.pendingChanges.map((p) => [p.caseId, p.before.group, p.after.group])).toEqual([['R-103', 'needs_decision', 'ready']]);

    const s = await repo.loadSnapshot();
    const v = s.ruleVersions.find((x) => x.ruleId === 'K-ALIAS-0001')!;
    expect(v.scope).toEqual({ accountId: 'acct:demo-card-1234' });
    expect(v.condition).toEqual({ observedLabel: 'MC COFFEE HK', match: 'exact' });
    expect(v.action).toEqual({ canonicalMerchantId: 'm:morning-cup', canonicalMerchantName: 'Morning Cup' });
    expect(v.evidenceRefs.map((e) => e.kind)).toEqual(['receipt', 'transaction', 'match']);
    expect(v.approvedAt).toBeDefined();
    expect(s.ruleHeads[0]).toMatchObject({ status: 'active', activeVersion: 1, lastApprovedVersion: 1, draftVersion: null });

    // Activation wrote no receipt, match or ledger record; R-102's entry is unchanged.
    expect(s.receipts).toEqual(before.receipts);
    expect(s.matches).toEqual(before.matches);
    expect(s.ledger).toEqual(before.ledger);

    const view = viewOf(s);
    const r103 = view.caseById.get('R-103')!;
    expect(r103.group).toBe('ready');
    expect(r103.proposal!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(r103.explanation).toBe('Matches S-103. Matched name using K-ALIAS-0001 v1.');
    expect(r103.category.status).toBe('unassigned'); // matching does not imply a category
    expect(view.caseById.get('R-104')!.group).toBe('needs_decision');
    expect(view.caseById.get('R-105')!.group).toBe('needs_decision');

    const summary = activationSummary('merchant_alias', preview, view.groups.needs_decision);
    expect(summary.changed).toEqual(['R-103: Needs your decision → Ready to record. Matches S-103. Matched name using K-ALIAS-0001 v1.']);
    expect(summary.notChanged[0]).toBe('Recorded entries were not changed.');
    expect(summary.notChanged).toContain('Categories were not changed.');
    expect(summary.notChanged.some((t) => t.startsWith('R-104 still needs your decision'))).toBe(true);
    expect(summary.notChanged.some((t) => t.startsWith('R-105 still needs your decision'))).toBe(true);

    await loadDemoBatch(repo, 2, assets);
    const s2 = await repo.loadSnapshot();
    const v2 = viewOf(s2);
    for (const id of ['R-201', 'R-202']) {
      const c = v2.caseById.get(id)!;
      expect(c.group, id).toBe('ready');
      expect(c.proposal!.ruleRefs, id).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
      expect(c.explanation, id).toMatch(/Matched name using K-ALIAS-0001 v1\.$/);
    }
    expect(v2.caseById.get('R-203')!.group).toBe('ready');
    expect(v2.caseById.get('R-203')!.proposal!.ruleRefs).toEqual([]);

    // Recording R-103 cites the rule version on the match, entry and audit event.
    const rec = await recordProposal(repo, v2.caseById.get('R-103')!.proposal!);
    const s3 = await repo.loadSnapshot();
    expect(s3.ledger.find((e) => e.id === rec.ledgerEntryId)!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    const ev = s3.audit.filter((a) => a.action === 'match.confirmed').at(-1)!;
    expect(ev.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
  });

  it('T03 (category sub-case) a category preference only changes the suggested category; stored categories stay unassigned', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    const s = await repo.loadSnapshot();
    const draft = categoryDraft('Morning Cup', 'dining', [{ kind: 'receipt', ref: 'R-102' }]);
    const { ruleId, version } = await createDraft(repo, draft);
    expect(ruleId).toBe('K-CAT-0001');
    const s2 = await repo.loadSnapshot();
    const v = s2.ruleVersions.find((x) => x.ruleId === ruleId)!;
    const preview = previewImpact(asWorkspaceState(s2), { kind: 'activate', version: v });
    expect(preview.pendingChanges.map((p) => [p.caseId, p.before.group, p.after.group, p.after.category])).toEqual([
      ['R-103', 'ready', 'ready', { categoryId: 'dining', status: 'suggested' }],
    ]);
    expect(preview.recordedDifferences.map((d) => d.ledgerEntryId)).toEqual(['L-0001']);
    await activateRule(repo, ruleId, version, preview.stateFingerprint);
    const s3 = await repo.loadSnapshot();
    expect(s3.receipts).toEqual(s.receipts);
    expect(s3.ledger).toEqual(s.ledger);
    expect(s3.receipts.find((r) => r.id === 'R-103')!.category.status).toBe('unassigned');
    const view = viewOf(s3);
    expect(view.caseById.get('R-103')!.category).toEqual({ categoryId: 'dining', status: 'suggested', ruleRef: { ruleId: 'K-CAT-0001', version: 1 } });
    const summary = activationSummary('category_preference', preview, view.groups.needs_decision);
    expect(summary.changed).toContain('Suggested category Dining now shows on one pending receipt.');
    expect(summary.notChanged).not.toContain('Categories were not changed.');
  });

  it('T14 (draft persistence) nothing is written until the first preview; later changes update the draft; approved drafts are frozen', async () => {
    const repo = await tourToConfirmedR102();
    const before = await repo.loadSnapshot();
    // Schema-invalid content is never stored.
    await expect(createDraft(repo, { type: 'merchant_alias', amountTolerance: 5 })).rejects.toBeInstanceOf(ValidationError);
    expect(await repo.loadSnapshot()).toEqual(before);

    const draft = categoryDraft('Morning Cup', 'dining', [{ kind: 'receipt', ref: 'R-102' }]);
    const { ruleId } = await createDraft(repo, draft);
    let s = await repo.loadSnapshot();
    expect(s.ruleHeads.map((h) => [h.ruleId, h.status, h.draftVersion])).toEqual([[ruleId, 'draft_only', 1]]);
    expect(s.audit.at(-1)!.action).toBe('rule.draft_created');

    expect(await updateDraft(repo, ruleId, 1, draft)).toEqual({ changed: false });
    expect((await repo.loadSnapshot()).audit.length).toBe(s.audit.length);
    await updateDraft(repo, ruleId, 1, categoryDraft('Morning Cup', 'other', [{ kind: 'receipt', ref: 'R-102' }]));
    s = await repo.loadSnapshot();
    expect(s.audit.at(-1)!.action).toBe('rule.draft_updated');
    expect(s.ruleVersions.find((v) => v.ruleId === ruleId)!.action).toEqual({ suggestCategoryId: 'other' });

    // Activation without a preview, or with a stale one, is refused and changes nothing.
    await expect(activateRule(repo, ruleId, 1, null)).rejects.toThrow('Preview the impact first');
    await expect(activateRule(repo, ruleId, 1, 'stale')).rejects.toThrow('The data changed since the preview');
    expect((await repo.loadSnapshot()).ruleHeads).toEqual(s.ruleHeads);

    const stored = s.ruleVersions.find((v) => v.ruleId === ruleId)!;
    const fp = previewImpact(asWorkspaceState(s), { kind: 'activate', version: stored }).stateFingerprint;
    expect(fp).toBe(stateFingerprint(asWorkspaceState(s), categoryDraft('Morning Cup', 'other', [{ kind: 'receipt', ref: 'R-102' }])));
    await activateRule(repo, ruleId, 1, fp);
    await expect(updateDraft(repo, ruleId, 1, draft)).rejects.toThrow('is not an open draft');

    // A second posting-window rule can't be created; a discarded draft stays readable.
    const policy = { type: 'posting_window', scope: { workspace: true }, condition: {}, action: { postingLagMaxDays: 2 }, plainEnglish: 'x', exclusions: [], evidenceRefs: [] };
    const p = await createDraft(repo, policy);
    await expect(createDraft(repo, policy)).rejects.toThrow('A matching-policy rule already exists here');
    await discardDraft(repo, p.ruleId);
    s = await repo.loadSnapshot();
    expect(s.ruleHeads.find((h) => h.ruleId === p.ruleId)!.status).toBe('discarded');
    expect(s.ruleVersions.find((v) => v.ruleId === p.ruleId)!.discardedAt).toBeDefined();
  });

  it('T10 the R-204 re-upload and a repeated Batch 2 load create no receipt, match or expense', async () => {
    const repo = await tourToConfirmedR102();
    const r1 = await loadDemoBatch(repo, 2, assets);
    expect(r1.addedReceiptIds).toEqual(['R-201', 'R-202', 'R-203']);
    expect(r1.duplicateUploads).toEqual([{ fixtureId: 'R-204', matchedReceiptId: 'R-102' }]);
    const s = await repo.loadSnapshot();
    expect(s.receipts.map((r) => r.id)).not.toContain('R-204');
    expect(counts(s)).toEqual({ receipts: 8, transactions: 9, matches: 1, ledger: 1, documents: 10 });
    const rejected = s.audit.filter((a) => a.action === 'capture.duplicate_upload_rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.after).toMatchObject({ matchedReceiptId: 'R-102', batch: 2 });

    const again = await loadDemoBatch(repo, 2, assets);
    expect(again.alreadyLoaded).toBe(true);
    expect(await repo.loadSnapshot()).toEqual(s); // writes nothing at all
  });

  it('T05 / T09 manual resolution refuses different amounts and already-linked transactions', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s = await repo.loadSnapshot();
    await expect(confirmCaseOnly(repo, { receiptId: 'R-103', transactionId: txIdByRef(s, 'S-102'), reason: TOUR_REASON })).rejects.toThrow(
      'Amounts differ. Partial and split payments are not supported in this prototype.',
    );
    await confirmCaseOnly(repo, { receiptId: 'R-105', transactionId: txIdByRef(s, 'S-105A'), reason: 'Parking ticket time matches' });
    const after = await repo.loadSnapshot();
    // A second receipt can't take the linked row.
    const err = await confirmCaseOnly(repo, { receiptId: 'R-102', transactionId: txIdByRef(s, 'S-105A'), reason: TOUR_REASON }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyLinkedError);
    expect((err as Error).message).toBe('That card transaction is already linked to R-105.');
    const linked = await recordProposal(repo, { ...viewOf(s).caseById.get('R-101')!.proposal!, transactionId: txIdByRef(s, 'S-105A') }).catch((e: unknown) => e);
    expect(linked).toBeInstanceOf(StaleProposalError);
    expect(await repo.loadSnapshot()).toEqual(after);
  });

  it('T09 the unique index refuses a second active link even if domain checks were bypassed', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    await confirmCaseOnly(repo, { receiptId: 'R-105', transactionId: txIdByRef(await repo.loadSnapshot(), 'S-105A'), reason: 'Parking ticket time matches' });
    const s = await repo.loadSnapshot();
    const m = s.matches[0]!;
    const err = await repo
      .unitOfWork(['matches'], (_state, w) => w.put('matches', { ...m, id: 'M-0099', subject: { kind: 'receipt', id: 'R-101' }, activeSubjectKey: 'receipt:R-101' }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlreadyLinkedError);
    expect(await repo.loadSnapshot()).toEqual(s);
  });

  it('T15 a ready proposal is revalidated at commit: suspension of its alias refuses the record', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    const shown = viewOf(await repo.loadSnapshot()).caseById.get('R-103')!.proposal!;
    await suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label');
    const s = await repo.loadSnapshot();
    const e = await recordProposal(repo, shown).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StaleProposalError);
    expect((e as StaleProposalError).reason).toBe('rule_changed');
    expect(await repo.loadSnapshot()).toEqual(s);
  });

  it('T16 suspending the alias sends dependent cases back to review, keeps history and recorded entries, and audits both events', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    const s0 = await repo.loadSnapshot();
    await recordProposal(repo, viewOf(s0).caseById.get('R-201')!.proposal!);
    const s1 = await repo.loadSnapshot();
    const { affected } = await suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label');
    expect(affected).toEqual(['R-103', 'R-202']);
    const s2 = await repo.loadSnapshot();
    expect(s2.ruleHeads[0]).toMatchObject({ status: 'suspended', activeVersion: null, lastApprovedVersion: 1 });
    expect(s2.ruleVersions).toEqual(s1.ruleVersions);
    expect(s2.ledger).toEqual(s1.ledger);
    const v = viewOf(s2);
    expect(v.caseById.get('R-103')!.group).toBe('needs_decision');
    expect(v.caseById.get('R-202')!.group).toBe('needs_decision');
    expect(v.caseById.get('R-201')!.group).toBe('recorded');
    expect(s2.audit.slice(-2).map((a) => [a.action, a.reason])).toEqual([
      ['rule.suspended', 'Checking the card label'],
      ['proposals.invalidated', null],
    ]);

    // Reactivation needs a fresh preview and creates no new version.
    await expect(reactivateRule(repo, 'K-ALIAS-0001', null)).rejects.toThrow('Preview the impact first');
    const fp = previewImpact(asWorkspaceState(s2), { kind: 'reactivate', ruleId: 'K-ALIAS-0001', version: s2.ruleVersions[0]! }).stateFingerprint;
    await reactivateRule(repo, 'K-ALIAS-0001', fp);
    const s3 = await repo.loadSnapshot();
    expect(s3.ruleHeads[0]).toMatchObject({ status: 'active', activeVersion: 1, currentVersion: 1 });
    expect(viewOf(s3).caseById.get('R-103')!.group).toBe('ready');
  });

  it('M3 loadDemoBatch sets tourStep in its unit of work; advanceTourStep writes only the step, with no audit or tick', async () => {
    const repo = demoRepo();
    await loadDemoBatch(repo, 1, assets);
    const s1 = await repo.loadSnapshot();
    expect(s1.demoState).toEqual({ loadedBatches: [1], tourStep: 1, clockTick: 1 });
    expect(await advanceTourStep(repo, 2)).toBe(true);
    const s2 = await repo.loadSnapshot();
    expect(s2.demoState).toEqual({ loadedBatches: [1], tourStep: 2, clockTick: 1 });
    expect(s2.audit).toEqual(s1.audit);
    expect(await advanceTourStep(repo, 2)).toBe(false);
    await expect(loadDemoBatch(repo, 4 as never, assets)).rejects.toThrow('Batch 4 is not available.');
    await expect(loadDemoBatch(repo, 3, assets)).rejects.toThrow('Load Batch 2 first.');
    await loadDemoBatch(repo, 2, assets);
    expect((await repo.loadSnapshot()).demoState.tourStep).toBe(3);
    await loadDemoBatch(repo, 3, assets);
    expect((await repo.loadSnapshot()).demoState).toMatchObject({ loadedBatches: [1, 2, 3], tourStep: 4 });
    expect(COMMAND_AUDIT.advanceTourStep).toEqual([]);
    expect(Object.keys(COMMAND_AUDIT).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it('demo IDs and timestamps replay identically (fixed demo clock, no randomness)', async () => {
    const a = await repoAfterTour();
    const b = await repoAfterTour();
    expect(await a.loadSnapshot()).toEqual(await b.loadSnapshot());
    const s = await a.loadSnapshot();
    expect(s.audit[0]!.at).toBe('2026-03-31T09:00:01.000Z');
    expect(s.audit.map((e) => e.id)[0]).toBe('A-000001');
  });
});

async function repoAfterTour() {
  const repo = await tourToConfirmedR102();
  await teachAlias(repo);
  await loadDemoBatch(repo, 2, assets);
  return repo;
}
