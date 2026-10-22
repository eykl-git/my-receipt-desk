import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatMinor, parseAmount, sumMinor } from '../../src/domain/money';
import { evaluateWorkspace } from '../../src/domain/matching/evaluate';
import { checkManualResolution } from '../../src/domain/matching/manual';
import type { ConfirmedMatch, LedgerEntry, Receipt, StatementTransaction } from '../../src/domain/schemas';
import { aliasRule, input, receipt, recorded, tx } from '../builders';
import { prefillMapping } from '../../src/domain/imports/mapping';
import { parseStatementCsv, readCsvGrid } from '../../src/domain/imports/parse';
import { importStatement } from '../../src/persistence/commands';
import { sha256Hex } from '../../src/persistence/hash';
import { MemoryRepository } from '../../src/persistence/memoryRepository';

describe('P1 money arithmetic (property)', () => {
  it('P1 parseAmount(formatMinor(n)) === n for every supported signed amount', () => {
    fc.assert(
      fc.property(fc.integer({ min: -999_999_999, max: 999_999_999 }), (n) => {
        const text = formatMinor(n);
        expect(text).toMatch(/^-?\d+\.\d{2}$/);
        expect(parseAmount(text)).toBe(n);
      }),
    );
  });

  it('P1 decimal text converts by integer arithmetic (no float drift)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 9_999_999 }), fc.integer({ min: 0, max: 99 }), (whole, cents) => {
        const text = `${whole}.${String(cents).padStart(2, '0')}`;
        expect(parseAmount(text)).toBe(whole * 100 + cents);
        expect(Number.isInteger(parseAmount(text))).toBe(true);
      }),
    );
    expect(sumMinor([parseAmount('0.10')!, parseAmount('0.20')!])).toBe(30);
    expect(parseAmount('1,234.5')).toBe(123450);
    for (const bad of ['1e3', '12.345', ' 12.00', 'HKD 12', '1,23.00', '', '.5', '12.']) expect(parseAmount(bad), bad).toBeNull();
  });

  it('P1 integer sums equal the arithmetic sum and reject non-integers', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -999_999_999, max: 999_999_999 }), { maxLength: 200 }), (xs) => {
        expect(sumMinor(xs)).toBe(xs.reduce((a, b) => a + b, 0));
      }),
    );
    expect(() => sumMinor([1, 0.5])).toThrow(RangeError);
  });
});

const MERCHANTS = [
  { name: 'Page Corner', label: 'PAGE CORNER' },
  { name: 'Morning Cup', label: 'MC COFFEE HK' },
];

const worldArb = fc.record({
  receipts: fc.array(
    fc.record({ m: fc.integer({ min: 0, max: 1 }), day: fc.integer({ min: 1, max: 6 }), amt: fc.constantFrom(1000, 2000) }),
    { maxLength: 8 },
  ),
  txns: fc.array(
    fc.record({ m: fc.integer({ min: 0, max: 1 }), day: fc.integer({ min: 1, max: 9 }), amt: fc.constantFrom(1000, 2000) }),
    { maxLength: 10 },
  ),
  alias: fc.boolean(),
});

type Item = { m: number; day: number; amt: number };
type World = { receipts: Item[]; txns: Item[]; alias: boolean };

function build(w: World) {
  const day = (d: number) => `2026-03-${String(d).padStart(2, '0')}`;
  const receipts: Receipt[] = w.receipts.map((r, i) =>
    receipt({ id: `R-${String(i + 1).padStart(3, '0')}`, merchant: MERCHANTS[r.m]!.name, date: day(r.day), amount: r.amt, doc: `DOC-P${i}` }),
  );
  const transactions: StatementTransaction[] = w.txns.map((t, i) =>
    tx({ file: 'prop.csv', row: i + 2, ref: `S-${i + 1}`, label: MERCHANTS[t.m]!.label, posting: day(t.day), amount: t.amt }),
  );
  return { receipts, transactions, activeRules: w.alias ? [aliasRule()] : [] };
}

describe('P4 order independence and collision safety (property)', () => {
  it('P4 permuting receipts and transactions gives the same outcomes; no two proposals share a transaction', () => {
    fc.assert(
      fc.property(worldArb, fc.integer(), (w, seed) => {
        const world = build(w);
        const base = evaluateWorkspace(input(world));
        const rot = (xs: readonly unknown[]) => {
          if (xs.length === 0) return [...xs];
          const k = Math.abs(seed) % xs.length;
          return [...xs.slice(k), ...xs.slice(0, k)].reverse();
        };
        const permuted = evaluateWorkspace(
          input({ ...world, receipts: rot(world.receipts) as Receipt[], transactions: rot(world.transactions) as StatementTransaction[] }),
        );
        expect([...permuted.proposals.entries()].sort()).toEqual([...base.proposals.entries()].sort());
        const taken = [...base.proposals.values()].filter((p) => p.outcome === 'unique_candidate').map((p) => p.transactionId);
        expect(new Set(taken).size).toBe(taken.length);
      }),
      { numRuns: 200 },
    );
  });
});

