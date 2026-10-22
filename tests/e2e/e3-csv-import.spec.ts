/**
 * E3 real CSV import (design §15 E3, §12.1, §12.4): the downloaded example CSV
 * goes through the wizard with explicit column mapping and conventions; a
 * malformed file blocks the commit and writes nothing; a re-import is refused.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { CSV_INPUT, expectCounts, expectNoSeriousAxe, watchConsole } from './helpers';

const wizard = (page: Page) => page.getByRole('dialog', { name: 'Import card CSV' });

async function setUp(page: Page, name: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const wiz = wizard(page);
  await wiz.getByLabel(CSV_INPUT).setInputFiles({ name, mimeType: 'text/csv', buffer });
  await wiz.getByLabel('Card account name').fill('Visa 1234');
  const column = (name: string) => wiz.getByRole('combobox', { name, exact: true });
  await column('Posting date (required)').selectOption({ label: 'Posted' });
  await column('Transaction date').selectOption({ label: 'Date' });
  await column('Description (required)').selectOption({ label: 'Details' });
  await column('Amount').selectOption({ label: 'Amount' });
  await column('Currency').selectOption({ label: 'Currency' });
  await column('Date format').selectOption('DD/MM/YYYY');
  await column('Amount sign').selectOption({ label: 'Negative amounts are charges' });
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  return wiz;
}

test('E3 example CSV: download, map, DD/MM/YYYY + negative charges, the §12.4 preview, import, reload, re-import refused', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download example CSV' }).click()]);
  expect(dl.suggestedFilename()).toBe('example-card-statement.csv');
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.equals(readFileSync('public/demo/example-card-statement.csv'))).toBe(true);

  const wiz = await setUp(page, 'example-card-statement.csv', bytes);
  const preview = wiz.getByTestId('import-preview');
  for (const t of ['Total rows6', 'Valid6', 'Errors0', 'Quarantined (not HKD)1', 'Credits (not supported)1', 'HKD debit rows4', 'HKD debit totalHKD 278.50']) await expect(preview).toContainText(t);
  await expect(wiz).toContainText('Page Corner, Central');
  await expectNoSeriousAxe(page, 'CSV import preview');
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(wiz).toBeHidden();
  await expect(page.getByText('Imported 6 card transactions from example-card-statement.csv.')).toBeVisible();
  await expectCounts(page, { cardrows: '6', spending: 'HKD 278.50' });
  await page.reload();
  await expectCounts(page, { cardrows: '6', spending: 'HKD 278.50' });

  await page.getByRole('button', { name: 'Import card CSV' }).click();
  await wizard(page).getByLabel(CSV_INPUT).setInputFiles({ name: 'copy.csv', mimeType: 'text/csv', buffer: bytes });
  await expect(wizard(page).getByRole('alert')).toContainText('This file was already imported on');
  await page.keyboard.press('Escape');
  await expectCounts(page, { cardrows: '6' });
  con.assertClean();
});

test('E3 malformed CSV: row errors with row, column and value; commit blocked until "valid rows only"; nothing written on cancel', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const bad = Buffer.from(
    ['Date,Posted,Details,Amount,Currency', '02/04/2026,31/02/2026,BAD DATE SHOP,-10.00,HKD', '05/04/2026,06/04/2026,BAD AMOUNT SHOP,-1O.00,HKD', '07/04/2026,07/04/2026,GOOD SHOP,-30.00,HKD', ''].join('\n'),
  );
  const wiz = await setUp(page, 'bad.csv', bad);
  await expect(wiz.getByTestId('import-preview')).toContainText('Errors2');
  const errors = wiz.getByRole('table').first();
  await expect(errors.getByRole('row', { name: /31\/02\/2026/ }).getByRole('cell')).toHaveText(['2', 'Posted', '31/02/2026', 'Not a real date in DD/MM/YYYY between 2000-01-01 and 2099-12-31.']);
  await expect(errors.getByRole('row', { name: /-1O\.00/ }).getByRole('cell')).toHaveText(['3', 'Amount', '-1O.00', 'Use a plain number such as 120.00 or -48.50.']);
  await expect(wiz.getByRole('button', { name: 'Import all rows' })).toHaveCount(0);
  await expect(wiz.getByRole('button', { name: 'Import valid rows' })).toBeDisabled();
  await expect(wiz.getByText('Fix the errors, or choose to import only the valid rows.')).toBeVisible();
  await expectNoSeriousAxe(page, 'CSV import with row errors');

  // Cancel: nothing was written.
  await page.keyboard.press('Escape');
  await expect(wiz).toBeHidden();
  await expectCounts(page, { cardrows: '0', spending: 'HKD 0.00' });
  await page.getByRole('button', { name: 'Audit history' }).click();
  await expect(page.getByRole('dialog', { name: 'Audit history' })).not.toContainText('import.');
  await page.keyboard.press('Escape');

  // Choosing "valid rows only" imports just the good row.
  const again = await setUp(page, 'bad.csv', bad);
  await again.getByLabel('Import only the 1 valid rows (errors are left out)').check();
  await again.getByRole('button', { name: 'Import valid rows' }).click();
  await expect(again).toBeHidden();
  await expect(page.getByText('Imported 1 card transaction from bad.csv.')).toBeVisible();
  await expectCounts(page, { cardrows: '1', spending: 'HKD 30.00' });
  con.assertClean();
});
