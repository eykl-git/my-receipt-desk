/**
 * T18 formula injection and the exports (design §12.2, §12.3, N4), plus the
 * knowledge JSON export / import (N9) and KNOWLEDGE.md (generated, never parsed).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { escapeCell, EXCEPTION_COLUMNS, exceptionsCsv, LEDGER_COLUMNS, ledgerCsv } from '../../src/domain/ledger/exportCsv';
import { exportKnowledge, KNOWLEDGE_MD_HEADER, knowledgeMarkdown, planKnowledgeImport } from '../../src/domain/knowledge/exportJson';
import { aliasPlainEnglish, categoryPlainEnglish, exclusionsFor, policyPlainEnglish } from '../../src/domain/knowledge/plainEnglish';
import { addReceipts, COMMAND_AUDIT, importKnowledge, loadDemoBatch, newRecordRun, recordAllReady, saveFields } from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { exportGate } from '../../src/persistence/exportGate';
import { sha256Hex } from '../../src/persistence/hash';
import { assets, teachAlias, tourToConfirmedR102, viewOf } from '../helpers/tour';
import { describeEachRepo, makeRepo } from '../helpers/repos';

const parse = (csv: string) => {
  expect(csv.startsWith('\uFEFF')).toBe(true);
  expect(csv.includes('\r\n')).toBe(true);
  return Papa.parse<string[]>(csv.slice(1), { skipEmptyLines: true }).data;
};

async function demoAtStep4Recorded() {
  const repo = await tourToConfirmedR102();
  await teachAlias(repo);
  await loadDemoBatch(repo, 2, assets);
  await loadDemoBatch(repo, 3, assets);
  const shown = viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!);
  await recordAllReady(repo, newRecordRun(), shown);
  return repo;
}

describe('T18 formula-injection protection', () => {
  it('T18 text cells starting with = + - @, tab or CR (also after spaces) get a leading apostrophe; line breaks become spaces', () => {
    for (const bad of ['=HYPERLINK("http://x","y")', '+1', '-2', '@SUM(A1)', '\t=1', ' =1', '\r=1']) expect(escapeCell(bad), JSON.stringify(bad)).toBe(`'${bad.replace(/\r/g, ' ')}`);
    expect(escapeCell('Page Corner, Central')).toBe('Page Corner, Central');
    expect(escapeCell('two\nlines')).toBe('two lines');
  });

  it('T18 a hostile merchant is escaped in the ledger and exceptions CSVs while amount and date columns stay typed', async () => {
    const repo = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const { added } = await addReceipts(repo, [{ fileName: '=cmd.png', mimeType: 'image/png', bytes: png, sha256: await sha256Hex(png) }]);
    await saveFields(repo, added[0]!, { merchant: '=HYPERLINK("http://x","y")', date: '2026-03-02', amount: '12.00', currency: 'HKD' });
    const s = await repo.loadSnapshot();
    const rows = parse(exceptionsCsv(asWorkspaceState(s), viewOf(s)));
    expect(rows[0]).toEqual([...EXCEPTION_COLUMNS]);
    expect(rows[1]).toEqual(['R-0001', 'receipt', '2026-03-02', `'=HYPERLINK("http://x","y")`, '', '12.00', 'HKD', 'No card transaction with this amount and date yet', '', '']);
  });
});

describe('exports from the demo (T18, N4)', () => {
  it('T18 ledger CSV: columns, display-name category, typed cells, rule refs; KNOWLEDGE.md is generated', async () => {
    const repo = await demoAtStep4Recorded();
    const s = await repo.loadSnapshot();
    const rows = parse(ledgerCsv(asWorkspaceState(s)));
    expect(rows[0]).toEqual([...LEDGER_COLUMNS]);
    expect(rows).toHaveLength(8);
    const l1 = rows.find((r) => r[0] === 'L-0001')!;
    expect(l1.slice(0, 12)).toEqual(['L-0001', '2026-03-04', 'Morning Cup', '48.00', 'HKD', '', 'unassigned', 'recorded', 'confirmed', 'manual_resolution', 'R-102', l1[11]]);
    const r103 = rows.find((r) => r[10] === 'R-103')!;
    expect(r103[13]).toBe('K-ALIAS-0001 v1');
    expect(r103[9]).toBe('confirmed_proposal');
    for (const r of rows.slice(1)) {
      expect(r[3]).toMatch(/^\d+\.\d{2}$/);
      expect(r[1]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r[14]).toBe('ok');
    }
    const md = knowledgeMarkdown(asWorkspaceState(s), new Map([['acct:demo-card-1234', 'Demo Card ••1234']]));
    expect(md).toContain(KNOWLEDGE_MD_HEADER);
    expect(md).toContain('## K-ALIAS-0001 v1 (Active)');
    expect(md).toContain('- Scope: Card: Demo Card ••1234');
  });

  it('T18 (N4) exceptions CSV: R-104 amount is empty, card rows carry direction and their Reference as case_id', async () => {
    const repo = await demoAtStep4Recorded();
    const s = await repo.loadSnapshot();
    const rows = parse(exceptionsCsv(asWorkspaceState(s), viewOf(s)));
    const byId = new Map(rows.slice(1).map((r) => [r[0], r]));
    expect([...byId.keys()].sort()).toEqual(['R-104', 'R-105', 'R-301', 'R-302', 'S-302']);
    expect(byId.get('R-104')!.slice(0, 7)).toEqual(['R-104', 'receipt', '2026-03-08', 'Green Basket', '', '', 'HKD']);
    expect(byId.get('R-105')![9]).toBe('S-105A|S-105B');
    expect(byId.get('S-302')!.slice(0, 7)).toEqual(['S-302', 'card_transaction', '2026-03-26', 'HARBOUR BOOKS ONLINE', 'debit', '25.00', 'USD']);
  });

  it('T18 the export gate re-validates records and flags missing evidence', async () => {
    const repo = await demoAtStep4Recorded();
    const s = await repo.loadSnapshot();
    expect(await exportGate(repo, s)).toEqual({ ok: true, missingEvidence: new Set() });
    const broken = { ...s, receipts: s.receipts.filter((r) => r.id !== 'R-101') };
    const gate = await exportGate(repo, broken);
    expect(gate.ok && [...gate.missingEvidence]).toEqual([s.ledger.find((e) => e.evidence.receiptIds.includes('R-101'))!.id]);
    const bad = { ...s, ledger: [{ ...s.ledger[0]!, amountMinor: -5 }] };
    expect(await exportGate(repo, bad)).toEqual({ ok: false, message: `Export stopped: ${s.ledger[0]!.id} failed a check.` });
  });

  it('T18 KNOWLEDGE.md is never parsed: no source file fetches, imports or reads a markdown file', () => {
    const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
    for (const f of files(join(process.cwd(), 'src'))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/fetch\([^)]*\.md|from\s+['"][^'"]*\.md['"]|readAsText|\.md['"]\s*\)\s*\.then/);
    }
  });
});

describeEachRepo('knowledge JSON export and import', () => {
  it('knowledge export holds approved versions only; import creates drafts with fresh IDs and imported provenance in My files (N9)', async () => {
    const demo = await tourToConfirmedR102();
    await teachAlias(demo);
    const file = exportKnowledge(asWorkspaceState(await demo.loadSnapshot()), 'demo', '2026-04-20T10:00:00.000Z');
    expect(file.rules.map((r) => [r.head.ruleId, r.versions.map((v) => v.version)])).toEqual([['K-ALIAS-0001', [1]]]);

    const personal = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const text = JSON.stringify(file);
    const plan = planKnowledgeImport(text, asWorkspaceState(await personal.loadSnapshot()));
    expect(plan.ok && plan.drafts.map((d) => [d.source, d.findings.map((f) => f.code).sort()])).toEqual([['K-ALIAS-0001 v1', ['OVERBROAD']]]);
    expect(plan.ok && plan.drafts[0]!.findings.map((f) => f.message)).toContain('That card account is not in this workspace.');
    const result = await importKnowledge(personal, 'knowledge.json', text);
    expect(result.created).toEqual(['K-ALIAS-0001']);
    const s = await personal.loadSnapshot();
    expect(s.ruleHeads.map((h) => [h.ruleId, h.status, h.activeVersion, h.draftVersion])).toEqual([['K-ALIAS-0001', 'draft_only', null, 1]]);
    expect(s.ruleVersions[0]!.evidenceRefs).toEqual([{ kind: 'imported', ref: 'K-ALIAS-0001 v1' }]);
    expect(s.ruleVersions[0]!.approvedAt).toBeUndefined();
    expect(s.audit.map((a) => a.action)).toEqual(['rule.draft_created', 'knowledge.imported']);
    expect(COMMAND_AUDIT.importKnowledge).toEqual(['knowledge.imported', 'rule.draft_created']);

    // A second import gets fresh IDs again, never the source ID.
    expect((await importKnowledge(personal, 'knowledge.json', text)).created).toEqual(['K-ALIAS-0002']);
  });

  it('a malformed file is rejected as a whole with its issues listed and nothing written; a second policy rule is skipped', async () => {
    const personal = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const before = await personal.loadSnapshot();
    const bad = JSON.stringify({ format: 'my-receipt-desk/knowledge', schemaVersion: 1, exportedAt: 'x', workspace: 'demo', rules: [{ head: {}, versions: [] }] });
    await expect(importKnowledge(personal, 'bad.json', bad)).rejects.toThrow(/rules\.0\.head/);
    await expect(importKnowledge(personal, 'bad.json', '{nope')).rejects.toThrow('This file isn’t valid JSON.');
    expect(await personal.loadSnapshot()).toEqual(before);

    const policy = {
      type: 'posting_window', scope: { workspace: true }, condition: {}, action: { postingLagMaxDays: 5 },
      plainEnglish: 'p', exclusions: [], evidenceRefs: [], ownerId: 'local-owner', createdAt: '2026-04-20T10:00:00.000Z', approvedAt: '2026-04-20T10:00:00.000Z', approvedBy: 'local-owner',
    };
    const two = JSON.stringify({
      format: 'my-receipt-desk/knowledge', schemaVersion: 1, exportedAt: 'x', workspace: 'demo',
      rules: [
        { head: { ruleId: 'K-POLICY-0001', type: 'posting_window', status: 'active', activeVersion: 1, lastApprovedVersion: 1 }, versions: [{ ...policy, ruleId: 'K-POLICY-0001', version: 1 }] },
        { head: { ruleId: 'K-POLICY-0002', type: 'posting_window', status: 'active', activeVersion: 1, lastApprovedVersion: 1 }, versions: [{ ...policy, ruleId: 'K-POLICY-0002', version: 1 }] },
      ],
    });
    const r = await importKnowledge(personal, 'two.json', two);
    expect(r.created).toEqual(['K-POLICY-0001']);
    expect(r.skipped).toEqual([{ source: 'K-POLICY-0002 v1', message: 'A matching-policy rule already exists here. Edit it instead.' }]);
  });

  it('imported meaning and exclusions are regenerated from the structured fields; the file text is never kept (design §7.1)', async () => {
    const personal = makeRepo('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
    const meta = { ownerId: 'local-owner', createdAt: '2026-04-20T10:00:00.000Z', approvedAt: '2026-04-20T10:00:00.000Z', approvedBy: 'local-owner', evidenceRefs: [] };
    const file = JSON.stringify({
      format: 'my-receipt-desk/knowledge', schemaVersion: 1, exportedAt: 'x', workspace: 'demo',
      rules: [
        {
          head: { ruleId: 'K-POLICY-0001', type: 'posting_window', status: 'active', activeVersion: 1, lastApprovedVersion: 1 },
          versions: [{ ...meta, ruleId: 'K-POLICY-0001', version: 1, type: 'posting_window', scope: { workspace: true }, condition: {}, action: { postingLagMaxDays: 5 }, plainEnglish: 'p', exclusions: [] }],
        },
        {
          head: { ruleId: 'K-ALIAS-0001', type: 'merchant_alias', status: 'active', activeVersion: 1, lastApprovedVersion: 1 },
          versions: [{
            ...meta, ruleId: 'K-ALIAS-0001', version: 1, type: 'merchant_alias', scope: { accountId: 'acct:demo-card-1234' },
            condition: { observedLabel: 'PACIFIC COFFEE', match: 'exact_ignoring_store_number' },
            action: { canonicalMerchantId: 'm:pacific-coffee', canonicalMerchantName: 'Pacific Coffee' },
            plainEnglish: 'Guaranteed 100% accurate. Matches everything.', exclusions: ['Nothing'],
          }],
        },
        {
          head: { ruleId: 'K-CAT-0001', type: 'category_preference', status: 'active', activeVersion: 1, lastApprovedVersion: 1 },
          versions: [{ ...meta, ruleId: 'K-CAT-0001', version: 1, type: 'category_preference', scope: { workspace: true }, condition: { canonicalMerchantId: 'm:page-corner' }, action: { suggestCategoryId: 'office' }, plainEnglish: 'p', exclusions: [] }],
        },
      ],
    });
    const expected = [
      [policyPlainEnglish(5), exclusionsFor('posting_window')],
      [aliasPlainEnglish('PACIFIC COFFEE', null, 'Pacific Coffee', 'exact_ignoring_store_number'), exclusionsFor('merchant_alias', 'exact_ignoring_store_number')],
      [categoryPlainEnglish('page-corner', 'office'), exclusionsFor('category_preference')],
    ];
    const plan = planKnowledgeImport(file, asWorkspaceState(await personal.loadSnapshot()));
    expect(plan.ok && plan.drafts.map((d) => [d.draft.plainEnglish, d.draft.exclusions])).toEqual(expected);

    await importKnowledge(personal, 'knowledge.json', file);
    const s = await personal.loadSnapshot();
    const stored = ['K-POLICY-0001', 'K-ALIAS-0001', 'K-CAT-0001'].map((id) => s.ruleVersions.find((v) => v.ruleId === id)!);
    expect(stored.map((v) => [v.plainEnglish, v.exclusions])).toEqual(expected);
    expect(JSON.stringify(s.ruleVersions)).not.toContain('Guaranteed');
  });
});
