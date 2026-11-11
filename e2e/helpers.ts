import { expect, type Page } from '@playwright/test';

/** Start from a clean profile and skip onboarding at the default level. */
export async function freshStart(page: Page): Promise<void> {
  await page.goto('./');
  await expect(page.getByTestId('onboarding')).toBeVisible();
  await page.getByTestId('skip-onboarding').click();
  await expect(page.getByTestId('dashboard')).toBeVisible();
}

/**
 * Complete whatever exercise is on screen with a "reasonable attempt": pick confidence, then for
 * line exercises play the first suggested hint move via the typed-move box when possible, otherwise
 * give up; for choices click the first option; for sets submit; for cards continue.
 * Returns the format that was handled.
 */
export async function answerCurrent(page: Page): Promise<string> {
  const ex = page.getByTestId('exercise');
  await expect(ex).toBeVisible();
  const format = (await ex.getAttribute('data-format')) ?? '';
  const conf = page.getByTestId('confidence-3');
  if (await conf.isVisible().catch(() => false)) await conf.click();
  if (await page.getByTestId('card-continue').isVisible().catch(() => false)) {
    await page.getByTestId('card-continue').click();
  } else if (await page.getByTestId('give-up').isVisible().catch(() => false)) {
    await page.getByTestId('give-up').click();
  } else if (await page.getByTestId('submit-set').isVisible().catch(() => false)) {
    await page.getByTestId('submit-set').click();
  } else if (await page.getByTestId('submit-choice').isVisible().catch(() => false)) {
    await page.locator('[data-testid^="option-"]').first().click();
    await page.getByTestId('submit-choice').click();
  } else if ((await page.locator('[data-testid^="option-"]').count()) > 0) {
    await page.locator('[data-testid^="option-"]').first().click();
  } else {
    // square or path drills: click squares until the drill finishes
    for (let i = 0; i < 10 && !(await page.getByTestId('next').isVisible().catch(() => false)); i++) {
      await page.locator('[data-square]').nth(i * 7).click({ force: true }).catch(() => undefined);
    }
  }
  return format;
}
