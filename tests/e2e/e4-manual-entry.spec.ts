/**
 * E4 receipt capture in My files (design §15 E4, §10.1; brief §26–§29):
 * a PNG with manual entry that survives a reload, a renamed text file that is
 * refused, and "Read automatically" (local OCR) on the fictional Hong Kong
 * sample, whose hard-to-read merchant stays unclear until the user types it.
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { drawer, expectNoSeriousAxe, group, PNG_1X1, RECEIPT_INPUT, watchConsole } from './helpers';

test('E4 manual entry: PNG upload as "Receipt (paid)", fields entered and saved, reload keeps them; a .png-renamed text file is refused', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await expect(add.getByRole('radio', { name: 'Receipt (paid)' })).toBeChecked();
  await add.getByLabel(RECEIPT_INPUT).setInputFiles({ name: 'lunch.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await expect(add).toContainText('Added 1 receipt.');
  await expectNoSeriousAxe(page, 'Add receipts dialog');
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = drawer(page);
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');
  await expect(d.getByText('lunch.png')).toBeVisible();
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('Page Corner');
  await d.getByLabel('Date').fill('2026-04-02');
  await d.getByLabel('Amount').fill('120.00');
  await expect(d.getByLabel('Currency')).toHaveValue('HKD');
  await expectNoSeriousAxe(page, 'receipt field form');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(group(page, 'needs_decision')).toContainText('R-0001');

  await page.reload();
  await expect(page.getByTestId('receipt-list')).toContainText('R-0001 Page Corner');
  await expect(page.getByTestId('receipt-list')).toContainText('HKD 120.00');
  await page.getByTestId('receipt-list').getByRole('button', { name: /R-0001/ }).click();
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');
  await expect(d).toContainText('2026-04-02');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Add receipts' }).click();
  await add.getByLabel(RECEIPT_INPUT).setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('hello, not an image') });
  await expect(add).toContainText('notes.png: not a JPEG or PNG image');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('receipt-list').getByRole('button')).toHaveCount(1);
  con.assertClean();
});

test('E4 "Read automatically" on the Hong Kong sample: fields proposed and unconfirmed, the unclear merchant typed by hand, saved, kept after reload', async ({ page }) => {
  test.setTimeout(120_000);
  const con = watchConsole(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await add.getByLabel(RECEIPT_INPUT).setInputFiles({ name: 'sample-receipt-hk-zh.png', mimeType: 'image/png', buffer: readFileSync('public/samples/sample-receipt-hk-zh.png') });
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = drawer(page);
  const box = d.getByTestId('ocr-box');
  // HKD workspace → Traditional Chinese + English by default (brief §27).
  await expect(box.getByLabel('Receipt language')).toHaveValue('chi_tra+eng');
  await box.getByRole('button', { name: 'Read automatically' }).click();
  await expect(d.getByTestId('ocr-outcome')).toContainText('Looks like a Hong Kong receipt:', { timeout: 60_000 });
  await expect(d).toContainText('Read automatically, check before saving');
  await expect(d).toContainText('2026-03-18');
  await expect(d).toContainText('90.20');
  // Proposals only: nothing matches until the fields are confirmed.
  await expect(d.getByRole('button', { name: 'Confirm this case only' })).toBeDisabled();
  await expect(d).toContainText('Check the receipt fields first');
  await expectNoSeriousAxe(page, 'drawer after Read automatically');

  await d.getByRole('button', { name: 'Edit fields' }).click();
  await expect(d.getByLabel('Merchant')).toHaveValue('');
  await expect(d.getByLabel('Date')).toHaveValue('2026-03-18');
  await expect(d.getByLabel('Amount')).toHaveValue('90.20');
  await expect(d.getByLabel('Currency')).toHaveValue('HKD');
  await d.getByLabel('Merchant').fill('示範茶餐廳有限公司');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByTestId('receipt-list')).toContainText('示範茶餐廳有限公司');
  await expect(page.getByTestId('receipt-list')).toContainText('HKD 90.20');
  // Brief §29: the chi_tra model logs "Warning: Parameter not found: …" from the engine; nothing else may appear.
  expect(con.errors.filter((e) => !e.startsWith('Warning: Parameter not found: '))).toEqual([]);
});
