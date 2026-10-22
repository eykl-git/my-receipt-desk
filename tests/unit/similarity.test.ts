/**
 * K03 similarity ranking (brief §25 C, task 4.5): a pure, deterministic
 * ordering aid. It changes the order of near candidates in the case view and
 * the manual picker only; evaluation outcomes, groups and fingerprints are
 * identical with or without it, and no number is ever shown.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { pickerCandidates } from '../../src/domain/matching/manual';
import { labelSimilarity, rankBySimilarity, sharedWordHint, sharedWords } from '../../src/domain/matching/similarity';
import { input, receipt, tx } from '../builders';

const rows = [
  tx({ row: 2, ref: 'S-1', label: 'PACIFIC COFFEE HOUSE', posting: '2026-03-05', amount: 4800 }),
  tx({ row: 3, ref: 'S-2', label: 'HARBOUR COFFEE HOUSE 12', posting: '2026-03-05', amount: 4800 }),
  tx({ row: 4, ref: 'S-3', label: 'ZZ MART', posting: '2026-03-05', amount: 4800 }),
];
const r = receipt({ id: 'R-1', merchant: 'Harbour Coffee', date: '2026-03-04', amount: 4800 });

describe('K03 label similarity (ordering only)', () => {
  it('K03 is symmetric, deterministic and higher for labels that share words', () => {
    expect(labelSimilarity('HARBOUR COFFEE HOUSE 12', 'Harbour Coffee')).toBe(labelSimilarity('Harbour Coffee', 'HARBOUR COFFEE HOUSE 12'));
    expect(labelSimilarity('HARBOUR COFFEE HOUSE 12', 'Harbour Coffee')).toBe(labelSimilarity('HARBOUR COFFEE HOUSE 12', 'Harbour Coffee'));
    expect(labelSimilarity('HARBOUR COFFEE HOUSE 12', 'Harbour Coffee')).toBeGreaterThan(labelSimilarity('PACIFIC COFFEE HOUSE', 'Harbour Coffee'));
    expect(labelSimilarity('PACIFIC COFFEE HOUSE', 'Harbour Coffee')).toBeGreaterThan(labelSimilarity('ZZ MART', 'Harbour Coffee'));
    expect(labelSimilarity('XYZ', 'Harbour Coffee')).toBe(0);
  });

  it('K03 orders near candidates by similarity, ties by ID, and never drops or adds a row', () => {
    const ranked = rankBySimilarity(rows, 'Harbour Coffee').map((t) => t.reference);
    expect(ranked).toEqual(['S-2', 'S-1', 'S-3']);
    const tie = [rows[2]!, { ...rows[2]!, id: `${rows[2]!.id.slice(0, -1)}0`, reference: 'S-0' }];
    expect(rankBySimilarity(tie, 'Harbour Coffee').map((t) => t.reference)).toEqual(['S-0', 'S-3']);
    expect(rankBySimilarity(rows, 'Harbour Coffee')).toHaveLength(rows.length);
  });

  it('K03 the only visible output is "Shares the word “X”" for a shared word of 3+ characters', () => {
    expect(sharedWordHint('HARBOUR COFFEE HOUSE 12', 'Harbour Coffee')).toBe('Shares the word “HARBOUR”');
    expect(sharedWords('MC COFFEE HK', 'Morning Coffee')).toEqual(['COFFEE']);
    expect(sharedWordHint('MC COFFEE HK', 'Morning Cup')).toBeNull();
    expect(sharedWordHint('HK MC', 'MC HK')).toBeNull();
    expect(sharedWordHint('PACIFIC COFFEE HOUSE', 'Harbour Coffee')).toBe('Shares the word “COFFEE”');
    expect(sharedWordHint('ZZ MART', 'Harbour Coffee')).toBeNull();
  });

  it('K03 the manual picker orders equal-lag rows by similarity and shows the hint as a tag; the engine output is unchanged', () => {
    const ev = input({ receipts: [{ ...r, fields: { ...r.fields } }], transactions: rows });
    const picker = pickerCandidates(ev, 'R-1');
    expect(picker.map((p) => p.transaction.reference)).toEqual(['S-2', 'S-1', 'S-3']);
    expect(picker[0]!.tags).toContain('Shares the word “HARBOUR”');
    expect(picker.flatMap((p) => p.tags).join(' ')).not.toMatch(/\d+\s*%|score/i);
    // Engine outcome and fingerprint do not depend on similarity: reversing the rows changes nothing.
    const a = evaluateWorkspace(ev).proposals.get('R-1')!;
    const b = evaluateWorkspace(input({ receipts: [r], transactions: [...rows].reverse() })).proposals.get('R-1')!;
    expect(a.outcome).toBe('unmatched');
    expect(b).toEqual(a);
  });

  it('K03 similarity is not used by the engine (grep)', () => {
    for (const file of ['evaluate.ts', 'context.ts', 'fingerprint.ts', 'caseView.ts', 'revalidate.ts']) {
      const text = readFileSync(join(process.cwd(), 'src/domain/matching', file), 'utf8');
      expect(text, file).not.toMatch(/similarity/i);
    }
  });
});
