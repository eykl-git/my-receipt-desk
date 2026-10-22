import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeBase } from '../../src/config/base';

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : /\.(ts|tsx|css)$/.test(name) ? [p] : [];
  });
}

describe('static hosting base path', () => {
  it('normalizeBase adds leading and trailing slashes and defaults to /', () => {
    expect(normalizeBase(undefined)).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('my-receipt-desk')).toBe('/my-receipt-desk/');
    expect(normalizeBase('/my-receipt-desk')).toBe('/my-receipt-desk/');
    expect(normalizeBase('/my-receipt-desk/')).toBe('/my-receipt-desk/');
    expect(normalizeBase(' //a//b/ ')).toBe('/a/b/');
  });

  it('src has no absolute asset paths that would break under a sub-path', () => {
    const root = process.cwd();
    const offenders = filesUnder(join(root, 'src')).filter((f) => {
      const text = readFileSync(f, 'utf8');
      return text.includes('"/demo/') || text.includes("'/demo/") || text.includes("fetch('/") || text.includes('fetch("/');
    });
    expect(offenders.map((f) => relative(root, f))).toEqual([]);
  });

  it('vite.config.ts reads VITE_BASE and .env.pages sets the Pages base', () => {
    const root = process.cwd();
    expect(readFileSync(join(root, 'vite.config.ts'), 'utf8')).toMatch(/normalizeBase\(env\.VITE_BASE \?\? '\/'\)/);
    expect(readFileSync(join(root, '.env.pages'), 'utf8').trim()).toBe('VITE_BASE=/my-receipt-desk/');
  });
});
