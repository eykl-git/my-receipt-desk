/**
 * S5 browser flows (brief §23): suspend, view history, re-check, reactivate,
 * edit, void, confirm category, pause, audit history, and in My files the
 * statement-only record, unlink and an unpaid invoice that is paid and then
 * voided. Real Chromium clicks and keys against the dev server.
 */
import { expect, test, type Page } from '@playwright/test';
import { caseCard, databaseVersion, drawer, group, importCsvFile, MY_CSV, seededNote, seedNewerDatabase, startDemo, teach, watchConsole } from './helpers';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const PNG_2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/eL9GtQAAAABJRU5ErkJggg==', 'base64');
const card = (page: Page) => page.getByTestId('rule-K-ALIAS-0001');

async function recordR103(page: Page) {
  await caseCard(page, 'R-103').getByRole('button', { name: 'Record R-103' }).click();
  await expect(group(page, 'recorded')).toContainText('R-103');
}

test.describe('S5 integrity, history and audit', () => {
  test('S5 rule lifecycle: preview, suspend, history, re-check, reactivate, edit to v2', async ({ page }) => {
    const con = watchConsole(page);
    await teach(page);
    await recordR103(page);

    // "Preview impact" on an active card is read-only; Escape returns focus to the button.
    const preview = card(page).getByRole('button', { name: 'Preview impact' });
    await preview.click();
    const pd = page.getByRole('dialog', { name: 'What depends on this rule now' });
    await expect(pd).toContainText('Read-only preview. Nothing is changed.');
    await expect(pd).toContainText('Recorded using this rule — not changed');
    await page.keyboard.press('Escape');
    await expect(pd).toBeHidden();
    await expect(preview).toBeFocused();

    // Suspend needs a reason; recorded entries keep their rule refs and say "(now suspended)".
    await card(page).getByRole('button', { name: 'Suspend' }).click();
    const sd = page.getByRole('dialog', { name: 'Suspend K-ALIAS-0001 v1' });
    await expect(sd.getByRole('button', { name: 'Suspend rule' })).toBeDisabled();
    await sd.getByLabel('Why are you suspending this rule?').fill('Checking the card label');
    await sd.getByRole('button', { name: 'Suspend rule' }).click();
    await expect(sd).toBeHidden();
    await expect(card(page)).toContainText('Suspended');
    await expect(caseCard(page, 'R-103')).toContainText('Recorded using K-ALIAS-0001 v1 (now suspended)');
    await expect(page.getByTestId('coach-text')).toHaveText('Rule K-ALIAS-0001 v1 is suspended, so it is not applied. Reactivate it from “View history”, or continue without it. Next: load Batch 2.');
    await expect(page.getByRole('button', { name: 'Open R-102' })).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'K-ALIAS-0001 v1 suspended.' })).toBeVisible();

    // View history → re-check → keep as recorded → back to history → reactivate with a fresh preview.
    await card(page).getByRole('button', { name: 'View history' }).click();
    const hd = page.getByRole('dialog', { name: 'History of K-ALIAS-0001' });
    await expect(hd).toContainText('Suspended');
    await expect(hd).toContainText('Checking the card label');
    await hd.getByRole('button', { name: 'Re-check recorded entries' }).click();
    const rd = page.getByTestId('recheck-dialog');
    await expect(rd).toContainText('L-0002 (R-103)');
    await expect(rd).toContainText('K-ALIAS-0001 v1 is now suspended.');
    await expect(rd).toContainText('Now: Card label “MC COFFEE HK” is not a known name for Morning Cup.');
    await rd.getByRole('button', { name: 'Keep as recorded' }).click();
    await expect(rd).toContainText('Every recorded entry would be recorded the same way under the current rules.');
    await page.keyboard.press('Escape');
    await expect(hd).toBeVisible();
    await hd.getByRole('button', { name: 'Reactivate', exact: true }).click();
    await expect(hd).toContainText('Impact if you reactivate this rule');
    await hd.getByRole('button', { name: 'Reactivate rule' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'K-ALIAS-0001 v1 active.' })).toBeVisible();
    await hd.getByRole('button', { name: 'Close' }).click();
    await expect(card(page)).toContainText('Active');

    // Edit → v2 draft; activation supersedes v1, which stays readable.
    await card(page).getByRole('button', { name: 'Edit K-ALIAS-0001' }).click();
    const d = drawer(page);
    await expect(d).toContainText('Editing K-ALIAS-0001 v1. Your changes are saved as v2 at “Preview impact”.');
    await d.getByRole('button', { name: 'Preview impact' }).click();
    await expect(d.getByText('Saved as K-ALIAS-0001 v2 (draft). It does nothing until you activate it.')).toBeVisible();
    await d.getByRole('button', { name: 'Activate rule' }).click();
    await expect(d.getByTestId('activation-summary')).toContainText('K-ALIAS-0001 v2 is active.');
    await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
    await expect(card(page)).toContainText('K-ALIAS-0001 v2');
    await card(page).getByRole('button', { name: 'View history' }).click();
    await expect(hd.getByRole('row', { name: /v1 Superseded by v2/ })).toBeVisible();
    await expect(hd.getByRole('row', { name: /v2 Active version/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(card(page).getByRole('button', { name: 'View history' })).toBeFocused();
    con.assertClean();
  });

  test('S5 corrections: void with a confirm dialog, confirm category, audit history', async ({ page }) => {
    const con = watchConsole(page);
    await teach(page);
    await recordR103(page);
    await caseCard(page, 'R-103').getByRole('button', { name: 'Review R-103' }).click();
    const d = drawer(page);
    const voidButton = d.getByRole('button', { name: 'Void entry' });
    // Cancel and Escape close the confirm dialog and return focus to "Void entry".
    await voidButton.click();
    const vd = page.getByTestId('void-dialog');
    await expect(vd).toContainText('Void L-0002? The expense stops counting as recorded and the receipt returns to review. History is kept.');
    await vd.getByRole('button', { name: 'Cancel' }).click();
    await expect(vd).toBeHidden();
    await expect(voidButton).toBeFocused();
    await voidButton.click();
    await page.keyboard.press('Escape');
    await expect(vd).toBeHidden();
    await expect(voidButton).toBeFocused();
    await voidButton.click();
    await expect(vd.getByRole('button', { name: 'Void entry' })).toBeDisabled();
    await vd.getByLabel('Why are you voiding this entry?').fill('Recorded the wrong receipt');
    await vd.getByRole('button', { name: 'Void entry' }).click();
    await expect(vd).toBeHidden();
    await expect(d).toContainText('Previous entry L-0002 voided');
    await expect(d.getByRole('button', { name: 'Record' })).toBeVisible();

    // Category only: the group does not change.
    await d.getByLabel('Category', { exact: true }).selectOption({ label: 'Dining' });
    await d.getByRole('button', { name: 'Confirm category' }).click();
    await expect(d).toContainText('Dining (confirmed)');
    await expect(d).toContainText('Ready to record');
    await page.keyboard.press('Escape');
    await expect(d).toBeHidden();
    await expect(group(page, 'ready')).toContainText('R-103');

    const audit = page.getByRole('button', { name: 'Audit history' });
    await audit.click();
    const ad = page.getByRole('dialog', { name: 'Audit history' });
    await expect(ad).toContainText('Inspectable local log. It is not tamper-proof.');
    const table = ad.getByTestId('audit-table');
    await expect(table.getByRole('row').nth(1)).toContainText('category.confirmed');
    await expect(table).toContainText('ledger.voided');
    await expect(table).toContainText('match.released');
    await expect(table).toContainText('Recorded the wrong receipt');
    await expect(table).toContainText('rule.activated');
    await page.keyboard.press('Escape');
    await expect(audit).toBeFocused();
    con.assertClean();
  });

  test('S5 "Pause processing" stops "Record all ready" before the next record; recorded entries stay', async ({ page }) => {
    const con = watchConsole(page);
    // A short wait between commits (test aid, design §20 A-S5-6) leaves time to press Pause.
    await page.goto('/?recordDelay=1500');
    await page.getByRole('button', { name: 'Try the 60-second demo' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 1 of 4');
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');
    await page.getByRole('button', { name: 'Next batch' }).click();
    await expect(page.getByTestId('tour-step')).toHaveText('Step 4 of 4');
    await expect(group(page, 'ready').locator('.case-card')).toHaveCount(3);
    await page.getByRole('button', { name: 'Record all ready' }).click();
    const pause = page.getByRole('button', { name: 'Pause processing' });
    await expect(pause).toBeVisible();
    await expect(page.getByTestId('pause-row')).toContainText('Pausing stops before the next record. Entries already recorded stay recorded.');
    await expect(group(page, 'ready').getByRole('button', { name: 'Record R-203' })).toBeDisabled();
    await expect(group(page, 'recorded')).toContainText('R-101');
    await pause.click();
    await expect(page.getByRole('status').filter({ hasText: 'Recorded 1. Paused before 2 more. Entries already recorded stay recorded.' })).toBeVisible();
    await expect(pause).toBeHidden();
    await expect(group(page, 'ready').locator('.case-card')).toHaveCount(2);
    await expect(group(page, 'recorded').locator('.case-card')).toHaveCount(1);
    // The pause ended with the run: a single "Record" works.
    await caseCard(page, 'R-203').getByRole('button', { name: 'Record R-203' }).click();
    await expect(group(page, 'recorded')).toContainText('R-203');
    con.assertClean();
  });

  test('S5 My files: statement-only record, receipt attached then unlinked, invoice unpaid until linked, void reopens it', async ({ page }) => {
    const con = watchConsole(page);
    await page.goto('/');
    await importCsvFile(page, 'april.csv', MY_CSV);

    // Record PAGE CORNER from the statement.
    await page.getByRole('button', { name: /PAGE CORNER/ }).first().click();
    const d = drawer(page);
    await d.getByRole('button', { name: 'Record from statement (no receipt yet)' }).click();
    await expect(d).toContainText('Recorded as L-0001 from the card statement.');
    await page.keyboard.press('Escape');

    // A receipt for it gains the same entry, then is unlinked; the card expense stays recorded.
    await page.getByRole('button', { name: 'Add receipts' }).click();
    const add = page.getByRole('dialog', { name: 'Add receipts' });
    await expect(add.getByRole('radio', { name: 'Receipt (paid)' })).toBeChecked();
    await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles({ name: 'page.png', mimeType: 'image/png', buffer: PNG_1X1 });
    await add.getByRole('button', { name: 'Open R-0001' }).click();
    await d.getByRole('button', { name: 'Edit fields' }).click();
    await d.getByLabel('Merchant').fill('Page Corner');
    await d.getByLabel('Date').fill('2026-04-02');
    await d.getByLabel('Amount').fill('120.00');
    await d.getByRole('button', { name: 'Save fields' }).click();
    await d.getByRole('contentinfo').getByRole('button', { name: 'Record' }).click();
    await expect(d).toContainText('Recorded as L-0001.');
    const unlink = d.getByRole('button', { name: 'Unlink this receipt' });
    await unlink.click();
    const vd = page.getByTestId('void-dialog');
    await expect(vd).toContainText('Unlink R-0001 from L-0001? The card expense stays recorded and the receipt returns to review. History is kept.');
    await vd.getByLabel('Why are you unlinking this receipt?').fill('Receipt is for another purchase');
    await vd.getByRole('button', { name: 'Unlink this receipt' }).click();
    await expect(vd).toBeHidden();
    await expect(d).toContainText('Ready to record');
    await page.keyboard.press('Escape');

    // Invoice: not yet paid, excluded from paid totals, then linked and voided.
    await page.getByRole('button', { name: 'Add receipts' }).click();
    await add.getByRole('radio', { name: 'Invoice (not yet paid)' }).check();
    await expect(add).toContainText('An invoice is not proof of payment.');
    await add.getByLabel('Invoice image (JPEG or PNG, up to 10 MB)').setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG_2 });
    await add.getByLabel('Supplier').fill('Harbour Print Ltd');
    await add.getByLabel('Invoice number (optional)').fill('HP-041');
    await add.getByLabel('Invoice date').fill('2026-04-01');
    await add.getByLabel('Amount').fill('350.00');
    await add.getByRole('button', { name: 'Add invoice' }).click();
    await expect(add).toContainText('Added INV-0001 as not yet paid.');
    await add.getByRole('button', { name: 'Open INV-0001' }).click();
    await expect(d).toContainText('Not yet paid');
    await expect(page.getByTestId('m-unpaid').locator('dd')).toHaveText('HKD 350.00');
    await expect(page.getByTestId('m-paid').locator('dd')).toHaveText('HKD 120.00');
    await d.getByRole('button', { name: 'Link card payment' }).click();
    await expect(d.getByRole('radio', { name: /HARBOUR PRINT LTD/ })).toBeChecked();
    await d.getByLabel('Why this card transaction paid the invoice').fill('Paid by card on 6 April');
    await d.getByRole('button', { name: 'Confirm and record' }).click();
    await expect(d).toContainText('Paid. Recorded as L-0002.');
    await expect(page.getByTestId('m-unpaid').locator('dd')).toHaveText('HKD 0.00');
    await expect(page.getByTestId('m-paid').locator('dd')).toHaveText('HKD 470.00');
    await d.getByRole('button', { name: 'Void entry' }).click();
    await vd.getByLabel('Why are you voiding this entry?').fill('Paid from another card');
    await vd.getByRole('button', { name: 'Void entry' }).click();
    await expect(d).toContainText('Not yet paid');
    await expect(page.getByTestId('m-unpaid').locator('dd')).toHaveText('HKD 350.00');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Invoices (not yet paid)' }).click();
    await expect(page.getByTestId('invoice-list')).toContainText('INV-0001');
    con.assertClean();
  });

  test('S5 newer-version banner: one click deletes nothing; only the confirmed Delete removes that workspace', async ({ page }) => {
    const con = watchConsole(page);
    // The demo holds Batch 1; My files is then saved "by a newer version" (version 99).
    await startDemo(page);
    await seedNewerDatabase(page, 'mrd-personal');
    await page.goto('/');
    const banner = page.getByTestId('storage-banner');
    await expect(banner).toContainText('This data was saved by a newer version of the app. It hasn’t been changed.');
    await expect(caseCard(page, 'R-101')).toBeVisible();

    // One click only opens the confirm step; nothing is deleted.
    const del = banner.getByRole('button', { name: 'Delete data in this workspace' });
    await del.click();
    const confirm = page.getByTestId('delete-newer-confirm');
    await expect(confirm).toHaveText(/Delete the data in My files\? It was saved by a newer version of the app and can’t be recovered\. The demo is not affected\./);
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    expect(await databaseVersion(page, 'mrd-personal')).toBe(99);
    expect(await seededNote(page, 'mrd-personal')).toBe('saved by a newer version');

    // Cancel closes the step, returns focus and still deletes nothing.
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toBeHidden();
    await expect(del).toBeFocused();
    expect(await databaseVersion(page, 'mrd-personal')).toBe(99);
    expect(await seededNote(page, 'mrd-personal')).toBe('saved by a newer version');

    // Delete after confirming removes My files only; the demo keeps its cases.
    await del.click();
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(banner).toBeHidden();
    await expect(page.getByRole('status').filter({ hasText: 'My files data was deleted.' })).toBeVisible();
    expect(await databaseVersion(page, 'mrd-personal')).toBeLessThan(99);
    expect(await seededNote(page, 'mrd-personal')).toBeNull();
    await expect(caseCard(page, 'R-101')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('storage-banner')).toHaveCount(0);
    await expect(caseCard(page, 'R-101')).toBeVisible();
    // The only console errors are the logged VersionError from the first open.
    expect(con.errors.every((e) => /version/i.test(e))).toBe(true);
  });
});
