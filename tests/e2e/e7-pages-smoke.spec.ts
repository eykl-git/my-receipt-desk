/**
 * E7 GitHub Pages smoke (design §15 E7, brief §21): the production build served
 * under /my-receipt-desk/ with the build-only CSP meta tag. `?demo=1` starts the
 * tour; every asset resolves under the base; no request leaves the origin; no
 * console error (so no CSP error); after going offline the later batches and the
 * example CSV still work and the tour completes. Also writes the S6 review
 * screenshots of tour steps 1–4 at four sizes (artifacts, not pixel assertions).
 */
import { expect, test, type Page } from '@playwright/test';
import { caseCard, drawer, expectStep, group, NOTICE, STEP1, STEP2_TAUGHT, STEP3_TEACH } from './helpers';

const STEP4_TEACH = "Batch 3: The boundary still holds. A known name still can't pick between two equal payments, USD is not converted, and receipt text can't change your rules.";
const SHOTS = '.agents/tasks/c21/screenshots';
const SIZES = [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];
const tourBar = (page: Page) => page.getByRole('region', { name: 'Guided demo' });

/** Watches requests, failed responses and console output for the whole test. */
function watchNetwork(page: Page, base: string, offlineProbe = false) {
  const requests: string[] = [];
  const failed: string[] = [];
  const consoleLines: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  page.on('requestfailed', (r) => {
    if (!r.url().endsWith('/__offline-probe')) failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failed.push(`${r.url()} ${r.status()}`);
  });
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${String(e)}`));
  return {
    assertClean() {
      expect(requests.filter((u) => !(u.startsWith(base) || u.startsWith('blob:') || u.startsWith('data:')))).toEqual([]);
      expect(failed).toEqual([]);
      expect(consoleLines.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
      // With the offline probe, exactly its own "Failed to load resource" line is expected; nothing else.
      const probeLine = 'error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED';
      const errors = consoleLines.filter((l) => l.startsWith('error') || l.startsWith('pageerror'));
      expect(errors).toEqual(offlineProbe ? [probeLine] : []);
      // The demo path never loads OCR files (brief §26 B).
      expect(requests.filter((u) => u.includes('/ocr/'))).toEqual([]);
    },
  };
}

async function expectImagesLoaded(page: Page) {
  await expect
    .poll(() => page.evaluate(() => [...document.images].filter((i) => !(i.complete && i.naturalWidth > 0)).map((i) => i.alt || i.src)))
    .toEqual([]);
}

/** Teach path from step 1 through the knowledge-gap card (7 clicks). */
async function teach(page: Page) {
  await page.getByTestId('knowledge-gaps').getByRole('button', { name: 'Review R-102' }).click();
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

test('E7 Pages build at /my-receipt-desk/?demo=1: assets under the base, same-origin only, no CSP errors, works offline after load, tour completes', async ({ page, context, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const net = watchNetwork(page, `${origin}/my-receipt-desk/`, true);
  await page.goto('./?demo=1');
  await expect(page.getByRole('note')).toHaveText(NOTICE);
  await expectStep(page, 1, STEP1);
  expect(new URL(page.url()).pathname).toBe('/my-receipt-desk/');
  expect(new URL(page.url()).search).toBe('');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("connect-src 'self'");
  await expectImagesLoaded(page);
  await page.getByRole('button', { name: 'Review R-101' }).first().click();
  await expect(drawer(page).getByRole('img', { name: 'Receipt image for R-101' })).toBeVisible();
  await expectImagesLoaded(page);
  await page.keyboard.press('Escape');

  // Offline from here on: the later batches and the example CSV are already in memory.
  await context.setOffline(true);
  // Proof the browser really is offline: a fresh same-origin fetch fails (probe excluded from the checks).
  expect(await page.evaluate(() => fetch('./__offline-probe', { cache: 'no-store' }).then(() => 'online', () => 'offline'))).toBe('offline');
  await teach(page);
  await expectStep(page, 2, STEP2_TAUGHT);
  await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 3, STEP3_TEACH);
  await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 4, STEP4_TEACH);
  await expectImagesLoaded(page);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download example CSV' }).click()]);
  expect(dl.suggestedFilename()).toBe('example-card-statement.csv');
  await group(page, 'ready').getByRole('button', { name: 'Record all ready' }).click();
  await expect(page.getByTestId('live-region')).toHaveText('Recorded 6 entries.');
  await expect(page.getByTestId('m-paid').locator('dd')).toHaveText('HKD 487.00');
  await context.setOffline(false);
  net.assertClean();
});

for (const size of SIZES) {
  test(`E7 screenshots of tour steps 1–4 at ${size.width}x${size.height} on the Pages build`, async ({ page, baseURL }) => {
    const origin = new URL(baseURL!).origin;
    const net = watchNetwork(page, `${origin}/my-receipt-desk/`);
    await page.setViewportSize(size);
    const narrow = size.width < 1024;
    const tab = async (name: string) => {
      if (narrow) await page.getByRole('tab', { name }).click();
    };
    const shot = async (n: number) => {
      await page.waitForFunction(() => document.getAnimations().every((a) => !(a instanceof CSSTransition) || a.playState !== 'running'));
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      if (!narrow) await expect(page.getByRole('heading', { name: 'Knowledge Space', exact: true })).toBeInViewport();
      // Wide: the viewport as the audience sees it, from the top. Narrow: the full page, so the
      // tour bar and the selected tab's content are both in the shot.
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: `${SHOTS}/s6-${size.width}x${size.height}-step${n}.png`, fullPage: narrow });
    };

    await page.goto('./?demo=1');
    await expectStep(page, 1, STEP1);
    await expectImagesLoaded(page);
    await tab('Knowledge Space');
    await shot(1);

    if (narrow) await page.getByRole('tab', { name: 'Knowledge Space' }).click();
    await teach(page);
    await expectStep(page, 2, STEP2_TAUGHT);
    await tab('Knowledge Space');
    await shot(2);

    await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
    await expectStep(page, 3, STEP3_TEACH);
    await tab('Decisions and outcomes');
    await expect(caseCard(page, 'R-201')).toBeVisible();
    await shot(3);

    await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
    await expectStep(page, 4, STEP4_TEACH);
    await tab('Decisions and outcomes');
    await expect(caseCard(page, 'R-301')).toBeVisible();
    await shot(4);
    net.assertClean();
  });
}
