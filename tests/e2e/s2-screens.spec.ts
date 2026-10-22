/**
 * S2 screenshots (brief §23) at 1440x900, 1366x768, 1024x768 and 390x844, written for review (not pixel
 * assertions). Every screenshot also checks the §24 gate "no horizontal scroll" at that size.
 */
import { expect, test, type Page } from '@playwright/test';
import { confirmR102, drawer, startDemo, watchConsole } from './helpers';

const OUT = '.agents/tasks/c21/screenshots';
const SIZES = [
  { name: '1440', width: 1440, height: 900 },
  { name: '1366', width: 1366, height: 768 },
  { name: '1024', width: 1024, height: 768 },
  { name: '390', width: 390, height: 844 },
];

async function shot(page: Page, size: (typeof SIZES)[number], step: string) {
  await page.screenshot({ path: `${OUT}/s2-${size.name}-${step}.png`, animations: 'disabled' });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `horizontal scroll at ${size.width}px (${step})`).toBeLessThanOrEqual(size.width);
}

for (const size of SIZES) {
  test(`S2 screenshots at ${size.width}x${size.height}`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto('/');
    await shot(page, size, '1-empty');
    await startDemo(page);
    await shot(page, size, '2-step1');
    await confirmR102(page);
    await drawer(page).getByRole('button', { name: 'Propose reusable knowledge' }).click();
    await drawer(page).getByRole('button', { name: 'Preview impact' }).click();
    await expect(drawer(page).getByTestId('draft-pending')).toContainText('R-103');
    await shot(page, size, '3-draft');
    await drawer(page).getByRole('button', { name: 'Activate rule' }).click();
    await expect(drawer(page).getByTestId('activation-summary')).toBeVisible();
    await shot(page, size, '4-summary');
    await drawer(page).getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
    if (size.width < 1024) await page.getByRole('tab', { name: 'Knowledge Space' }).click();
    else await expect(page.getByRole('heading', { name: 'Knowledge Space', exact: true })).toBeInViewport();
    await shot(page, size, '5-activated');
    if (size.width < 1024) await page.getByRole('tab', { name: 'Decisions and outcomes' }).click();
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');
    await shot(page, size, '6-step3');
    await page.getByRole('button', { name: 'Review R-201' }).click();
    await expect(drawer(page)).toBeVisible();
    await shot(page, size, '7-drawer');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Spreadsheet view' }).click();
    await shot(page, size, '8-spreadsheet');
    con.assertClean();
  });
}
