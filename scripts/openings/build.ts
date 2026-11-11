/**
 * `npm run data:openings` — opening names, rating-banded book, traps and structure cards.
 *
 *   --stage names|book|traps|cards|pack|all   (default all)
 *   --games 2000000                           games to stream from the dump (book stage)
 *   --month YYYY-MM                           dump month (default: newest in database.lichess.org/standard/list.txt)
 *
 * Every stage writes its result to .cache/openings/ and the pack in public/packs/openings/ is (re)assembled from
 * whatever stages are available, so stages can be re-run independently.
 */
import { arg } from '../lib/pack';

const stage = arg('stage', 'all') ?? 'all';
const games = Number(arg('games', '2000000'));
const month = arg('month');
const want = (s: string): boolean => stage === 'all' || stage === s;

if (want('names')) {
  const { runNamesStage } = await import('./names');
  await runNamesStage();
}
if (want('book')) {
  const { runBookStage } = await import('./book');
  await runBookStage({ games, month });
}
if (want('traps')) {
  const { runTrapsStage } = await import('./traps');
  await runTrapsStage();
}
if (want('cards')) {
  const { runCardsStage } = await import('./cards');
  await runCardsStage();
}
const { assemblePack } = await import('./assemble');
assemblePack();
process.exit(0);
