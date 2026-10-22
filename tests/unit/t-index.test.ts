/**
 * T-index (task 5.6, REQ-19.1): every S16 test T01–T26 exists as a Vitest
 * test or suite whose title starts with its ID. It reads the test sources, so
 * a renamed or deleted test fails here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const DIR = join(process.cwd(), 'tests', 'unit');
const TITLE = /\b(?:it|test|describe|describeEachRepo)\(\s*(['"`])(T\d{2})\b/g;

it('T-index every S16 test T01–T26 has at least one test titled with its ID', () => {
  const found = new Map<string, string[]>();
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.test.ts') && f !== 't-index.test.ts')) {
    const text = readFileSync(join(DIR, file), 'utf8');
    for (const m of text.matchAll(TITLE)) found.set(m[2]!, [...(found.get(m[2]!) ?? []), file]);
  }
  const ids = Array.from({ length: 26 }, (_, i) => `T${String(i + 1).padStart(2, '0')}`);
  const missing = ids.filter((id) => !found.has(id));
  expect(missing).toEqual([]);
});
