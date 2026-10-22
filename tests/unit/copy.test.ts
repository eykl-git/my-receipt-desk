/**
 * "COPY denylist" (design §15.1, REQ-1.3): no overclaims in any string the app
 * authors. S1 scans every string literal, template part and JSX text in
 * src/**, plus README.md and ASSURANCE.md (required since S7; a missing file
 * fails). Generated KNOWLEDGE.md and CSV outputs are added in S4.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { knowledgeMarkdown } from '../../src/domain/knowledge/exportJson';
import { exceptionsCsv, ledgerCsv } from '../../src/domain/ledger/exportCsv';
import { loadDemoBatch, newRecordRun, recordAllReady } from '../../src/persistence/commands';
import { asWorkspaceState } from '../../src/persistence/commands/context';
import { assets, teachAlias, tourToConfirmedR102, viewOf } from '../helpers/tour';

const DENYLIST: RegExp[] = [
  /\baccuracy\b/i,
  /\d+\s*% errors?/i,
  /0% error/i,
  /\bconfidence\b/i,
  /hours saved/i,
  /time saved/i,
  /labou?r sav/i,
  /retrain/i,
  /\bcompliant\b/i,
  /\bcertified\b/i,
  /tamper-proof/i,
  /\bsecure\b/i,
];

/** Exact strings removed before the denylist runs (the only permitted occurrences). */
const ALLOWLIST = [
  'The AI model is not being retrained.',
  'Inspectable local log. It is not tamper-proof.',
  'The local audit log is inspectable but not tamper-proof.',
  'This prototype makes no production security claims.',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? sourceFiles(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

export function extractTexts(fileName: string, text: string): string[] {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      out.push(node.text);
    } else if (ts.isJsxText(node)) {
      out.push(node.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function hits(text: string): string[] {
  let t = text;
  for (const allowed of ALLOWLIST) t = t.split(allowed).join(' ');
  return DENYLIST.filter((re) => re.test(t)).map((re) => re.source);
}

describe('COPY denylist', () => {
  it('COPY denylist: no overclaims in src literals, JSX text or docs', () => {
    const root = process.cwd();
    const findings: string[] = [];
    for (const file of sourceFiles(join(root, 'src'))) {
      for (const s of extractTexts(file, readFileSync(file, 'utf8'))) {
        for (const h of hits(s)) findings.push(`${relative(root, file)}: /${h}/ in ${JSON.stringify(s.slice(0, 80))}`);
      }
    }
    for (const doc of ['README.md', 'ASSURANCE.md']) {
      const p = join(root, doc);
      if (!existsSync(p)) {
        findings.push(`${doc}: missing (required since S7)`);
        continue;
      }
      for (const h of hits(readFileSync(p, 'utf8'))) findings.push(`${doc}: /${h}/`);
    }
    expect(findings).toEqual([]);
  });

  it('COPY denylist: generated KNOWLEDGE.md, ledger CSV and exceptions CSV from a full alias-path demo run', async () => {
    const repo = await tourToConfirmedR102();
    await teachAlias(repo);
    await loadDemoBatch(repo, 2, assets);
    await loadDemoBatch(repo, 3, assets);
    await recordAllReady(repo, newRecordRun(), viewOf(await repo.loadSnapshot()).groups.ready.map((c) => c.proposal!));
    const s = await repo.loadSnapshot();
    const state = asWorkspaceState(s);
    const outputs = {
      'KNOWLEDGE.md': knowledgeMarkdown(state, new Map()),
      'ledger.csv': ledgerCsv(state),
      'exceptions.csv': exceptionsCsv(state, viewOf(s)),
    };
    const findings = Object.entries(outputs).flatMap(([name, text]) => hits(text).map((h) => `${name}: /${h}/`));
    expect(findings).toEqual([]);
  });

  it('COPY denylist catches overclaims and honours the exact allowlist', () => {
    expect(hits('95% accuracy')).not.toEqual([]);
    expect(hits('0% errors')).not.toEqual([]);
    expect(hits('The model retrains on your data')).not.toEqual([]);
    expect(hits('Fully compliant and certified')).toHaveLength(2);
    expect(hits('The AI model is not being retrained.')).toEqual([]);
    expect(hits('Inspectable local log. It is not tamper-proof.')).toEqual([]);
    expect(extractTexts('x.tsx', 'const a = <p>Hours saved: {n}</p>; const b = `x ${1} secure`;').flatMap(hits)).toHaveLength(2);
  });
});
