import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { freshStart } from './helpers';

// Real Lichess games (CC0) captured into the importer fixtures; the shortest one keeps the engine run brief.
const pgnAll = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'importers', 'fixtures', 'lichess-clocked.pgn'), 'utf8');
const games = pgnAll
  .split(/\r?\n/)
  .filter((l) => !l.startsWith('%'))
  .join('\n')
  .split(/\n(?=\[Event )/)
  .filter((g) => g.includes('[Event'));
const shortest = [...games].sort((a, b) => a.length - b.length)[0]!;

test('paste a PGN, analyse it with the in-browser engine, and report detector coverage', async ({ page }) => {
  test.setTimeout(900_000);
  await freshStart(page);
  await page.getByTestId('nav-review').click();
  await page.getByTestId('review-pgn-input').fill(shortest);
  await page.getByTestId('review-import-pgn').click();
  const game = page.locator('[data-testid^="review-game-"]').first();
  await expect(game).toBeVisible();
  await game.click();
  await page.getByTestId('review-analyse').click();
  // When analysis has finished and been stored, the button offers re-analysis.
  await expect(page.getByTestId('review-analyse')).toContainText('Re-analyse', { timeout: 880_000 });
  await expect(page.getByTestId('review-coverage')).toContainText(/Detectors classified \d+ of \d+ mistakes/);
});

test('repertoire builder lists book openings and builds a line tree', async ({ page }) => {
  await freshStart(page);
  await page.getByTestId('nav-repertoire').click();
  await expect(page.getByTestId('repertoire')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('rep-summary')).toContainText(/\d+ positions to know as White/);
  await page.getByTestId('rep-color-b').click();
  await expect(page.getByTestId('rep-summary')).toContainText(/\d+ positions to know as Black/);
  const first = page.locator('[data-testid^="rep-option-"]').first();
  await first.click();
  await expect(page.getByTestId('rep-summary')).toContainText('built around');
  await expect(page.getByTestId('board')).toBeVisible();
});
