import { describe, expect, it } from 'vitest';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { aliasRule, input, receipt, tx } from '../builders';

describe('performance guard (NFR-3)', () => {
  it('evaluates 500 receipts × 2,000 card transactions with a median under 200 ms', () => {
    const day = (d: number) => `2026-03-${String((d % 28) + 1).padStart(2, '0')}`;
    const receipts = Array.from({ length: 500 }, (_, i) =>
      receipt({ id: `R-${String(i + 1).padStart(4, '0')}`, merchant: `Shop ${i % 50}`, date: day(i), amount: 1000 + (i % 97) * 10, doc: `DOC-${i}` }),
    );
    const transactions = Array.from({ length: 2000 }, (_, i) =>
      tx({ file: 'perf.csv', row: i + 2, ref: `S-${i + 1}`, label: i % 3 === 0 ? 'MC COFFEE HK' : `SHOP ${i % 50}`, posting: day(i + 1), amount: 1000 + (i % 97) * 10 }),
    );
    const inp = input({ receipts, transactions, activeRules: [aliasRule()] });
    const times: number[] = [];
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      const result = evaluateWorkspace(inp);
      times.push(performance.now() - t0);
      expect(result.proposals.size).toBe(500);
    }
    times.sort((a, b) => a - b);
    expect(times[2]!).toBeLessThan(200);
  });
});
