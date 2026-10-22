/**
 * S2 smoke (brief §23): tour steps 1–3 on the teach path and the apply-once
 * path with real clicks, including the M2 behaviour (summary in the drawer,
 * then the "New" badge and "Newly ready — K-ALIAS-0001 v1" after Close).
 */
import { expect, test } from '@playwright/test';
import { caseCard, confirmR102, drawer, expectStep, group, startDemo, STEP2_CONFIRMED, STEP2_TAUGHT, STEP3_ONCE, STEP3_TEACH, watchConsole } from './helpers';

test('S2 teach path: confirm R-102 once, propose, preview, activate, close, reuse in Batch 2', async ({ page }) => {
  const con = watchConsole(page);
  await startDemo(page);
  // exact: the Knowledge Space also has the heading "Knowledge gaps found in your data" (S3).
  await expect(page.getByRole('heading', { name: 'Your data', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Knowledge Space', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Decisions and outcomes', exact: true })).toBeVisible();
  await expect(page.getByText('The rules and preferences you have approved.')).toBeVisible();
  await expect(page.getByText('Approved rules that help handle the next receipt.')).toBeVisible();
  await expect(page.getByText('Your approved rules are reused. The AI model is not being retrained.')).toBeVisible();
  await expect(page.getByText('No approved rules yet. The desk starts with built-in safety checks only.')).toBeVisible();
  await expect(page.getByText('Card posting date: 0–3 days after the receipt (demo policy)')).toBeVisible();
  await expect(page.getByTestId('m-unique')).toContainText('5');

  await confirmR102(page);
  await expectStep(page, 2, STEP2_CONFIRMED);
  const d = drawer(page);
  await d.getByRole('button', { name: 'Propose reusable knowledge' }).click();
  await expect(d.getByRole('heading', { name: 'Rule draft—review required' })).toBeVisible();
  for (const section of ['Meaning', 'Rule data (JSON)', 'Scope', 'Does not apply to', 'Evidence', 'Checks', 'Pending cases affected']) {
    await expect(d.getByRole('heading', { name: section })).toBeVisible();
  }
  await expect(d.getByText('Owner: You (local owner)')).toBeVisible();
  await expect(d.getByText('On card Demo Card ••1234, the statement label “MC COFFEE HK” means the merchant Morning Cup.', { exact: false })).toBeVisible();
  await expect(d.getByRole('button', { name: 'Activate rule' })).toBeDisabled();
  await expect(d.getByTestId('activate-reason')).toHaveText('Preview the impact first');

  await d.getByRole('button', { name: 'Preview impact' }).click();
  await expect(d.getByTestId('draft-pending')).toContainText('R-103');
  await expect(d.getByTestId('draft-pending')).toContainText('Matches S-103. Matched name using K-ALIAS-0001 v1.');
  await expect(d.getByText('Saved as K-ALIAS-0001 v1 (draft).', { exact: false })).toBeVisible();
  await d.getByRole('button', { name: 'Activate rule' }).click();

  // M2: the summary shows inside the drawer; badges wait for Close.
  const summary = d.getByTestId('activation-summary');
  await expect(summary).toContainText('What changed');
  await expect(summary).toContainText('R-103: Needs your decision → Ready to record.');
  await expect(summary).toContainText('What did not change');
  await expect(summary).toContainText('Recorded entries were not changed.');
  await expect(summary).toContainText('Categories were not changed.');
  await expect(page.getByTestId('live-region')).toContainText('K-ALIAS-0001 v1 is active.');
  await expect(page.getByTestId('newly-ready')).toHaveCount(0);
  await d.getByRole('contentinfo').getByRole('button', { name: 'Close' }).click();
  await expect(d).toBeHidden();

  const card = page.getByTestId('rule-K-ALIAS-0001');
  await expect(card.getByText('New', { exact: true })).toBeVisible();
  await expect(card).toContainText('Used in 0 recorded decisions');
  await expect(card).toContainText('Card: Demo Card ••1234');
  await expect(caseCard(page, 'R-103').getByTestId('newly-ready')).toHaveText('Newly ready — K-ALIAS-0001 v1');
  await expect(group(page, 'ready')).toContainText('R-103');
  await expect(group(page, 'needs_decision')).toContainText('R-104');
  await expect(group(page, 'needs_decision')).toContainText('R-105');
  await expect(group(page, 'recorded')).toContainText('R-102');
  await expectStep(page, 2, STEP2_TAUGHT);
  await expect(page.getByRole('button', { name: 'Next batch' })).toHaveClass(/btn-primary/);
  await expect(card.getByText('New', { exact: true })).toBeHidden({ timeout: 6000 });

  await page.getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 3, STEP3_TEACH);
  await expect(page.getByRole('status')).toContainText('Already added as R-102 (identical file). Nothing was added.');
  for (const id of ['R-201', 'R-202']) {
    await expect(group(page, 'ready').getByTestId(`case-${id}`)).toContainText('Matched name using K-ALIAS-0001 v1.');
    await expect(caseCard(page, id).getByText('K-ALIAS-0001 v1', { exact: true })).toBeVisible();
  }
  await expect(group(page, 'ready')).toContainText('R-203');
  await expect(page.getByTestId('case-R-204')).toHaveCount(0);
  await expect(page.getByTestId('m-unique')).toContainText('8');
  await expect(page.getByTestId('m-newly')).toContainText('3');
  con.assertClean();
});

test('S2 apply-once path: confirming R-102 once teaches nothing; Batch 2 Morning Cup receipts still need a decision', async ({ page }) => {
  const con = watchConsole(page);
  await startDemo(page);
  await confirmR102(page);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Review R-102' })).toBeVisible();
  await expectStep(page, 2, STEP2_CONFIRMED);
  await expect(page.getByText('No approved rules yet. The desk starts with built-in safety checks only.')).toBeVisible();
  await page.getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 3, STEP3_ONCE);
  for (const id of ['R-103', 'R-201', 'R-202']) {
    await expect(group(page, 'needs_decision').getByTestId(`case-${id}`)).toContainText('Card label “MC COFFEE HK” is not a known name for Morning Cup.');
  }
  await expect(page.getByTestId('newly-ready')).toHaveCount(0);
  await expect(page.getByTestId('m-active')).toContainText('0');
  con.assertClean();
});
