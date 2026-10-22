/**
 * E8 persistence and reset (design §15 E8, §11.6): data survives reloads, the
 * demo resumes at tour step 2 in the demo workspace (mrd:lastWorkspace) and
 * continues to step 3, "Reset demo" keeps My files, the privacy text explains
 * where data lives, and "Delete all data in this browser" returns to a clean start.
 */
import { expect, test } from '@playwright/test';
import { expectCounts, expectNoSeriousAxe, expectStep, importCsvFile, MY_CSV, startDemo, STEP2, STEP3_ONCE, watchConsole } from './helpers';

test('E8 reload keeps My files and the demo at step 2; Next batch then loads Batch 2; Reset demo keeps My files; Privacy; Delete all → clean', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  await importCsvFile(page, 'april.csv', MY_CSV);
  await expectCounts(page, { cardrows: '2', spending: 'HKD 470.00' });
  await page.reload();
  await expectCounts(page, { cardrows: '2', spending: 'HKD 470.00' });

  // Demo at step 2, reload: the demo workspace and step come back.
  await page.getByRole('button', { name: 'Demo workspace (fictional)' }).click();
  await page.getByRole('button', { name: 'Try the 60-second demo' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expectStep(page, 2, STEP2);
  expect(await page.evaluate(() => localStorage.getItem('mrd:lastWorkspace'))).toBe('demo');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Demo workspace (fictional)' })).toHaveAttribute('aria-pressed', 'true');
  await expectStep(page, 2, STEP2);
  await expectCounts(page, { unique: '5' });
  await page.getByRole('region', { name: 'Guided demo' }).getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 3, STEP3_ONCE);
  await expectCounts(page, { unique: '8' });

  // Privacy explains where data lives; focus returns to the trigger.
  const privacy = page.getByRole('button', { name: 'Privacy' });
  await privacy.click();
  const pd = page.getByRole('dialog', { name: 'Privacy' });
  await expect(pd.getByTestId('privacy-text')).toContainText('local storage (IndexedDB)');
  await expectNoSeriousAxe(page, 'Privacy dialog');
  await page.keyboard.press('Escape');
  await expect(privacy).toBeFocused();

  // Reset demo: the demo is emptied, My files is untouched (also after a reload).
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const reset = page.getByRole('dialog', { name: 'Reset' });
  await expectNoSeriousAxe(page, 'Reset dialog');
  await reset.getByRole('button', { name: 'Reset demo' }).click();
  await reset.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('The demo workspace was reset.')).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: 'My files' }).click();
  await expectCounts(page, { cardrows: '2', spending: 'HKD 470.00' });
  await page.getByRole('button', { name: 'Demo workspace (fictional)' }).click();
  await expect(page.getByText('The demo workspace is empty. Load the fictional Batch 1 to start.')).toBeVisible();

  // Delete all: both workspaces go; the next visit starts clean in My files.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await reset.getByRole('button', { name: 'Delete all data in this browser' }).click();
  await reset.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('All data in this browser was deleted.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'My files' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('No files yet. Add receipts or a card CSV, or try the fictional demo.')).toBeVisible();
  await expectCounts(page, { cardrows: '0', spending: 'HKD 0.00' });
  await page.getByRole('button', { name: 'Demo workspace (fictional)' }).click();
  await expect(page.getByText('The demo workspace is empty. Load the fictional Batch 1 to start.')).toBeVisible();
  await page.getByRole('button', { name: 'My files' }).click();
  // The tour still starts in one click after deleting everything.
  await startDemo(page);
  con.assertClean();
});
