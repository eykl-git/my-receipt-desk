/**
 * S4 browser flows (brief §23, §26, §27): IndexedDB persistence, a PNG receipt
 * with manual entry, the CSV import wizard with the downloaded example CSV,
 * exports, knowledge import, reset and privacy, the MYR workspace, the
 * store-number rule draft, and "Read automatically" (OCR) with cancel and
 * failure. Real Chromium clicks against the dev server.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { drawer, group, startDemo, watchConsole } from './helpers';

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const SAMPLE_MY = 'public/samples/sample-receipt-my.png';

async function text(download: Download): Promise<string> {
  return readFileSync((await download.path())!, 'utf8');
}

async function addPng(page: Page, name: string, buffer: Buffer) {
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await add.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles({ name, mimeType: 'image/png', buffer });
  await expect(add).toContainText('Added 1 receipt.');
  return add;
}

async function importCsv(page: Page, name: string, buffer: Buffer, account: string, format: string) {
  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const wiz = page.getByRole('dialog', { name: 'Import card CSV' });
  await wiz.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({ name, mimeType: 'text/csv', buffer });
  await wiz.getByLabel('Card account name').fill(account);
  await wiz.getByLabel('Date format').selectOption(format);
  await wiz.getByLabel('Amount sign').selectOption({ label: 'Negative amounts are charges' });
  await wiz.getByRole('button', { name: 'Preview import' }).click();
  return wiz;
}

test('S4 IndexedDB: a My files receipt with manual entry and demo progress survive a reload; Privacy names IndexedDB', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const add = await addPng(page, 'lunch.png', PNG_1X1);
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = drawer(page);
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('Page Corner');
  await d.getByLabel('Date').fill('2026-04-02');
  await d.getByLabel('Amount').fill('120.00');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('receipt-list')).toContainText('R-0001 Page Corner');
  await expect(page.getByTestId('receipt-list')).toContainText('HKD 120.00');

  // A text file renamed .png is rejected.
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const again = page.getByRole('dialog', { name: 'Add receipts' });
  await again.getByLabel('Receipt images (JPEG or PNG, up to 10 MB each, 20 at a time)').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('hello') });
  await expect(again).toContainText('notes.png: not a JPEG or PNG image');
  await page.keyboard.press('Escape');

  // Demo progress (tour step 2) and the last workspace are restored after a reload.
  await page.getByRole('button', { name: 'Demo workspace (fictional)' }).click();
  await page.getByRole('button', { name: 'Try the 60-second demo' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 2 of 4');
  await page.reload();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 2 of 4');
  await expect(page.getByRole('button', { name: 'Demo workspace (fictional)' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Next batch' }).click();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');

  const privacy = page.getByRole('button', { name: 'Privacy' });
  await privacy.click();
  const dlg = page.getByRole('dialog', { name: 'Privacy' });
  await expect(dlg.getByTestId('privacy-text')).toContainText('local storage (IndexedDB)');
  await expect(dlg).toContainText('Read automatically');
  await page.keyboard.press('Escape');
  await expect(privacy).toBeFocused();
  con.assertClean();
});

test('S4 CSV wizard with the downloaded example CSV: exact preview, import, re-import refused', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download example CSV' }).click()]);
  const bytes = readFileSync((await dl.path())!);
  expect(bytes.equals(readFileSync('public/demo/example-card-statement.csv'))).toBe(true);
  const wiz = await importCsv(page, 'example-card-statement.csv', bytes, 'Visa 1234', 'DD/MM/YYYY');
  const preview = wiz.getByTestId('import-preview');
  for (const t of ['Total rows6', 'Valid6', 'Errors0', 'Quarantined (not HKD)1', 'Credits (not supported)1', 'HKD debit rows4', 'HKD debit totalHKD 278.50']) await expect(preview).toContainText(t);
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByText('Imported 6 card transactions from example-card-statement.csv.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('m-cardrows')).toContainText('6');
  await page.getByRole('button', { name: 'Import card CSV' }).click();
  const again = page.getByRole('dialog', { name: 'Import card CSV' });
  await again.getByLabel('Card statement (.csv, UTF-8, up to 2 MB)').setInputFiles({ name: 'example-card-statement.csv', mimeType: 'text/csv', buffer: bytes });
  await expect(again.getByRole('alert')).toContainText('This file was already imported on');
  con.assertClean();
});

test('S4 exports from the demo, knowledge JSON into My files, reset keeps My files, delete all returns to the first screen', async ({ page }) => {
  const con = watchConsole(page);
  await startDemo(page);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Open R-102' }).click();
  const d = drawer(page);
  await d.getByRole('button', { name: 'Confirm this case only' }).click();
  await d.getByRole('button', { name: 'Confirm and record' }).click();
  await d.getByRole('button', { name: 'Propose reusable knowledge' }).click();
  await d.getByRole('button', { name: 'Preview impact' }).click();
  await d.getByRole('button', { name: 'Activate rule' }).click();
  await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();

  const exportsButton = page.getByRole('button', { name: 'Exports', exact: true });
  await exportsButton.click();
  const ex = page.getByRole('dialog', { name: 'Exports' });
  const grab = async (name: string) => {
    const [dl] = await Promise.all([page.waitForEvent('download'), ex.getByRole('button', { name }).click()]);
    return { name: dl.suggestedFilename(), body: await text(dl), path: (await dl.path())! };
  };
  const ledger = await grab('Export ledger CSV');
  expect(ledger.name).toMatch(/^my-receipt-desk-ledger-demo-\d{8}\.csv$/);
  expect(ledger.body.charCodeAt(0)).toBe(0xfeff);
  expect(ledger.body).toContain('"ledger_id","expense_date","merchant","amount","currency","category","category_status","ledger_status","reconciliation_status","match_method","receipt_ids","transaction_ids","source_document_ids","rule_refs","evidence_status","recorded_at"\r\n');
  expect(ledger.body).toContain('"L-0001","2026-03-04","Morning Cup","48.00","HKD"');
  const exceptions = await grab('Export exceptions CSV');
  expect(exceptions.body).toContain('"R-104","receipt","2026-03-08","Green Basket","","","HKD"');
  const knowledge = await grab('Export knowledge JSON');
  expect(JSON.parse(knowledge.body).rules[0].head.ruleId).toBe('K-ALIAS-0001');
  const md = await grab('Download KNOWLEDGE.md');
  expect(md.name).toBe('KNOWLEDGE.md');
  expect(md.body).toContain('Generated from your approved rules. Editing this file changes nothing in the app.');

  await ex.getByRole('button', { name: 'Import knowledge JSON' }).click();
  const imp = page.getByRole('dialog', { name: 'Import knowledge JSON' });
  await imp.getByLabel('Knowledge file (.json, up to 1 MB, 200 rules)').setInputFiles(knowledge.path);
  await expect(imp.getByTestId('knowledge-plan')).toContainText('K-ALIAS-0001 v1');
  await expect(imp.getByTestId('knowledge-plan')).toContainText('OVERBROAD: That card account is not in this workspace.');
  await imp.getByRole('button', { name: 'Create drafts' }).click();
  await expect(page.getByText('Created 1 draft in My files. Nothing is active until you activate it.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'My files' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('rule-K-ALIAS-0001')).toContainText('Draft v1 open');
  await expect(page.getByTestId('m-active')).toContainText('0');

  // Reset demo keeps My files.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  const reset = page.getByRole('dialog', { name: 'Reset' });
  await reset.getByRole('button', { name: 'Reset demo' }).click();
  await reset.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('The demo workspace was reset.')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('rule-K-ALIAS-0001')).toContainText('Draft v1 open');
  await page.getByRole('button', { name: 'Demo workspace (fictional)' }).click();
  await expect(page.getByText('The demo workspace is empty. Load the fictional Batch 1 to start.')).toBeVisible();

  // Delete all: both workspaces go and the app returns to the first screen.
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.getByRole('dialog', { name: 'Reset' }).getByRole('button', { name: 'Delete all data in this browser' }).click();
  await page.getByRole('dialog', { name: 'Reset' }).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('All data in this browser was deleted.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('No files yet. Add receipts or a card CSV, or try the fictional demo.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'My files' })).toHaveAttribute('aria-pressed', 'true');
  con.assertClean();
});

test('S4 MYR workspace, "Read automatically" on the Malaysian sample, MYR import, manual confirm; same-origin requests only', async ({ page, baseURL }) => {
  const con = watchConsole(page);
  const foreign: string[] = [];
  page.on('request', (r) => {
    if (!r.url().startsWith(baseURL!) && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) foreign.push(r.url());
  });
  await page.goto('/');
  const currency = page.getByLabel('Currency for My files');
  await currency.selectOption('MYR');
  await expect(page.getByTestId('live-region')).toHaveText('My files now uses MYR.');
  const add = await addPng(page, 'sample-receipt-my.png', readFileSync(SAMPLE_MY));
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  await expect(currency).toBeDisabled();
  await expect(page.getByText('Currency can’t be changed after data is added. Delete My files data first.')).toBeAttached();
  const d = drawer(page);
  const box = d.getByTestId('ocr-box');
  await expect(box.getByLabel('Receipt language')).toHaveValue('eng+msa');
  await expect(box.getByLabel('Receipt language').locator('option')).toHaveText(['English + Malay', '简体中文 + English', '繁體中文 + English']);
  await box.getByRole('button', { name: 'Read automatically' }).click();
  await expect(d.getByTestId('ocr-outcome')).toContainText('Looks like a Malaysian receipt:', { timeout: 60_000 });
  await expect(d).toContainText('Read automatically, check before saving');
  await expect(d).toContainText('CONTOH MART SDN BHD');
  await expect(d).toContainText('2026-03-14');
  await expect(d).toContainText('23.00');
  // Read once only (an extracted original is never overwritten); still unconfirmed, so it needs a decision.
  await expect(d.getByTestId('ocr-box')).toHaveCount(0);
  await expect(d.getByRole('button', { name: 'Confirm this case only' })).toBeDisabled();
  await expect(d).toContainText('Check the receipt fields first');
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await expect(d.getByLabel('Merchant')).toHaveValue('CONTOH MART SDN BHD');
  await expect(d.getByLabel('Currency')).toHaveValue('MYR');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await page.keyboard.press('Escape');

  const wiz = await importCsv(page, 'example-card-statement-my.csv', readFileSync('public/samples/example-card-statement-my.csv'), 'Contoh Card 5678', 'DD/MM/YYYY');
  for (const t of ['Total rows4', 'Quarantined (not MYR)0', 'MYR debit rows4', 'MYR debit totalMYR 97.40']) await expect(wiz.getByTestId('import-preview')).toContainText(t);
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByTestId('m-spending')).toContainText('MYR 97.40');
  // A card row without a Reference is shown by its row and file (N4).
  await expect(page.getByText('Row 3 of example-card-statement-my.csv').first()).toBeVisible();
  await page.getByTestId('receipt-list').getByRole('button', { name: /R-0001/ }).click();
  await expect(d).toContainText('Card label “CONTOH MART PJ” is not a known name for CONTOH MART SDN BHD.');
  await d.getByRole('button', { name: 'Confirm this case only' }).click();
  await d.getByLabel('Why this is the right transaction').fill('Same shop, same amount and date');
  await d.getByRole('button', { name: 'Confirm and record' }).click();
  await expect(d.getByText('Your confirmation is saved. A rule is a separate decision.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('m-paid')).toContainText('MYR 23.00');
  expect(foreign).toEqual([]);
  con.assertClean();
});

test('S4 "Read automatically": Cancel stops it and the language files failing to load leaves the record unchanged', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const add = await addPng(page, 'sample-receipt-my.png', readFileSync(SAMPLE_MY));
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  const d = drawer(page);
  // Default language follows the workspace currency: HKD → Traditional Chinese + English.
  await expect(d.getByLabel('Receipt language')).toHaveValue('chi_tra+eng');
  // Hold the language file so the read is still running when Cancel is pressed.
  let release: () => void = () => undefined;
  await page.context().route('**/ocr/lang/**', async (route) => {
    await new Promise<void>((r) => (release = r));
    await route.continue().catch(() => undefined);
  });
  await d.getByRole('button', { name: 'Read automatically' }).click();
  const cancel = d.getByTestId('ocr-box').getByRole('button', { name: 'Cancel' });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(d.getByRole('alert')).toHaveText('Reading was cancelled. Nothing was changed.');
  release();
  await page.context().unroute('**/ocr/lang/**');
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');

  await page.context().route('**/ocr/lang/**', (route) => route.abort());
  await d.getByLabel('Receipt language').selectOption('eng+msa');
  await d.getByRole('button', { name: 'Read automatically' }).click();
  await expect(d.getByRole('alert')).toContainText('Couldn’t read this image. Enter the fields by hand.', { timeout: 65_000 });
  await expect(d).toContainText('Manual entry—automatic extraction is not enabled');
  await expect(d.getByRole('button', { name: 'Read automatically' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Audit history' }).click();
  await expect(page.getByTestId('audit-table')).not.toContainText('capture.fields_extracted');
  // Expected on the console: the aborted requests, and the tesseract core's own "Parameter not found"
  // warnings while it loads the chi_tra model of the cancelled read (third-party output, not app errors).
  expect(con.errors.filter((e) => !/ocr\/lang|Failed to load resource|net::ERR_FAILED|traineddata|^Warning: Parameter not found: /i.test(e))).toEqual([]);
});

test('S4 store-number rule draft lists the covered card labels; similarity hint in the drawer', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const csv = Buffer.from('Posted,Details,Amount\n03/03/2026,PACIFIC COFFEE #042,-38.00\n04/03/2026,PACIFIC COFFEE #117,-42.00\n05/03/2026,PACIFIC COFFEE ROASTERS #1,-51.00\n');
  const wiz = await importCsv(page, 'pacific.csv', csv, 'Visa 1234', 'DD/MM/YYYY');
  await wiz.getByRole('button', { name: 'Import all rows' }).click();
  await expect(page.getByText('Imported 3 card transactions from pacific.csv.')).toBeVisible();
  const bar = page.getByTestId('phrase-bar');
  await bar.getByLabel('Write a rule in plain English').fill('Remember PACIFIC COFFEE #042 as Pacific Coffee, ignoring store numbers.');
  await bar.getByRole('button', { name: 'Draft rule' }).click();
  const d = drawer(page);
  await expect(d.getByLabel('Also match this name with a different store number at the end (for example #042)')).toBeChecked();
  const covered = d.getByTestId('covered-labels');
  await expect(covered.getByRole('listitem')).toHaveText(['PACIFIC COFFEE #042', 'PACIFIC COFFEE #117']);
  await expect(d.getByTestId('draft-checks')).toContainText('No blocking findings.');
  await page.keyboard.press('Escape');
  await d.getByRole('button', { name: 'Discard', exact: true }).click();

  // A receipt whose card label differs gets the "Shares the word" hint, never a number.
  const add = await addPng(page, 'coffee.png', PNG_1X1);
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('Harbour Coffee');
  await d.getByLabel('Date').fill('2026-03-02');
  await d.getByLabel('Amount').fill('38.00');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByTestId('candidate-table')).toContainText('Shares the word “COFFEE”');
  await expect(d.getByTestId('candidate-table')).not.toContainText('%');
  await expect(group(page, 'needs_decision')).toContainText('R-0001');
  con.assertClean();
});
