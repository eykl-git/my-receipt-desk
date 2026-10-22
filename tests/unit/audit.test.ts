/**
 * T21 audit entries link each committed change to evidence and rule versions
 * (design §4.1, REQ-14.2, REQ-14.3, M3). The test iterates `COMMAND_AUDIT`:
 * every exported command must have scenarios here (a command missing from the
 * table or from this map fails), every event a scenario writes must be in its
 * command's list, the scenarios together must write every listed action, and
 * commands with an empty list must write no audit event at all.
 */
import { expect, it } from 'vitest';
import type { ExtractionResult } from '../../src/domain/capture/adapter';
import { exportKnowledge } from '../../src/domain/knowledge/exportJson';
import { prefillDraftFromCase } from '../../src/domain/knowledge/prefill';
import { previewImpact } from '../../src/domain/knowledge/preview';
import { recheckRecorded } from '../../src/domain/knowledge/recheck';
import { toDraftContent } from '../../src/domain/knowledge/schema';
import type { AuditEvent } from '../../src/domain/schemas';
import {
  activateRule,
  addPayable,
  addReceipts,
  advanceTourStep,
  applyExtraction,
  attachPayment,
  COMMAND_AUDIT,
  COMMANDS,
  confirmCaseOnly,
  confirmCategory,
  createDraft,
  discardDraft,
  editRule,
  importKnowledge,
  loadDemoBatch,
  newRecordRun,
  reactivateRule,
  recheckKeep,
  recheckVoid,
  recordAllReady,
  recordProposal,
  recordStatementOnly,
  rejectDuplicateImport,
  resolveDuplicate,
  resolveStatementDuplicate,
  saveFields,
  setWorkspaceCurrency,
  suspendRule,
  unlinkReceipt,
  updateDraft,
  voidEntry,
} from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import type { Repository } from '../../src/persistence/repository';
import { describeEachRepo } from '../helpers/repos';
import { addReceipt, importCsv, personalRepo, png, txByLabel } from '../helpers/personal';
import { assets, demoRepo, teachAlias, tourToConfirmedR102, TOUR_REASON, txIdByRef, viewOf } from '../helpers/tour';

type CommandName = keyof typeof COMMANDS;
interface Scenario {
  repo: Repository;
  run: () => Promise<unknown>;
}

const CSV = [
  'Date,Posted,Details,Amount,Currency',
  '2026-04-02,2026-04-03,PAGE CORNER,-120.00,HKD',
  '2026-04-05,2026-04-06,HARBOUR PRINT LTD,-350.00,HKD',
  '',
].join('\n');
const INVOICE = { supplierName: 'Harbour Print Ltd', invoiceNumber: 'HP-1', invoiceDate: '2026-04-01', amount: '350.00', currency: 'HKD' };

async function batch1() {
  const repo = demoRepo();
  await loadDemoBatch(repo, 1, assets);
  return repo;
}
async function taught() {
  const repo = await tourToConfirmedR102();
  await teachAlias(repo);
  return repo;
}
async function proposalOf(repo: Repository, id: string) {
  return viewOf(await repo.loadSnapshot()).caseById.get(id)!.proposal!;
}
/** R-103 recorded through K-ALIAS-0001 v1, then the alias suspended: R-103's entry needs a re-check. */
async function needsRecheck() {
  const repo = await taught();
  await recordProposal(repo, await proposalOf(repo, 'R-103'));
  await suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label');
  const item = recheckRecorded(asWorkspaceState(await repo.loadSnapshot())).find((i) => i.receiptId === 'R-103')!;
  return { repo, ledgerEntryId: item.ledgerEntryId };
}
async function invoicePaid() {
  const repo = personalRepo();
  await importCsv(repo, CSV);
  await addPayable(repo, await png('inv.png'), INVOICE);
  const s = await repo.loadSnapshot();
  const { ledgerEntryId } = await attachPayment(repo, 'INV-0001', txByLabel(s, 'HARBOUR PRINT LTD'), 'Paid by card');
  return { repo, ledgerEntryId };
}
function ocrExtraction(): ExtractionResult {
  const p = { adapterId: 'ocr-test', kind: 'ocr' as const };
  return {
    merchant: { value: 'Page Corner', raw: 'PAGE CORNER', clarity: 'clear', provenance: p },
    date: { value: '2026-04-02' as ExtractionResult['date']['value'], raw: '02/04/2026', clarity: 'clear', provenance: p },
    amountMinor: { value: 12000, raw: '120.00', clarity: 'clear', provenance: p },
    currency: { value: 'HKD', raw: 'HK$', clarity: 'clear', provenance: p },
    printedText: 'PAGE CORNER\nTOTAL 120.00',
    warnings: [],
  };
}

