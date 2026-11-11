import { expect, test } from '@playwright/test';
import { answerCurrent } from './helpers';

test('the 15-puzzle placement test produces a rating with a range and seeds the model', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('./');
  await page.getByTestId('start-placement').click();
  for (let i = 1; i <= 15; i++) {
    await expect(page.getByRole('heading', { level: 1 })).toContainText(`puzzle ${i} of 15`);
    await answerCurrent(page);
    await page.getByTestId('next').click();
  }
  await expect(page.getByTestId('placement-result')).toBeVisible();
  const rating = Number(await page.getByTestId('placement-rating').textContent());
  // Giving up on every puzzle must drive the estimate well below the 1200 start.
  expect(rating).toBeLessThan(1000);
  await page.getByTestId('placement-continue').click();
  await expect(page.getByTestId('overall-rating')).toContainText('15 exercises');
});

test('export and import round-trip the learner data', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('skip-onboarding').click();
  await page.getByTestId('nav-data').click();
  const download = page.waitForEvent('download');
  await page.getByTestId('export').click();
  const file = await download;
  const path = await file.path();
  expect(path).toBeTruthy();
  await page.getByTestId('import-file').setInputFiles(path!);
  await expect(page.getByTestId('data-msg')).toContainText('Imported');
});

test('the curriculum map explains locks and the basic-blunder gate', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('skip-onboarding').click();
  await page.getByTestId('nav-curriculum').click();
  await expect(page.getByTestId('gate')).toContainText('needs at least 8 basic exercises');
  await expect(page.getByTestId('concept-tactics/double-attack/fork')).toContainText('Needs Hanging piece');
});
