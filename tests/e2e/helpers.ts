/** Shared helpers for the browser specs (S2; S6 extends them). */
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Download, type Page } from '@playwright/test';

export const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
export const RECEIPT_INPUT = 'Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)';
export const CSV_INPUT = 'Card statement (.csv, UTF-8, up to 2 MB)';

/**
 * axe scan (WCAG 2.0/2.1 A and AA rules). Fails on any serious or critical
 * violation and lists rule, impact and the first targets so a failure is readable.
 */
export async function expectNoSeriousAxe(page: Page, where: string) {
  // Scan the settled screen: a 150–200 ms colour transition caught half-way reports a blended colour.
  await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${where}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} — ${(n.failureSummary ?? '').replace(/\s+/g, ' ')}`).join(' | ')}`);
  expect(bad).toEqual([]);
  return result;
}

/** Presses Tab until the focused element's accessible text equals `name`; returns the number of presses. */
export async function tabTo(page: Page, name: string, max = 80): Promise<number> {
  for (let i = 1; i <= max; i += 1) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return el ? (el.getAttribute('aria-label') ?? el.innerText ?? '').trim() : '';
    });
    if (label === name) return i;
  }
  throw new Error(`Tab never reached “${name}” within ${max} presses`);
}

/** The focused element draws a visible focus indicator (outline or box-shadow). */
export async function expectFocusRing(page: Page) {
  const ring = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    const s = getComputedStyle(el);
    return { outline: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0, shadow: s.boxShadow !== 'none', visible: el.matches(':focus-visible') };
  });
  expect(ring.visible).toBe(true);
  expect(ring.outline || ring.shadow).toBe(true);
}

/** Metric values in the "Counts from current data" strip (design §8 table columns). */
export type Counts = Partial<Record<'unique' | 'needs' | 'confirmed' | 'safe' | 'linked' | 'cardrows' | 'spending' | 'active' | 'newly' | 'rules-used' | 'paid' | 'unpaid', string>>;
export async function expectCounts(page: Page, counts: Counts) {
  for (const [k, v] of Object.entries(counts)) await expect(page.getByTestId(`m-${k}`).locator('dd'), `m-${k}`).toHaveText(v);
}

/** Case cards in a "Decisions and outcomes" group. */
export async function expectGroupSizes(page: Page, sizes: { ready: number; needs: number; recorded: number }) {
  await expect(group(page, 'ready').locator('.case-card')).toHaveCount(sizes.ready);
  await expect(group(page, 'needs_decision').locator('.case-card')).toHaveCount(sizes.needs);
  await expect(group(page, 'recorded').locator('.case-card')).toHaveCount(sizes.recorded);
}

export async function downloadText(download: Download): Promise<string> {
  return readFileSync((await download.path())!, 'utf8');
}

export const NOTICE = 'Browser-only prototype · Fictional demo data available · No bank connection · Your data stays in this browser.';
// The tour bar shows "Step N of 4" in its indicator and the rest of the coach text as the sentence.
export const STEP1 =
  'Batch 1: First encounter. One receipt is ready. Four need you: two because the card shows “MC COFFEE HK”, a name the desk doesn\'t know yet, one unclear amount and one with two equal payments.';
export const STEP2 = 'Open R-102, confirm its card transaction, then propose the card name as reusable knowledge.';
export const STEP2_CONFIRMED = 'R-102 is recorded for this case only. No rule was created. Next: open R-102 and choose “Propose reusable knowledge”.';
export const STEP2_TAUGHT = 'Rule K-ALIAS-0001 v1 is active. R-103 is now ready without another decision. Next: load Batch 2.';
export const STEP3_TEACH = 'Batch 2: Knowledge reused. Two Morning Cup receipts are ready because of K-ALIAS-0001 v1. The re-uploaded file was caught.';
export const STEP3_ONCE = 'Batch 2: Without an approved rule, both new Morning Cup receipts still need your decision. The re-uploaded file was caught.';

/** Collects console errors and page errors; call `assertClean()` at the end. */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { errors, assertClean: () => expect(errors).toEqual([]) };
}

export const drawer = (page: Page) => page.getByTestId('drawer');
export const coach = (page: Page) => page.getByTestId('coach-text');
export const group = (page: Page, g: 'ready' | 'needs_decision' | 'recorded') => page.getByTestId(`group-${g}`);
export const caseCard = (page: Page, id: string) => page.getByTestId(`case-${id}`);