describe('P3 one-to-one links (domain property)', () => {
  it('P3 (domain) recording proposals and manual links in any order never links one transaction twice', () => {
    fc.assert(
      fc.property(worldArb, fc.array(fc.tuple(fc.nat(), fc.nat(), fc.boolean()), { maxLength: 20 }), (w, steps) => {
        const world = build(w);
        const matches: ConfirmedMatch[] = [];
        const ledger: LedgerEntry[] = [];
        let n = 0;
        for (const [ri, ti, manual] of steps) {
          if (world.receipts.length === 0 || world.transactions.length === 0) break;
          const r = world.receipts[ri % world.receipts.length]!;
          const current = input({ ...world, matches, ledgerEntries: ledger });
          let target: StatementTransaction | undefined;
          if (manual) {
            const t = world.transactions[ti % world.transactions.length]!;
            const check = checkManualResolution(current, { receiptId: r.id, transactionId: t.id, reason: 'Property test link' });
            if (check.ok) target = t;
          } else {
            const p = evaluateWorkspace(current).proposals.get(r.id);
            if (p?.outcome === 'unique_candidate') target = world.transactions.find((t) => t.id === p.transactionId);
          }
          if (target) {
            n++;
            const rec = recorded({ n, receipt: r, transaction: target });
            matches.push(rec.match);
            ledger.push(rec.entry);
          }
        }
        const perTxn = new Map<string, number>();
        const perReceipt = new Map<string, number>();
        for (const m of matches) {
          perTxn.set(m.transactionId, (perTxn.get(m.transactionId) ?? 0) + 1);
          perReceipt.set(m.subject.id, (perReceipt.get(m.subject.id) ?? 0) + 1);
        }
        expect([...perTxn.values()].every((c) => c === 1)).toBe(true);
        expect([...perReceipt.values()].every((c) => c === 1)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

describe('P2 idempotent import (property)', () => {
  it('P2 importing the same generated CSV k times equals importing it once', async () => {
    const row = fc.record({
      day: fc.integer({ min: 1, max: 28 }),
      label: fc.constantFrom('PAGE CORNER', 'MC COFFEE HK', 'CITY PARKING', '=HYPERLINK(1)', 'Green, Basket'),
      cents: fc.integer({ min: 1, max: 99_999 }),
      currency: fc.constantFrom('HKD', 'USD'),
    });
    await fc.assert(
      fc.asyncProperty(fc.array(row, { minLength: 1, maxLength: 8 }), fc.integer({ min: 2, max: 4 }), async (rows, k) => {
        const csv = ['Posting date,Description,Amount,Currency', ...rows.map((r) => `2026-03-${String(r.day).padStart(2, '0')},"${r.label}",${formatMinor(r.cents)},${r.currency}`)].join('\n');
        const bytes = new TextEncoder().encode(csv);
        const sha = await sha256Hex(bytes);
        const account = { accountId: 'acct:visa-1234', accountLabel: 'Visa 1234' };
        const grid = readCsvGrid(csv);
        const parsed = parseStatementCsv(grid, prefillMapping(grid.header), { dateFormat: 'YYYY-MM-DD', amountSign: 'positive_charges', defaultCurrency: 'HKD' }, account, {
          sha256: sha,
          sourceDocumentId: 'DOC-PENDING',
          workspaceId: 'personal',
        });
        const file = { fileName: 'p2.csv', mimeType: 'text/csv', bytes, sha256: sha };
        const once = new MemoryRepository('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
        await importStatement(once, file, parsed, account, 'all_rows');
        const many = new MemoryRepository('personal', { systemNow: () => '2026-04-20T10:00:00.000Z' });
        for (let i = 0; i < k; i++) await importStatement(many, file, parsed, account, 'all_rows');
        const a = await once.loadSnapshot();
        const b = await many.loadSnapshot();
        expect(b.transactions).toEqual(a.transactions);
        expect(b.sourceDocuments).toEqual(a.sourceDocuments);
        expect(b.audit.filter((e) => e.action === 'import.statement_committed')).toHaveLength(1);
        expect(b.audit.filter((e) => e.action === 'import.duplicate_file_rejected')).toHaveLength(k - 1);
      }),
      { numRuns: 40 },
    );
  });
});
