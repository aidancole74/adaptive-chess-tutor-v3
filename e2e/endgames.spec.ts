import { expect, test } from '@playwright/test';
import { freshStart } from './helpers';

test('endgame library serves tablebase-verified positions and grades a wrong move', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('nav-endgames').click();
  await expect(page.getByTestId('endgame-library')).toBeVisible();
  await page.getByTestId('eg-concept-lucena').click();
  await page.getByTestId('eg-best').click();
  await expect(page.getByTestId('exercise')).toHaveAttribute('data-format', 'eg-best-move');
  await page.getByTestId('confidence-3').click();
  await page.getByTestId('give-up').click();
  await expect(page.getByTestId('explanation')).toContainText('Tablebase:');
});

test('strategy content appears in sessions once the bank is loaded', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('nav-curriculum').click();
  // Quiet-move concepts must have content now (no "no content loaded yet" note after a session has loaded packs).
  await page.getByTestId('nav-train').click();
  await page.getByTestId('start-session').click();
  await expect(page.getByTestId('exercise')).toBeVisible();
  await page.getByTestId('nav-curriculum').click();
  await expect(page.getByTestId('concept-strategy/planning/quiet-move')).not.toContainText('no content loaded yet');
});
