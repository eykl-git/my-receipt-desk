/**
 * S2 control checklist in a real browser (brief §23): every rendered control
 * does something; every dialog closes with Close and Escape and returns focus.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { caseCard, coach, confirmR102, drawer, group, startDemo, watchConsole } from './helpers';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

async function expectDialogCloses(page: Page, opener: string, title: string) {
  const button = page.getByRole('button', { name: opener, exact: true });
  await button.click();
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
  await button.click();
  await dialog.getByRole('button', { name: 'Close' }).first().click();
  await expect(dialog).toBeHidden();
  await expect(button).toBeFocused();
}

test('S2 header dialogs, views, filters and reset', async ({ page }) => {
  const con = watchConsole(page);
  await startDemo(page);
  await expectDialogCloses(page, 'Audit history', 'Audit history');
  await page.getByRole('button', { name: 'Audit history' }).click();
  await expect(page.getByText('Inspectable local log. It is not tamper-proof.', { exact: false })).toBeVisible();
  await expect(page.getByTestId('audit-table')).toContainText('demo.batch_loaded');
  await page.keyboard.press('Escape');

  await expectDialogCloses(page, 'Privacy', 'Privacy');
  await page.getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByTestId('privacy-text')).toContainText('Nothing is uploaded and there is no server.');
  await expect(page.getByTestId('privacy-text')).toContainText('Don’t upload real sensitive receipts on a shared or public device.');
  await page.keyboard.press('Escape');

  // Spreadsheet view over the same records, and back.
  await page.getByRole('button', { name: 'Spreadsheet view' }).click();
  await expect(page.getByTestId('spreadsheet')).toContainText('Page Corner');
  await expect(page.getByTestId('spreadsheet')).toContainText('Unclear');
  await page.getByRole('button', { name: 'Review R-104' }).click();
  await expect(drawer(page)).toContainText('Amount is unclear on the receipt (read as “8?.00”).');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Knowledge-assisted view' }).click();

  // Filter chips and "Show batch" filter lists only.
  await page.getByRole('button', { name: 'Card transactions', exact: true }).click();
  await expect(page.getByTestId('receipt-list')).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.getByLabel('Show batch').selectOption({ label: 'Batch 1: First encounter' });
  await expect(page.getByTestId('m-unique')).toContainText('5');
  await page.getByLabel('Show batch').selectOption({ label: 'All batches' });

  // Card-transaction drawer.
  await page.getByRole('button', { name: /S-105A/ }).first().click();
  await expect(drawer(page)).toContainText('Card transaction S-105A');
  await drawer(page).getByRole('button', { name: 'Open R-105' }).click();
  await expect(drawer(page)).toContainText('2 card transactions match equally: S-105A, S-105B. Choose one.');
  await page.keyboard.press('Escape');

  // Record a ready proposal.
  await caseCard(page, 'R-101').getByRole('button', { name: 'Record R-101' }).click();
  await expect(group(page, 'recorded')).toContainText('R-101');

  // Reset demo: confirm, then the clean demo state.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reset' }).getByRole('button', { name: 'Reset demo' }).click();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('The demo workspace was reset.')).toBeVisible();
  await expect(page.getByText('The demo workspace is empty. Load the fictional Batch 1 to start.')).toBeVisible();
  await expect(page.getByTestId('coach-text')).toHaveCount(0);
  con.assertClean();
});

test('S2 rule cards: preview impact, suspend, view history, reactivate; draft card discard; Propose rule unsaved prompt', async ({ page }) => {
  const con = watchConsole(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await startDemo(page);
  await confirmR102(page);
  const d = drawer(page);
  await d.getByRole('button', { name: 'Propose reusable knowledge' }).click();
  await d.getByRole('button', { name: 'Preview impact' }).click();
  await d.getByRole('button', { name: 'Activate rule' }).click();
  await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
  const card = page.getByTestId('rule-K-ALIAS-0001');
  // Reduced motion: the highlight outline stays, the pulse animation is removed.
  await expect(card).toHaveClass(/is-new/);
  const style = await card.evaluate((el) => ({ animation: getComputedStyle(el).animationName, outline: getComputedStyle(el).outlineColor }));
  expect(style.animation).toBe('none');
  expect(style.outline).toBe('rgb(15, 118, 110)');

  await card.getByRole('button', { name: 'Preview impact' }).click();
  const pv = page.getByRole('dialog', { name: 'What depends on this rule now' });
  await expect(pv).toContainText('R-103');
  await page.keyboard.press('Escape');
  await expect(card.getByRole('button', { name: 'Preview impact' })).toBeFocused();

  await card.getByRole('button', { name: 'Suspend' }).click();
  const sd = page.getByRole('dialog', { name: 'Suspend K-ALIAS-0001 v1' });
  await expect(sd.getByRole('button', { name: 'Suspend rule' })).toBeDisabled();
  await sd.getByLabel('Why are you suspending this rule?').fill('Checking the card label');
  await sd.getByRole('button', { name: 'Suspend rule' }).click();
  await expect(card).toContainText('Suspended');
  await expect(group(page, 'needs_decision')).toContainText('R-103');

  await card.getByRole('button', { name: 'View history' }).click();
  const hd = page.getByRole('dialog', { name: 'History of K-ALIAS-0001' });
  await expect(hd).toContainText('Checking the card label');
  await hd.getByRole('button', { name: 'Reactivate', exact: true }).click();
  await expect(hd).toContainText('Impact if you reactivate this rule');
  await hd.getByRole('button', { name: 'Reactivate rule' }).click();
  await page.keyboard.press('Escape');
  await expect(card).toContainText('Active');
  await expect(group(page, 'ready')).toContainText('R-103');

  // Category preference from the recorded case, saved as a draft, then discarded from its card.
  await page.getByRole('button', { name: 'Review R-102' }).click();
  await d.getByRole('button', { name: 'Also suggest a category for Morning Cup' }).click();
  await d.getByLabel('Category', { exact: true }).selectOption({ label: 'Dining' });
  await d.getByRole('button', { name: 'Preview impact' }).click();
  await expect(d.getByTestId('draft-pending')).toContainText('Category: none → Dining (suggested)');
  await d.getByRole('button', { name: 'Close' }).first().click();
  await expect(d).toBeHidden();
  const cat = page.getByTestId('rule-K-CAT-0001');
  await expect(cat).toContainText('Draft v1 open');
  await cat.getByRole('button', { name: 'Discard draft' }).click();
  await page.getByRole('dialog', { name: 'Discard the draft of K-CAT-0001?' }).getByRole('button', { name: 'Discard draft' }).click();
  await expect(page.getByTestId('rule-K-CAT-0001')).toHaveCount(0);

  // "Propose rule" opens the same drawer; closing unsaved content asks first.
  await page.getByRole('button', { name: 'Propose rule' }).click();
  await expect(d.getByRole('heading', { name: 'Rule draft—review required' })).toBeVisible();
  await d.getByLabel('Card label, exactly as on the statement').fill('MC*');
  await d.getByLabel('Merchant name').fill('Morning Cup');
  // Live checks block activation before anything is saved.
  await expect(d.getByTestId('draft-checks')).toContainText('OVERBROAD');
  await page.keyboard.press('Escape');
  await expect(d.getByText('Discard this unsaved draft?')).toBeVisible();
  await d.getByRole('button', { name: 'Keep editing' }).click();
  await expect(d.getByLabel('Card label, exactly as on the statement')).toHaveValue('MC*');
  await page.keyboard.press('Escape');
  await d.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(d).toBeHidden();
  await expect(page.getByTestId('rule-K-ALIAS-0002')).toHaveCount(0); // nothing was written
  await expect(page.getByTestId('tour-step')).toHaveText('Step 2 of 4');
  await expect(coach(page)).toHaveText('Rule K-ALIAS-0001 v1 is active. R-103 is now ready without another decision. Next: load Batch 2.');
  con.assertClean();
});

test('S2 My files: empty state, add a PNG with manual entry, import the example CSV', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  await expect(page.getByText('No files yet. Add receipts or a card CSV, or try the fictional demo.')).toBeVisible();
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await expect(add).toContainText('Manual entry—automatic extraction is not enabled');
  await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles([
    { name: 'lunch.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('not an image') },
  ]);
  await expect(add).toContainText('Added 1 receipt.');
  await expect(add).toContainText('notes.png: not a JPEG or PNG image');
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = drawer(page);
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('Page Corner, Central');
  await d.getByLabel('Date').fill('2026-04-02');
  await d.getByLabel('Amount').fill('120.00');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d).toContainText('No card transaction with this amount and date yet');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const wiz = page.getByRole('dialog', { name: 'Import card CSV' });
  await wiz.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({
    name: 'example-card-statement.csv',
    mimeType: 'text/csv',
    buffer: readFileSync('public/demo/example-card-statement.csv'),
  });
  await wiz.getByLabel('Card account name').fill('Visa 1234');
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  await expect(wiz.getByRole('alert')).toContainText('Choose the date format.');
  await wiz.getByLabel('Date format').selectOption('DD/MM/YYYY');
  await wiz.getByLabel('Amount sign').selectOption({ label: 'Negative amounts are charges' });
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  const preview = wiz.getByTestId('import-preview');
  await expect(preview).toContainText('Total rows6');
  await expect(preview).toContainText('HKD debit totalHKD 278.50');
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByText('Imported 6 card transactions from example-card-statement.csv.')).toBeVisible();
  await expect(group(page, 'ready')).toContainText('R-0001');
  await expect(page.getByTestId('m-cardrows')).toContainText('5');
  con.assertClean();
});

async function importRows(page: Page, fileName: string, rows: string[], newAccount: boolean) {
  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const wiz = page.getByRole('dialog', { name: 'Import card CSV' });
  await wiz.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({
    name: fileName,
    mimeType: 'text/csv',
    buffer: Buffer.from(['Posting date,Description,Amount', ...rows].join('\n')),
  });
  if (newAccount) await wiz.getByLabel('Card account name').fill('Visa 1234');
  await wiz.getByLabel('Date format').selectOption('YYYY-MM-DD');
  await wiz.getByLabel('Amount sign').selectOption({ label: 'Positive amounts are charges' });
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByText(`Imported ${rows.length} card transaction${rows.length === 1 ? '' : 's'} from ${fileName}.`)).toBeVisible();
}

async function enterFields(page: Page, id: string) {
  const d = drawer(page);
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('Page Corner');
  await d.getByLabel('Date').fill('2026-03-02');
  await d.getByLabel('Amount').fill('120.00');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await expect(d).toContainText(id);
}

test('S2 My files: possible duplicates are resolved in the drawers (keep both, set aside, different purchases)', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  // Two different photos of what may be the same purchase.
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles([
    { name: 'lunch.png', mimeType: 'image/png', buffer: PNG_1X1 },
    { name: 'lunch-again.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_1X1, Buffer.from([0])]) },
  ]);
  await expect(add).toContainText('Added 2 receipts.');
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  await enterFields(page, 'R-0001');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Review R-0002' }).click();
  await enterFields(page, 'R-0002');
  const d = drawer(page);
  await expect(d).toContainText('Possible duplicate of R-0001 from another file. Choose “These are different purchases” or set this one aside.');
  await expect(d.getByRole('button', { name: 'Confirm this case only' })).toBeDisabled();
  await expect(d).toContainText('Resolve the possible duplicate first.');
  await d.getByRole('button', { name: 'These are different purchases' }).click();
  await expect(d.getByRole('button', { name: 'These are different purchases' })).toHaveCount(0);
  await expect(d).toContainText('No card transaction with this amount and date yet');
  await page.keyboard.press('Escape');
  await expect(caseCard(page, 'R-0001')).not.toContainText('Possible duplicate');

  // A second card file repeats a row of the first one (no reference column).
  await importRows(page, 'march.csv', ['2026-03-05,CITY PARKING,30.00', '2026-03-06,TAXI,45.00'], true);
  await importRows(page, 'march-export.csv', ['2026-03-05,CITY PARKING,30.00', '2026-03-06,TAXI,45.00', '2026-03-07,BOOKSHOP,9.00'], false);
  const held = group(page, 'needs_decision').getByRole('button', { name: /CITY PARKING.*Possible duplicate/ });
  await expect(held).toHaveCount(1);
  await held.click();
  await expect(d.getByRole('button', { name: 'Keep both' })).toBeVisible();
  await d.getByRole('button', { name: 'Keep both' }).click();
  await expect(d.getByRole('button', { name: 'Keep both' })).toHaveCount(0);
  await expect(d).toContainText('No receipt yet');
  await page.keyboard.press('Escape');

  await group(page, 'needs_decision').getByRole('button', { name: /TAXI.*Possible duplicate/ }).click();
  await d.getByRole('button', { name: 'Set aside this row' }).click();
  await expect(d).toContainText('Set aside as a duplicate');
  await page.keyboard.press('Escape');
  await expect(group(page, 'needs_decision').getByRole('button', { name: /Possible duplicate/ })).toHaveCount(0);
  const footnote = page.getByTestId('set-aside');
  await footnote.getByText('Set aside as duplicates (not recorded)').click();
  await expect(footnote).toContainText('TAXI');

  // The receipt-side "Set this one aside": a third photo of the same purchase.
  await page.getByRole('button', { name: 'Add receipts' }).click();
  await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles([
    { name: 'lunch-third.png', mimeType: 'image/png', buffer: Buffer.concat([PNG_1X1, Buffer.from([1])]) },
  ]);
  await add.getByRole('button', { name: 'Open R-0003' }).click();
  await enterFields(page, 'R-0003');
  await d.getByRole('button', { name: 'Set this one aside as a duplicate' }).click();
  await expect(d).toContainText('Set aside as a duplicate (not recorded).');
  await expect(d.getByRole('button', { name: 'Confirm this case only' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(footnote).toContainText('R-0003');
  await expect(page.getByTestId('m-unique').locator('dd')).toHaveText('2');
  con.assertClean();
});

test('S2 narrow screens use accessible tabs with arrow keys', async ({ page }) => {
  const con = watchConsole(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await startDemo(page);
  const tab = page.getByRole('tab', { name: 'Your data' });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await tab.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Knowledge Space' })).toBeFocused();
  await expect(page.getByRole('tabpanel')).toContainText('Your approved rules are reused. The AI model is not being retrained.');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tabpanel')).toContainText('Ready to record');
  con.assertClean();
});
