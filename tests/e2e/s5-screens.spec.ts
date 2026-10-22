/**
 * S5 screenshots (brief §23, §24) at 1440x900, 1366x768, 1024x768 and 390x844.
 * Each shot also checks "no horizontal scroll"; for the column views at
 * ≥1024 px the Knowledge Space heading must be in view.
 */
import { expect, test, type Page } from '@playwright/test';
import { caseCard, databaseVersion, drawer, group, importCsvFile, MY_CSV, seedNewerDatabase, teach, watchConsole } from './helpers';

const OUT = '.agents/tasks/c21/screenshots';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];
type Size = (typeof SIZES)[number];
const PNG_2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');

async function shot(page: Page, size: Size, step: string, opts: { knowledgeInView?: boolean } = {}) {
  if (opts.knowledgeInView !== false && size.width >= 1024) await expect(page.getByRole('heading', { name: 'Knowledge Space', exact: true })).toBeInViewport();
  await page.screenshot({ path: `${OUT}/s5-${size.name}-${step}.png`, animations: 'disabled' });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `horizontal scroll at ${size.width}px (${step})`).toBeLessThanOrEqual(size.width);
}

async function tab(page: Page, size: Size, name: 'Your data' | 'Knowledge Space' | 'Decisions and outcomes') {
  if (size.width < 1024) await page.getByRole('tab', { name }).click();
}

for (const size of SIZES) {
  test(`S5 screenshots at ${size.width}x${size.height}: rule lifecycle and corrections`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await teach(page);
    await tab(page, size, 'Decisions and outcomes');
    await caseCard(page, 'R-103').getByRole('button', { name: 'Record R-103' }).click();
    await expect(group(page, 'recorded')).toContainText('R-103');

    await tab(page, size, 'Knowledge Space');
    const card = page.getByTestId('rule-K-ALIAS-0001');
    await card.getByRole('button', { name: 'Suspend' }).click();
    const sd = page.getByRole('dialog', { name: 'Suspend K-ALIAS-0001 v1' });
    await sd.getByLabel('Why are you suspending this rule?').fill('Checking the card label');
    await shot(page, size, '1-suspend', { knowledgeInView: false });
    await sd.getByRole('button', { name: 'Suspend rule' }).click();
    await expect(card).toContainText('Suspended');

    await card.getByRole('button', { name: 'View history' }).click();
    const hd = page.getByRole('dialog', { name: 'History of K-ALIAS-0001' });
    await expect(hd).toContainText('Checking the card label');
    await shot(page, size, '2-history', { knowledgeInView: false });
    await hd.getByRole('button', { name: 'Re-check recorded entries' }).click();
    await expect(page.getByTestId('recheck-dialog')).toContainText('L-0002 (R-103)');
    await shot(page, size, '3-recheck', { knowledgeInView: false });
    await page.keyboard.press('Escape');
    await hd.getByRole('button', { name: 'Close' }).click();
    await expect(hd).toBeHidden();
    // Focus returned to "View history"; show the top of the page with the column heading.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.querySelector('.column-knowledge')?.scrollTo(0, 0);
    });
    await shot(page, size, '4-suspended-card');

    await tab(page, size, 'Decisions and outcomes');
    await caseCard(page, 'R-103').getByRole('button', { name: 'Review R-103' }).click();
    const d = drawer(page);
    await expect(d).toContainText('Recorded using K-ALIAS-0001 v1 (now suspended)');
    await d.getByLabel('Category', { exact: true }).selectOption({ label: 'Dining' });
    await d.getByRole('button', { name: 'Confirm category' }).click();
    await expect(d).toContainText('Recorded with category: Dining');
    await d.getByRole('heading', { name: 'Category', exact: true }).scrollIntoViewIfNeeded();
    await shot(page, size, '5-recorded-drawer', { knowledgeInView: false });
    await d.getByRole('button', { name: 'Void entry' }).click();
    const vd = page.getByTestId('void-dialog');
    await vd.getByLabel('Why are you voiding this entry?').fill('Recorded through a suspended name');
    await shot(page, size, '6-void-dialog', { knowledgeInView: false });
    await vd.getByRole('button', { name: 'Void entry' }).click();
    await expect(vd).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();

    const audit = page.getByRole('button', { name: 'Audit history' });
    await audit.click();
    await expect(page.getByTestId('audit-table')).toContainText('ledger.voided');
    await shot(page, size, '7-audit', { knowledgeInView: false });
    await page.keyboard.press('Escape');
    await expect(audit).toBeFocused();
    con.assertClean();
  });

  test(`S5 screenshots at ${size.width}x${size.height}: pause, statement-only and invoice`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/?recordDelay=2000');
    await page.getByRole('button', { name: 'Try the 60-second demo' }).click();
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 4 of 4');
    await tab(page, size, 'Decisions and outcomes');
    await page.getByRole('button', { name: 'Record all ready' }).click();
    await expect(group(page, 'recorded')).toContainText('R-101');
    await page.getByTestId('pause-row').scrollIntoViewIfNeeded();
    await shot(page, size, '8-pause');
    await page.getByRole('button', { name: 'Pause processing' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Recorded 1. Paused before 2 more.' })).toBeVisible();

    // My files: a statement row recorded on its own, then an invoice not yet paid.
    await page.getByRole('button', { name: 'My files' }).click();
    await tab(page, size, 'Your data');
    await importCsvFile(page, 'april.csv', MY_CSV);
    await page.getByRole('button', { name: /PAGE CORNER/ }).first().click();
    const d = drawer(page);
    await expect(d.getByRole('button', { name: 'Record from statement (no receipt yet)' })).toBeVisible();
    await shot(page, size, '9-statement-drawer', { knowledgeInView: false });
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Add receipts' }).click();
    const add = page.getByRole('dialog', { name: 'Add receipts' });
    await add.getByRole('radio', { name: 'Invoice (not yet paid)' }).check();
    await add.getByLabel('Invoice image (JPEG or PNG, up to 10 MB)').setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG_2 });
    await add.getByLabel('Supplier').fill('Harbour Print Ltd');
    await add.getByLabel('Invoice number (optional)').fill('HP-041');
    await add.getByLabel('Invoice date').fill('2026-04-01');
    await add.getByLabel('Amount').fill('350.00');
    await shot(page, size, '10-add-invoice', { knowledgeInView: false });
    await add.getByRole('button', { name: 'Add invoice' }).click();
    await add.getByRole('button', { name: 'Open INV-0001' }).click();
    await d.getByRole('button', { name: 'Link card payment' }).click();
    await expect(d.getByRole('radio', { name: /HARBOUR PRINT LTD/ })).toBeChecked();
    await shot(page, size, '11-invoice-drawer', { knowledgeInView: false });
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('invoice-list')).toContainText('INV-0001');
    await shot(page, size, '12-myfiles-invoices');
    con.assertClean();
  });

  test(`S5 screenshots at ${size.width}x${size.height}: newer-version banner confirm step`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await seedNewerDatabase(page, 'mrd-personal');
    await page.goto('/');
    const banner = page.getByTestId('storage-banner');
    await banner.getByRole('button', { name: 'Delete data in this workspace' }).click();
    await expect(page.getByTestId('delete-newer-confirm')).toBeVisible();
    await shot(page, size, '13-newer-confirm', { knowledgeInView: false });
    expect(await databaseVersion(page, 'mrd-personal')).toBe(99);
  });
}
