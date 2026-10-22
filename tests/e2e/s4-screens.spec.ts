/**
 * S4 screenshots (brief §23, §24) at 1440x900, 1366x768, 1024x768 and 390x844.
 * Each one also checks "no horizontal scroll"; for the column views at ≥1024 px
 * the Knowledge Space heading must be in view.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { drawer, watchConsole } from './helpers';

const OUT = '.agents/tasks/c21/screenshots';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];
type Size = (typeof SIZES)[number];

async function shot(page: Page, size: Size, step: string, opts: { knowledgeInView?: boolean } = {}) {
  if (opts.knowledgeInView !== false && size.width >= 1024) await expect(page.getByRole('heading', { name: 'Knowledge Space', exact: true })).toBeInViewport();
  await page.screenshot({ path: `${OUT}/s4-${size.name}-${step}.png`, animations: 'disabled' });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `horizontal scroll at ${size.width}px (${step})`).toBeLessThanOrEqual(size.width);
}

/**
 * S4 review finding 1: card rows without a Reference show "Row {n} of {file}",
 * which must not clip the card label. Every visible list label is checked for
 * truncation, and the "CONTOH MART PJ" rows must show the whole label next to
 * the whole row reference.
 */
async function assertCardLabelsReadable(page: Page, size: Size) {
  const rows = page.locator('.item-row').filter({ hasText: 'Row 2 of example-card-statement-my.csv' }).filter({ visible: true });
  // "Your data" lists the row; at ≥1024 px "Card transactions to check" lists it too.
  await expect(rows).toHaveCount(size.width >= 1024 ? 2 : 1);
  for (const row of await rows.all()) {
    await expect(row.locator('.item-label')).toHaveText('CONTOH MART PJ');
    // On one line: not squeezed into a narrow track and broken inside words.
    const oneLine = await row.locator('.item-label').evaluate((el) => el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).fontSize) * 2);
    expect(oneLine, `"CONTOH MART PJ" wraps at ${size.width}px`).toBe(true);
    await expect(row.locator('.item-ref-line')).toHaveText('Row 2 of example-card-statement-my.csv');
  }
  const clipped = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.item-row .item-label, .item-row .item-ref-line')]
      .filter((el) => el.offsetParent !== null && (el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().width < 8))
      .map((el) => el.textContent),
  );
  expect(clipped, `clipped list labels at ${size.width}px`).toEqual([]);
}

for (const size of SIZES) {
  test(`S4 screenshots at ${size.width}x${size.height}`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/');
    await page.getByLabel('Currency for My files').selectOption('MYR');
    await shot(page, size, '1-myfiles-myr');

    await page.getByRole('button', { name: 'Add receipts' }).click();
    const add = page.getByRole('dialog', { name: 'Add receipts' });
    await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles({
      name: 'sample-receipt-my.png',
      mimeType: 'image/png',
      buffer: readFileSync('public/samples/sample-receipt-my.png'),
    });
    await add.getByRole('button', { name: 'Open R-0001' }).click();
    const d = drawer(page);
    await d.getByRole('button', { name: 'Read automatically' }).click();
    await expect(d.getByTestId('ocr-outcome')).toContainText('Looks like a Malaysian receipt:', { timeout: 60_000 });
    await d.getByText('Extracted fields').scrollIntoViewIfNeeded();
    await shot(page, size, '2-ocr-read', { knowledgeInView: false });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Import card CSV' }).click();
    const wiz = page.getByRole('dialog', { name: 'Import card CSV' });
    await wiz.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({
      name: 'example-card-statement-my.csv',
      mimeType: 'text/csv',
      buffer: readFileSync('public/samples/example-card-statement-my.csv'),
    });
    await wiz.getByLabel('Card account name').fill('Contoh Card 5678');
    await wiz.getByLabel('Date format').selectOption('DD/MM/YYYY');
    await wiz.getByLabel('Amount sign').selectOption({ label: 'Negative amounts are charges' });
    await wiz.getByRole('button', { name: 'Preview import' }).click();
    await expect(wiz.getByTestId('import-preview')).toContainText('MYR debit totalMYR 97.40');
    await shot(page, size, '3-import-preview', { knowledgeInView: false });
    await wiz.getByRole('button', { name: 'Import all rows' }).click();
    await expect(page.getByTestId('m-spending')).toContainText('MYR 97.40');

    await page.getByRole('button', { name: 'Exports', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Exports' })).toBeVisible();
    await shot(page, size, '4-exports', { knowledgeInView: false });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Privacy' }).click();
    await expect(page.getByRole('dialog', { name: 'Privacy' }).getByTestId('privacy-text')).toContainText('IndexedDB');
    await shot(page, size, '5-privacy', { knowledgeInView: false });
    await page.keyboard.press('Escape');

    if (size.width < 1024) await page.getByRole('tab', { name: 'Knowledge Space' }).click();
    const bar = page.getByTestId('phrase-bar');
    await bar.getByLabel('Write a rule in plain English').fill('Remember CONTOH MART PJ as Contoh Mart, ignoring store numbers.');
    await bar.getByRole('button', { name: 'Draft rule' }).click();
    await expect(d.getByTestId('covered-labels')).toBeVisible();
    await d.getByRole('button', { name: 'Preview impact' }).click();
    await expect(d.getByText('Saved as K-ALIAS-0001 v1 (draft). It does nothing until you activate it.')).toBeVisible();
    await expect(d.getByRole('button', { name: 'Activate rule' })).toBeEnabled();
    await shot(page, size, '6-storenumber-draft', { knowledgeInView: false });
    await page.keyboard.press('Escape');
    await expect(d).toHaveCount(0);
    if (size.width < 1024) await page.getByRole('tab', { name: 'Your data' }).click();
    await assertCardLabelsReadable(page, size);
    await shot(page, size, '7-myfiles-data');
    // The "Card transactions" rows in Your data, scrolled into view (finding 1 evidence).
    await page.locator('.item-row').filter({ hasText: 'Row 2 of example-card-statement-my.csv' }).filter({ visible: true }).first().scrollIntoViewIfNeeded();
    await shot(page, size, '8-card-rows', { knowledgeInView: false });
    con.assertClean();
  });
}
