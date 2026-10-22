/**
 * E2 apply once vs teach (design §15 E2, §8 apply-once column, §9.1 Variant B).
 * R-102 is confirmed for this case only; no rule is proposed. The next batches
 * still need decisions, and the comparison has nothing to compare.
 */
import { expect, test, type Page } from '@playwright/test';
import { confirmR102, drawer, expectCounts, expectGroupSizes, expectNoSeriousAxe, expectStep, group, startDemo, STEP2_CONFIRMED, STEP3_ONCE, watchConsole } from './helpers';

const STEP4_ONCE = "Batch 3: The boundary still holds. Two equal payments still come back to you, USD is not converted, and receipt text can't change your rules.";
const tourBar = (page: Page) => page.getByRole('region', { name: 'Guided demo' });

test('E2 apply once: R-102 confirmed for this case only teaches nothing; §8 apply-once counters at steps 2–4 and after "Record all ready"', async ({ page }) => {
  const con = watchConsole(page);
  await startDemo(page);
  await confirmR102(page);
  await page.keyboard.press('Escape');
  await expect(drawer(page)).toBeHidden();
  await expectStep(page, 2, STEP2_CONFIRMED);
  await expect(page.getByText('No approved rules yet. The desk starts with built-in safety checks only.')).toBeVisible();
  await expectGroupSizes(page, { ready: 1, needs: 3, recorded: 1 });
  await expectCounts(page, { unique: '5', needs: '3', confirmed: '1', linked: '1', active: '0', newly: '0', 'rules-used': '0', safe: '1 of 5 receipts', paid: 'HKD 48.00', spending: 'HKD 322.00', cardrows: '0', unpaid: 'HKD 0.00' });
  await expect(tourBar(page).getByRole('button', { name: 'Compare without this rule' })).toBeDisabled();
  await expect(tourBar(page).getByText('No approved rule to compare yet.')).toBeVisible();

  await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 3, STEP3_ONCE);
  for (const id of ['R-103', 'R-201', 'R-202']) {
    await expect(group(page, 'needs_decision').getByTestId(`case-${id}`)).toContainText('Card label “MC COFFEE HK” is not a known name for Morning Cup.');
  }
  await expect(page.getByTestId('newly-ready')).toHaveCount(0);
  await expectGroupSizes(page, { ready: 2, needs: 5, recorded: 1 });
  await expectCounts(page, { unique: '8', needs: '5', confirmed: '1', linked: '1', active: '0', newly: '0', safe: '2 of 8 receipts', paid: 'HKD 48.00', spending: 'HKD 543.00', cardrows: '0' });

  await tourBar(page).getByRole('button', { name: 'Next batch' }).click();
  await expectStep(page, 4, STEP4_ONCE);
  await expectGroupSizes(page, { ready: 3, needs: 7, recorded: 1 });
  await expectCounts(page, { unique: '11', needs: '7', confirmed: '1', linked: '1', active: '0', newly: '0', safe: '3 of 11 receipts', paid: 'HKD 48.00', spending: 'HKD 669.00', cardrows: '1' });
  await expect(tourBar(page).getByRole('button', { name: 'Compare without this rule' })).toBeDisabled();
  await expect(tourBar(page).getByText('No approved rule to compare yet.')).toBeVisible();
  await expectNoSeriousAxe(page, 'apply-once step 4');

  await group(page, 'ready').getByRole('button', { name: 'Record all ready' }).click();
  await expect(page.getByTestId('live-region')).toHaveText('Recorded 3 entries.');
  await expectGroupSizes(page, { ready: 0, needs: 7, recorded: 4 });
  await expectCounts(page, { unique: '11', needs: '7', confirmed: '4', linked: '4', active: '0', newly: '0', 'rules-used': '0', safe: '3 of 11 receipts', paid: 'HKD 299.00', spending: 'HKD 418.00', cardrows: '1', unpaid: 'HKD 0.00' });
  con.assertClean();
});
