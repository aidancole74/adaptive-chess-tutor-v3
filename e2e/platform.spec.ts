import { expect, test } from '@playwright/test';
import { freshStart } from './helpers';

test.describe('mobile', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  test('training works at phone width without horizontal scrolling', async ({ page }) => {
    await freshStart(page);
    await page.getByTestId('nav-train').click();
    await page.getByTestId('start-session').click();
    await expect(page.getByTestId('exercise')).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test('boards and controls carry accessible names', async ({ page }) => {
  await page.goto('./');
  await page.getByTestId('start-placement').click();
  const board = page.getByTestId('board').first();
  // The board describes every piece and the side to move for screen readers.
  await expect(board).toHaveAttribute('aria-label', /White: .*king [a-h][1-8].*Black: .*to move\./);
  await expect(page.getByLabel('Type a move')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeAttached();
});

test('the app shell works offline after the first visit', async ({ page, context }) => {
  await page.goto('./');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await context.setOffline(false);
});
