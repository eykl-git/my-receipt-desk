/**
 * E5 rule suspension (design §15 E5, §7.5, T16 in the browser): the read-only
 * "Preview impact" on the active card, suspension with a reason, dependent
 * pending cases leaving "Ready to record", recorded entries kept with
 * "(now suspended)", and "View history" listing v1.
 */
import { expect, test, type Page } from '@playwright/test';
import { caseCard, expectCounts, expectNoSeriousAxe, group, teach, watchConsole } from './helpers';

const card = (page: Page) => page.getByTestId('rule-K-ALIAS-0001');

test('E5 suspend K-ALIAS-0001: preview what depends on it, suspend with a reason, R-201/R-202 leave "Ready to record", R-103 keeps its entry, history lists v1', async ({ page }) => {
  const con = watchConsole(page);
  await teach(page);
  await page.getByRole('region', { name: 'Guided demo' }).getByRole('button', { name: 'Next batch' }).click();
  await expect(page.getByTestId('tour-step')).toHaveText('Step 3 of 4');
  await caseCard(page, 'R-103').getByRole('button', { name: 'Record R-103' }).click();
  await expect(group(page, 'recorded')).toContainText('R-103');
  for (const id of ['R-201', 'R-202']) await expect(group(page, 'ready').getByTestId(`case-${id}`)).toBeVisible();
  await expectCounts(page, { active: '1', paid: 'HKD 110.00' });

  const preview = card(page).getByRole('button', { name: 'Preview impact' });
  await preview.click();
  const pd = page.getByRole('dialog', { name: 'What depends on this rule now' });
  await expect(pd).toContainText('Read-only preview. Nothing is changed.');
  await expect(pd).toContainText('R-201');
  await expect(pd).toContainText('R-202');
  await expect(pd).toContainText('Recorded using this rule — not changed');
  await expectNoSeriousAxe(page, 'suspension preview');
  await page.keyboard.press('Escape');
  await expect(preview).toBeFocused();

  await card(page).getByRole('button', { name: 'Suspend' }).click();
  const sd = page.getByRole('dialog', { name: 'Suspend K-ALIAS-0001 v1' });
  await expect(sd.getByRole('button', { name: 'Suspend rule' })).toBeDisabled();
  await sd.getByLabel('Why are you suspending this rule?').fill('Card label under review');
  await expectNoSeriousAxe(page, 'suspend dialog');
  await sd.getByRole('button', { name: 'Suspend rule' }).click();
  await expect(sd).toBeHidden();
  await expect(card(page)).toContainText('Suspended');

  for (const id of ['R-201', 'R-202']) {
    await expect(group(page, 'ready').getByTestId(`case-${id}`)).toHaveCount(0);
    await expect(group(page, 'needs_decision').getByTestId(`case-${id}`)).toContainText('Card label “MC COFFEE HK” is not a known name for Morning Cup.');
  }
  await expect(caseCard(page, 'R-103')).toContainText('Recorded using K-ALIAS-0001 v1 (now suspended)');
  await expect(group(page, 'recorded').getByTestId('case-R-103')).toBeVisible();
  await expectCounts(page, { active: '0', paid: 'HKD 110.00', 'rules-used': '1' });

  await card(page).getByRole('button', { name: 'View history' }).click();
  const hd = page.getByRole('dialog', { name: 'History of K-ALIAS-0001' });
  await expect(hd.getByRole('row', { name: /^v1 / })).toContainText('Suspended');
  await expect(hd).toContainText('Card label under review');
  await expectNoSeriousAxe(page, 'history dialog');
  await page.keyboard.press('Escape');
  await expect(card(page).getByRole('button', { name: 'View history' })).toBeFocused();

  // Survives a reload: still suspended, the entry is still recorded.
  await page.reload();
  await expect(card(page)).toContainText('Suspended');
  await expect(caseCard(page, 'R-103')).toContainText('(now suspended)');
  await expectCounts(page, { active: '0', paid: 'HKD 110.00' });
  con.assertClean();
});
