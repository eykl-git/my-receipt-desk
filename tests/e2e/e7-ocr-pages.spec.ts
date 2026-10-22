/**
 * OCR E-spec on the production Pages build (brief §26 B, ocr-design §5, §8.8):
 * served under /my-receipt-desk/ with the build-only CSP meta tag. Upload the
 * Malaysian sample, "Read automatically", check the fields are prefilled and
 * unconfirmed, save them. Every request stays same-origin under the base and
 * no Content-Security-Policy error appears. The demo path loads no OCR file.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('OCR on the Pages build: same-origin under the base, no CSP errors, fields prefilled then saved', async ({ page, baseURL }) => {
  const consoleLines: string[] = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${String(e)}`));
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));

  await page.goto('./?demo=1');
  await expect(page.getByTestId('tour-step')).toHaveText('Step 1 of 4');
  expect(requests.filter((u) => u.includes('/ocr/'))).toEqual([]);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(csp).toContain("worker-src 'self'");

  await page.getByRole('button', { name: 'My files' }).click();
  await page.getByLabel('Currency for My files').selectOption('MYR');
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles({
    name: 'sample-receipt-my.png',
    mimeType: 'image/png',
    buffer: readFileSync('public/samples/sample-receipt-my.png'),
  });
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = page.getByTestId('drawer');
  await d.getByRole('button', { name: 'Read automatically' }).click();
  await expect(d.getByTestId('ocr-outcome')).toContainText('Looks like a Malaysian receipt:', { timeout: 60_000 });
  await expect(d).toContainText('Read automatically, check before saving');
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await expect(d.getByLabel('Merchant')).toHaveValue('CONTOH MART SDN BHD');
  await expect(d.getByLabel('Date')).toHaveValue('2026-03-14');
  await expect(d.getByLabel('Amount')).toHaveValue('23.00');
  await expect(d.getByLabel('Currency')).toHaveValue('MYR');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();

  const ocr = requests.filter((u) => u.includes('/ocr/'));
  expect(ocr.some((u) => u.endsWith('/my-receipt-desk/ocr/worker.min.js'))).toBe(true);
  expect(ocr.some((u) => u.includes('/my-receipt-desk/ocr/lang/msa.traineddata'))).toBe(true);
  expect(ocr.some((u) => u.includes('chi_'))).toBe(false);
  const origin = new URL(baseURL!).origin;
  expect(requests.filter((u) => !(u.startsWith(`${origin}/my-receipt-desk/`) || u.startsWith('blob:') || u.startsWith('data:')))).toEqual([]);
  expect(consoleLines.filter((l) => /Content Security Policy|Content-Security-Policy/i.test(l))).toEqual([]);
  expect(consoleLines.filter((l) => l.startsWith('error') || l.startsWith('pageerror'))).toEqual([]);
});
