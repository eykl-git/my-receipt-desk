/**
 * S3 screenshots (brief §23, §24) at 1440x900, 1366x768, 1024x768 and 390x844, written for review.
 * Each screenshot also checks "no horizontal scroll"; at ≥1024 px the Knowledge Space heading must be in view.
 */
import { expect, test, type Page } from '@playwright/test';
import { drawer, group, startDemo, watchConsole } from './helpers';

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
  await page.screenshot({ path: `${OUT}/s3-${size.name}-${step}.png`, animations: 'disabled' });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `horizontal scroll at ${size.width}px (${step})`).toBeLessThanOrEqual(size.width);
}

async function tab(page: Page, size: Size, name: 'Your data' | 'Knowledge Space' | 'Decisions and outcomes') {
  if (size.width < 1024) await page.getByRole('tab', { name }).click();
}

for (const size of SIZES) {
  test(`S3 screenshots at ${size.width}x${size.height}`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: size.width, height: size.height });
    await startDemo(page);
    await tab(page, size, 'Knowledge Space');
    await expect(page.getByTestId('gap-card')).toBeVisible();
    await shot(page, size, '1-step1-gap');

    const bar = page.getByTestId('phrase-bar');
    await bar.getByLabel('Write a rule in plain English').fill('Put Morning Cup purchases under Dining.');
    await bar.getByRole('button', { name: 'Draft rule' }).click();
    await expect(drawer(page).getByTestId('draft-intro')).toBeVisible();
    await shot(page, size, '2-phrase-draft', { knowledgeInView: false });
    await page.keyboard.press('Escape');
    await drawer(page).getByRole('button', { name: 'Discard', exact: true }).click();
    await expect(drawer(page)).toHaveCount(0);

    await page.getByTestId('gap-card').getByRole('button', { name: 'Review R-102' }).click();
    const d = drawer(page);
    await d.getByRole('button', { name: 'Confirm this case only' }).click();
    await d.getByRole('button', { name: 'Confirm and record' }).click();
    await d.getByRole('button', { name: 'Propose reusable knowledge' }).click();
    await d.getByRole('button', { name: 'Preview impact' }).click();
    await d.getByRole('button', { name: 'Activate rule' }).click();
    await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 4 of 4');
    await tab(page, size, 'Decisions and outcomes');
    await shot(page, size, '3-step4');

    await page.getByRole('region', { name: 'Guided demo' }).getByRole('button', { name: /^Compare without this rule/ }).click();
    await expect(page.getByTestId('compare-counts')).toBeVisible();
    await shot(page, size, '4-compare', { knowledgeInView: false });
    await page.keyboard.press('Escape');

    await group(page, 'ready').getByRole('button', { name: 'Record all ready' }).click();
    await expect(page.getByTestId('live-region')).toHaveText('Recorded 6 entries.');
    await shot(page, size, '5-recorded');

    await page.getByRole('button', { name: 'Spreadsheet view' }).click();
    await shot(page, size, '6-spreadsheet', { knowledgeInView: false });
    await page.getByRole('button', { name: 'Knowledge-assisted view' }).click();

    await page.getByRole('region', { name: 'Guided demo' }).getByRole('button', { name: 'Restart demo' }).click();
    await expect(page.getByRole('dialog', { name: 'Restart demo' })).toBeVisible();
    await shot(page, size, '7-restart', { knowledgeInView: false });
    await page.getByRole('dialog', { name: 'Restart demo' }).getByRole('button', { name: 'Cancel' }).click();
    con.assertClean();
  });
}