export async function expectStep(page: Page, n: number, sentence: string) {
  await expect(page.getByTestId('tour-step')).toHaveText(`Step ${n} of 4`);
  await expect(coach(page)).toHaveText(sentence);
}

export async function startDemo(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('note')).toHaveText(NOTICE);
  await page.getByRole('button', { name: 'Try the 60-second demo' }).click();
  await expectStep(page, 1, STEP1);
}

/** Tour step 2: open R-102 and confirm this case only. The drawer stays open. */
/** Tour steps 1–2 on the teach path (S5): R-102 confirmed once, K-ALIAS-0001 v1 activated, drawer closed. */
export async function teach(page: Page) {
  await startDemo(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Open R-102' }).click();
  const d = drawer(page);
  await d.getByRole('button', { name: 'Confirm this case only' }).click();
  await d.getByRole('button', { name: 'Confirm and record' }).click();
  await expect(d.getByText('Recorded as L-0001.')).toBeVisible();
  await d.getByRole('button', { name: 'Propose reusable knowledge' }).click();
  await d.getByRole('button', { name: 'Preview impact' }).click();
  await expect(d.getByTestId('draft-pending')).toContainText('R-103');
  await d.getByRole('button', { name: 'Activate rule' }).click();
  await expect(d.getByTestId('activation-summary')).toBeVisible();
  await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
  await expect(d).toBeHidden();
}

/** "Import card CSV" with ISO dates and negative charges (S5). */
export async function importCsvFile(page: Page, name: string, text: string, account = 'Visa 1234') {
  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const wiz = page.getByRole('dialog', { name: 'Import card CSV' });
  await wiz.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
  await wiz.getByLabel('Card account name').fill(account);
  await wiz.getByLabel('Amount sign').selectOption({ label: 'Negative amounts are charges' });
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(wiz).toBeHidden();
}

/**
 * Make the IndexedDB database `name` look as if a newer app version saved it
 * (§11.5): version 99 with one extra store and record. Runs on a blank page of
 * the same origin, so the app holds no connection while it upgrades.
 */
export async function seedNewerDatabase(page: Page, name: string) {
  await page.route('**/__seed', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>seed</title>' }));
  await page.goto('/__seed');
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open(n, 99);
        req.onupgradeneeded = () => {
          if (!req.result.objectStoreNames.contains('kept')) req.result.createObjectStore('kept');
        };
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('kept', 'readwrite');
          tx.objectStore('kept').put('saved by a newer version', 'note');
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    name,
  );
  await page.unroute('**/__seed');
}

/** The stored version of database `name`, or null when it doesn't exist. */
export async function databaseVersion(page: Page, name: string): Promise<number | null> {
  return page.evaluate(async (n) => (await indexedDB.databases()).find((d) => d.name === n)?.version ?? null, name);
}

/** The record `seedNewerDatabase` wrote, read without upgrading; null when it is gone. */
export async function seededNote(page: Page, name: string): Promise<string | null> {
  return page.evaluate(
    (n) =>
      new Promise<string | null>((resolve, reject) => {
        const req = indexedDB.open(n);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('kept')) {
            db.close();
            resolve(null);
            return;
          }
          const get = db.transaction('kept').objectStore('kept').get('note');
          get.onsuccess = () => {
            db.close();
            resolve(typeof get.result === 'string' ? get.result : null);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    name,
  );
}

export const MY_CSV = ['Date,Posted,Details,Amount,Currency', '2026-04-02,2026-04-03,PAGE CORNER,-120.00,HKD', '2026-04-05,2026-04-06,HARBOUR PRINT LTD,-350.00,HKD', ''].join('\n');

export async function confirmR102(page: Page) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectStep(page, 2, STEP2);
  await page.getByRole('button', { name: 'Open R-102' }).click();
  const d = drawer(page);
  await expect(d).toBeVisible();
  await expect(d.getByText('Demo extraction—preloaded fictional example')).toBeVisible();
  await expect(d.getByText('Apply once: records this receipt only. No rule is created.')).toBeVisible();
  await d.getByRole('button', { name: 'Confirm this case only' }).click();
  await expect(d.getByLabel('Why this is the right transaction')).toHaveValue('Receipt and card transaction show the same amount and date');
  await d.getByRole('button', { name: 'Confirm and record' }).click();
  await expect(d.getByText('Your confirmation is saved. A rule is a separate decision.')).toBeVisible();
  await expect(d.getByText('Recorded as L-0001.')).toBeVisible();
}