const SCENARIOS: Record<CommandName, Array<() => Promise<Scenario>>> = {
  addReceipts: [
    async () => {
      const repo = personalRepo();
      const first = await png('a.png');
      await addReceipts(repo, [first]);
      const second = await png('b.png');
      return { repo, run: () => addReceipts(repo, [second, first]) };
    },
  ],
  addPayable: [
    async () => {
      const repo = personalRepo();
      return { repo, run: async () => addPayable(repo, await png('i.png'), INVOICE) };
    },
    async () => {
      const repo = personalRepo();
      const file = await png('j.png');
      await addPayable(repo, file, INVOICE);
      return { repo, run: () => addPayable(repo, file, INVOICE) };
    },
  ],
  applyExtraction: [
    async () => {
      const repo = personalRepo();
      const { added } = await addReceipts(repo, [await png('ocr.png')]);
      return { repo, run: () => applyExtraction(repo, added[0]!, { id: 'ocr-test', kind: 'ocr' }, ocrExtraction()) };
    },
  ],
  saveFields: [
    async () => {
      const repo = personalRepo();
      const { added } = await addReceipts(repo, [await png('s.png')]);
      return { repo, run: () => saveFields(repo, added[0]!, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00', currency: 'HKD' }) };
    },
  ],
  resolveDuplicate: [
    async () => {
      const repo = personalRepo();
      await addReceipt(repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
      const second = await addReceipt(repo, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
      return { repo, run: () => resolveDuplicate(repo, second, 'distinct') };
    },
  ],
  importStatement: [
    async () => {
      const repo = personalRepo();
      return { repo, run: () => importCsv(repo, CSV) };
    },
  ],
  rejectDuplicateImport: [
    async () => {
      const repo = personalRepo();
      await importCsv(repo, CSV, 'card.csv');
      const s = await repo.loadSnapshot();
      return { repo, run: () => rejectDuplicateImport(repo, { fileName: 'card-again.csv', sha256: s.sourceDocuments[0]!.sha256 }) };
    },
  ],
  resolveStatementDuplicate: [
    async () => {
      const repo = personalRepo();
      await importCsv(repo, CSV, 'march.csv');
      await importCsv(repo, `${CSV}2026-04-09,2026-04-10,CITY PARKING,-30.00,HKD\n`, 'march-again.csv');
      const s = await repo.loadSnapshot();
      const flagged = s.transactions.filter((t) => t.duplicateSuspected).map((t) => t.id);
      expect(flagged).toHaveLength(2);
      return {
        repo,
        run: async () => {
          await resolveStatementDuplicate(repo, flagged[0]!, 'keep');
          await resolveStatementDuplicate(repo, flagged[1]!, 'set_aside');
        },
      };
    },
  ],
  loadDemoBatch: [
    async () => {
      const repo = demoRepo();
      return { repo, run: () => loadDemoBatch(repo, 1, assets) };
    },
    async () => {
      const repo = await batch1();
      return { repo, run: () => loadDemoBatch(repo, 2, assets) };
    },
  ],
  advanceTourStep: [
    async () => {
      const repo = await batch1();
      return { repo, run: () => advanceTourStep(repo, 2) };
    },
  ],
  recordProposal: [
    async () => {
      const repo = await batch1();
      return { repo, run: async () => recordProposal(repo, await proposalOf(repo, 'R-101')) };
    },
    async () => {
      const repo = await batch1();
      await recordStatementOnly(repo, txIdByRef(await repo.loadSnapshot(), 'S-101'));
      return { repo, run: async () => recordProposal(repo, await proposalOf(repo, 'R-101')) };
    },
  ],
  confirmCaseOnly: [
    async () => {
      const repo = await batch1();
      return { repo, run: async () => confirmCaseOnly(repo, { receiptId: 'R-102', transactionId: txIdByRef(await repo.loadSnapshot(), 'S-102'), reason: TOUR_REASON }) };
    },
    async () => {
      const repo = await batch1();
      const s102 = txIdByRef(await repo.loadSnapshot(), 'S-102');
      await recordStatementOnly(repo, s102);
      return { repo, run: () => confirmCaseOnly(repo, { receiptId: 'R-102', transactionId: s102, reason: TOUR_REASON }) };
    },
  ],
  recordAllReady: [
    async () => {
      const repo = await taught();
      return { repo, run: async () => recordAllReady(repo, newRecordRun(), viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!)) };
    },
    async () => {
      const repo = await batch1();
      await recordStatementOnly(repo, txIdByRef(await repo.loadSnapshot(), 'S-101'));
      return { repo, run: async () => recordAllReady(repo, newRecordRun(), viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!)) };
    },
  ],
  recordStatementOnly: [
    async () => {
      const repo = await batch1();
      return { repo, run: async () => recordStatementOnly(repo, txIdByRef(await repo.loadSnapshot(), 'S-104')) };
    },
  ],
  attachPayment: [
    async () => {
      const repo = personalRepo();
      await importCsv(repo, CSV);
      await addPayable(repo, await png('p.png'), INVOICE);
      return { repo, run: async () => attachPayment(repo, 'INV-0001', txByLabel(await repo.loadSnapshot(), 'HARBOUR PRINT LTD'), 'Paid by card') };
    },
    async () => {
      const repo = personalRepo();
      await importCsv(repo, CSV);
      const t = txByLabel(await repo.loadSnapshot(), 'HARBOUR PRINT LTD');
      await recordStatementOnly(repo, t);
      await addPayable(repo, await png('q.png'), INVOICE);
      return { repo, run: () => attachPayment(repo, 'INV-0001', t, 'Paid by card') };
    },
  ],
  confirmCategory: [
    async () => {
      const repo = await batch1();
      await recordProposal(repo, await proposalOf(repo, 'R-101'));
      return { repo, run: () => confirmCategory(repo, 'R-101', 'books') };
    },
  ],
  voidEntry: [
    async () => {
      const { repo, ledgerEntryId } = await invoicePaid();
      return { repo, run: () => voidEntry(repo, ledgerEntryId, 'Wrong card row') };
    },
  ],
  unlinkReceipt: [
    async () => {
      const repo = await batch1();
      const { ledgerEntryId } = await recordStatementOnly(repo, txIdByRef(await repo.loadSnapshot(), 'S-101'));
      await recordProposal(repo, await proposalOf(repo, 'R-101'));
      return { repo, run: () => unlinkReceipt(repo, ledgerEntryId, 'R-101', 'Belongs elsewhere') };
    },
  ],
  createDraft: [
    async () => {
      const repo = await tourToConfirmedR102();
      const s = await repo.loadSnapshot();
      const prefill = prefillDraftFromCase({ receipt: s.receipts.find((r) => r.id === 'R-102')!, proposal: null, matches: s.matches, transactions: s.transactions, activeRules: [] });
      if (prefill.kind !== 'alias') throw new Error('expected alias');
      return { repo, run: () => createDraft(repo, prefill.draft) };
    },
  ],
  editRule: [
    async () => {
      const repo = await taught();
      const v1 = (await repo.loadSnapshot()).ruleVersions[0]!;
      return { repo, run: () => editRule(repo, 'K-ALIAS-0001', toDraftContent(v1)) };
    },
  ],
  updateDraft: [
    async () => {
      const repo = await taught();
      const v1 = (await repo.loadSnapshot()).ruleVersions[0]!;
      await editRule(repo, 'K-ALIAS-0001', toDraftContent(v1));
      return { repo, run: () => updateDraft(repo, 'K-ALIAS-0001', 2, { ...toDraftContent(v1), plainEnglish: `${v1.plainEnglish} Edited.` }) };
    },
  ],
  discardDraft: [
    async () => {
      const repo = await taught();
      await editRule(repo, 'K-ALIAS-0001', toDraftContent((await repo.loadSnapshot()).ruleVersions[0]!));
      return { repo, run: () => discardDraft(repo, 'K-ALIAS-0001') };
    },
  ],
  activateRule: [
    async () => {
      const repo = await taught();
      await loadDemoBatch(repo, 2, assets);
      await editRule(repo, 'K-ALIAS-0001', toDraftContent((await repo.loadSnapshot()).ruleVersions[0]!));
      return {
        repo,
        run: async () => {
          const s = await repo.loadSnapshot();
          const v2 = s.ruleVersions.find((v) => v.version === 2)!;
          return activateRule(repo, 'K-ALIAS-0001', 2, previewImpact(asWorkspaceState(s), { kind: 'activate', version: v2 }).stateFingerprint);
        },
      };
    },
  ],
  suspendRule: [
    async () => {
      const repo = await taught();
      return { repo, run: () => suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label') };
    },
    // No pending proposal depends on the rule any more: the invalidation event still names the rule.
    async () => {
      const repo = await taught();
      await recordProposal(repo, await proposalOf(repo, 'R-103'));
      return { repo, run: () => suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label') };
    },
  ],
  reactivateRule: [
    async () => {
      const repo = await taught();
      await suspendRule(repo, 'K-ALIAS-0001', 'Checking the card label');
      return {
        repo,
        run: async () => {
          const s = await repo.loadSnapshot();
          const fp = previewImpact(asWorkspaceState(s), { kind: 'reactivate', ruleId: 'K-ALIAS-0001', version: s.ruleVersions[0]! }).stateFingerprint;
          return reactivateRule(repo, 'K-ALIAS-0001', fp);
        },
      };
    },
  ],
  recheckKeep: [
    async () => {
      const { repo, ledgerEntryId } = await needsRecheck();
      return { repo, run: () => recheckKeep(repo, ledgerEntryId) };
    },
  ],
  recheckVoid: [
    async () => {
      const { repo, ledgerEntryId } = await needsRecheck();
      return { repo, run: () => recheckVoid(repo, ledgerEntryId, 'Recorded through a suspended name') };
    },
  ],
  setWorkspaceCurrency: [
    async () => {
      const repo = personalRepo();
      return { repo, run: () => setWorkspaceCurrency(repo, 'MYR') };
    },
  ],
  importKnowledge: [
    async () => {
      const demo = await taught();
      const text = JSON.stringify(exportKnowledge(asWorkspaceState(await demo.loadSnapshot()), 'demo', '2026-04-20T10:00:00.000Z'));
      const repo = personalRepo();
      return { repo, run: () => importKnowledge(repo, 'knowledge.json', text) };
    },
  ],
};

const EVIDENCE_ACTIONS = new Set(['match.confirmed', 'match.released', 'ledger.recorded', 'ledger.evidence_attached', 'ledger.evidence_detached', 'ledger.voided', 'ledger.category_changed', 'payable.paid', 'payable.reopened', 'recheck.kept', 'capture.receipt_added', 'capture.payable_added', 'capture.fields_confirmed', 'capture.fields_extracted', 'import.statement_committed', 'demo.batch_loaded']);

function checkEvent(e: AuditEvent): void {
  expect(e.affected.length, `${e.action} has affected IDs`).toBeGreaterThan(0);
  for (const a of e.affected) expect(a.id.length).toBeGreaterThan(0);
  if (EVIDENCE_ACTIONS.has(e.action)) expect(e.evidenceRefs.length, `${e.action} has evidence refs`).toBeGreaterThan(0);
  if (e.action.startsWith('rule.') || e.action === 'proposals.invalidated') expect(e.ruleRefs.length, `${e.action} has rule versions`).toBeGreaterThan(0);
  expect(e.actor === 'local-owner' || e.actor === 'system').toBe(true);
  expect(e.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
}

describeEachRepo('T21 audit entries', () => {
  it('T21 every exported command has scenarios here and a row in COMMAND_AUDIT', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(COMMANDS).sort());
    expect(Object.keys(COMMAND_AUDIT).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  for (const name of Object.keys(COMMANDS) as CommandName[]) {
    const listed = COMMAND_AUDIT[name];
    it(`T21 ${name} writes ${listed.length === 0 ? 'no audit event' : listed.join(', ')}`, async () => {
      const seen = new Set<string>();
      for (const make of SCENARIOS[name]) {
        const { repo, run } = await make();
        const before = await repo.loadSnapshot();
        await run();
        const after = await repo.loadSnapshot();
        const events = after.audit.slice(before.audit.length);
        // Sequence numbers continue without gaps; earlier events are never rewritten.
        expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
        events.forEach((e, i) => expect(e.seq).toBe((before.audit.at(-1)?.seq ?? 0) + i + 1));
        for (const e of events) {
          expect(listed, `${name} wrote ${e.action}`).toContain(e.action);
          checkEvent(e);
          seen.add(e.action);
        }
        if (listed.length === 0) {
          // M3: empty-list commands write no audit event.
          expect(events).toEqual([]);
        }
      }
      expect([...seen].sort()).toEqual([...listed].sort());
    });
  }

  it('T21 R-103’s match event lists K-ALIAS-0001 v1, and its entry links the receipt, the card transaction and the rule version', async () => {
    const repo = await taught();
    await recordProposal(repo, await proposalOf(repo, 'R-103'));
    const s = await repo.loadSnapshot();
    const [matchEvent, ledgerEvent] = s.audit.slice(-2);
    expect(matchEvent!.action).toBe('match.confirmed');
    expect(matchEvent!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(matchEvent!.affected.map((a) => a.id)).toEqual(expect.arrayContaining(['R-103', txIdByRef(s, 'S-103')]));
    expect(matchEvent!.evidenceRefs).toEqual(expect.arrayContaining([{ kind: 'receipt', ref: 'R-103' }, { kind: 'transaction', ref: txIdByRef(s, 'S-103') }]));
    expect(ledgerEvent!.action).toBe('ledger.recorded');
    expect(ledgerEvent!.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    const entry = s.ledger.find((e) => e.evidence.receiptIds.includes('R-103'))!;
    expect(entry.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(ledgerEvent!.affected.map((a) => a.id)).toContain(entry.id);
    // Activation itself is audited with the rule version and the cases it affected.
    const activation = s.audit.find((e) => e.action === 'rule.activated')!;
    expect(activation.ruleRefs).toEqual([{ ruleId: 'K-ALIAS-0001', version: 1 }]);
    expect(activation.affected.map((a) => a.id)).toEqual(['K-ALIAS-0001', 'R-103']);
  });

  it('T21 corrections keep provenance: a manual match records the reason, and field corrections keep before/after', async () => {
    const repo = await tourToConfirmedR102();
    const s = await repo.loadSnapshot();
    const m = s.audit.find((e) => e.action === 'match.confirmed')!;
    expect(m.reason).toBe(TOUR_REASON);
    expect(s.matches[0]!.method).toBe('manual_resolution');
    const personal = personalRepo();
    const id = await addReceipt(personal, { merchant: 'Page Corner', date: '2026-04-02', amount: '120.00' });
    await saveFields(personal, id, { merchant: 'Page Corner Books', date: '2026-04-02', amount: '120.00', currency: 'HKD' });
    const p = await personal.loadSnapshot();
    const fields = p.audit.filter((e) => e.action === 'capture.fields_confirmed').at(-1)!;
    expect(fields.before).toEqual({ merchant: 'Page Corner' });
    expect(fields.after).toMatchObject({ values: { merchant: 'Page Corner Books' } });
    // The original stays; the correction sits next to it.
    expect(p.receipts[0]!.fields.merchant.original.value).toBeNull();
    expect(p.receipts[0]!.fields.merchant.correction!.value).toBe('Page Corner Books');
  });
});
