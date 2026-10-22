/**
 * E6 exports (design §15 E6, §12.2, §12.3, T18 in the browser): real downloads
 * from the Exports dialog. CSVs start with a BOM, have the documented headers,
 * quote every field and prefix formula-like text with ', while amount and date
 * columns stay plain. KNOWLEDGE.md and the knowledge JSON come from the rules.
 */
import { expect, test, type Page } from '@playwright/test';
import { downloadText, drawer, expectNoSeriousAxe, importCsvFile, PNG_1X1, RECEIPT_INPUT, teach, watchConsole } from './helpers';

const LEDGER_HEADER =
  '"ledger_id","expense_date","merchant","amount","currency","category","category_status","ledger_status","reconciliation_status","match_method","receipt_ids","transaction_ids","source_document_ids","rule_refs","evidence_status","recorded_at"\r\n';
const EXCEPTIONS_HEADER = '"case_id","case_type","date","merchant_or_label","direction","amount","currency","reasons","flags","candidate_ids"\r\n';

async function grab(page: Page, name: string) {
  const ex = page.getByRole('dialog', { name: 'Exports' });
  const [dl] = await Promise.all([page.waitForEvent('download'), ex.getByRole('button', { name }).click()]);
  return { name: dl.suggestedFilename(), body: await downloadText(dl) };
}

test('E6 demo exports: ledger and exceptions CSV (BOM, headers, typed columns), knowledge JSON and KNOWLEDGE.md', async ({ page }) => {
  const con = watchConsole(page);
  await teach(page);
  const exportsButton = page.getByRole('button', { name: 'Exports', exact: true });
  await exportsButton.click();
  await expectNoSeriousAxe(page, 'Exports dialog');

  const ledger = await grab(page, 'Export ledger CSV');
  expect(ledger.name).toMatch(/^my-receipt-desk-ledger-demo-\d{8}\.csv$/);
  expect(ledger.body.charCodeAt(0)).toBe(0xfeff);
  expect(ledger.body.slice(1).startsWith(LEDGER_HEADER)).toBe(true);
  expect(ledger.body).toMatch(/"L-0001","2026-03-04","Morning Cup","48\.00","HKD",/);
  expect(ledger.body.split('\r\n').filter((l) => l.startsWith('"L-')).length).toBe(1);

  const exceptions = await grab(page, 'Export exceptions CSV');
  expect(exceptions.name).toMatch(/^my-receipt-desk-exceptions-demo-\d{8}\.csv$/);
  expect(exceptions.body.charCodeAt(0)).toBe(0xfeff);
  expect(exceptions.body.slice(1).startsWith(EXCEPTIONS_HEADER)).toBe(true);
  // R-104's unclear amount stays an empty typed cell, never a guess.
  expect(exceptions.body).toContain('"R-104","receipt","2026-03-08","Green Basket","","","HKD"');

  const knowledge = await grab(page, 'Export knowledge JSON');
  const json = JSON.parse(knowledge.body);
  expect(json.rules[0].head.ruleId).toBe('K-ALIAS-0001');
  const md = await grab(page, 'Download KNOWLEDGE.md');
  expect(md.name).toBe('KNOWLEDGE.md');
  expect(md.body).toContain('Generated from your approved rules. Editing this file changes nothing in the app.');
  expect(md.body).toContain('K-ALIAS-0001');
  await page.keyboard.press('Escape');
  await expect(exportsButton).toBeFocused();
  con.assertClean();
});

test('E6 formula protection: untrusted card labels and a receipt merchant starting with = + @ are prefixed with \' in the CSVs; amounts and dates are not', async ({ page }) => {
  const con = watchConsole(page);
  await page.goto('/');
  const csv = [
    'Date,Posted,Details,Amount,Currency',
    '2026-04-02,2026-04-03,"=HYPERLINK(""http://example.invalid"",""x"")",-50.00,HKD',
    '2026-04-05,2026-04-06,@SUM(1+1),-20.00,HKD',
    '',
  ].join('\n');
  await importCsvFile(page, 'formula.csv', csv);

  // Record the "=HYPERLINK" row from the statement so it reaches the ledger.
  await page.getByRole('button', { name: /=HYPERLINK/ }).first().click();
  const d = drawer(page);
  await d.getByRole('button', { name: 'Record from statement (no receipt yet)' }).click();
  await expect(d).toContainText('Recorded as L-0001 from the card statement.');
  await page.keyboard.press('Escape');

  // A pending receipt whose merchant starts with "+".
  await page.getByRole('button', { name: 'Add receipts' }).click();
  const add = page.getByRole('dialog', { name: 'Add receipts' });
  await add.getByLabel(RECEIPT_INPUT).setInputFiles({ name: 'plus.png', mimeType: 'image/png', buffer: PNG_1X1 });
  await add.getByRole('button', { name: 'Open R-0001' }).click();
  await d.getByRole('button', { name: 'Edit fields' }).click();
  await d.getByLabel('Merchant').fill('+1 Lunch');
  await d.getByLabel('Date').fill('2026-04-09');
  await d.getByLabel('Amount').fill('77.00');
  await d.getByRole('button', { name: 'Save fields' }).click();
  await expect(d.getByRole('button', { name: 'Edit fields' })).toBeVisible();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Exports', exact: true }).click();
  const ledger = await grab(page, 'Export ledger CSV');
  expect(ledger.name).toMatch(/^my-receipt-desk-ledger-personal-\d{8}\.csv$/);
  // A statement-only entry takes the card transaction date (design §20 A-S5-3).
  expect(ledger.body).toContain('"L-0001","2026-04-02","\'=HYPERLINK(""http://example.invalid"",""x"")","50.00","HKD"');
  const exceptions = await grab(page, 'Export exceptions CSV');
  expect(exceptions.body).toContain('"R-0001","receipt","2026-04-09","\'+1 Lunch","","77.00","HKD"');
  expect(exceptions.body).toContain('"card_transaction","2026-04-06","\'@SUM(1+1)","debit","20.00","HKD"');
  // No unprefixed formula cell anywhere.
  for (const body of [ledger.body, exceptions.body]) expect(body).not.toMatch(/(^|,)"[=+@]/m);
  con.assertClean();
});
