/** Assembles public/packs/openings/ from whatever stage outputs exist in .cache/openings/. */
import fs from 'node:fs';
import path from 'node:path';
import { writePack } from '../lib/pack';
import { OPENINGS_CACHE, readBookMeta, readBookShards } from './book';

const readJson = <T>(file: string): T | null => {
  const f = path.join(OPENINGS_CACHE, file);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : null;
};

export function assemblePack(): void {
  const shards: { file: string; key: string; count: number; data: unknown }[] = [];
  const names = readJson<unknown[]>('names.json');
  if (names) shards.push({ file: 'names.json', key: 'names', count: names.length, data: names });
  const book = readBookShards();
  if (book) for (const s of book) shards.push({ file: `book-${s.band}.json`, key: `book:${s.band}`, count: Object.keys(s.positions).length, data: s });
  const traps = readJson<unknown[]>('traps.json');
  if (traps) shards.push({ file: 'traps.json', key: 'traps', count: traps.length, data: traps });
  const cards = readJson<unknown[]>('cards.json');
  if (cards) shards.push({ file: 'cards.json', key: 'cards', count: cards.length, data: cards });
  if (shards.length === 0) {
    console.warn('[openings] nothing to assemble yet');
    return;
  }
  const bookMeta = readBookMeta();
  const namesMeta = readJson<Record<string, unknown>>('names-meta.json');
  const trapsMeta = readJson<Record<string, unknown>>('traps-meta.json');
  const cardsMeta = readJson<Record<string, unknown>>('cards-meta.json');
  writePack(
    'openings',
    'openings',
    {
      version: '1',
      license: 'CC0-1.0 (Lichess game database; lichess-org/chess-openings)',
      source: `lichess-org/chess-openings; ${bookMeta?.url ?? 'database.lichess.org'}; Stockfish evaluations`,
      meta: {
        month: bookMeta?.month ?? null,
        gamesStreamed: bookMeta?.gamesStreamed ?? 0,
        gamesAggregated: bookMeta?.gamesAggregated ?? 0,
        gamesAggregatedPerBand: bookMeta?.gamesAggregatedPerBand ?? {},
        positionsPerBand: bookMeta?.positionsPerBand ?? {},
        movesPerBand: bookMeta?.movesPerBand ?? {},
        bookComplete: bookMeta?.complete ?? false,
        bookPartialReason: bookMeta?.partialReason ?? null,
        bookFilters: bookMeta?.filters ?? null,
        bookSkipped: bookMeta?.skipped ?? {},
        pruning: {
          rule: 'per band: moves with fewer than minMoveGames games are dropped; minMoveGames = max(floor, smallest value keeping the shard JSON under shardByteBudget)',
          floor: bookMeta?.minMoveGamesFloor ?? null,
          shardByteBudget: bookMeta?.shardByteBudget ?? null,
          minMoveGamesPerBand: bookMeta?.minMoveGamesPerBand ?? {},
        },
        plies: bookMeta?.plies ?? 14,
        names: namesMeta ? { count: namesMeta.count, failed: namesMeta.failed } : null,
        traps: trapsMeta ? { candidates: trapsMeta.candidates, analysed: trapsMeta.analysed, confirmed: trapsMeta.confirmed, perBand: trapsMeta.confirmedPerBand, rules: trapsMeta.rules } : null,
        cards: cardsMeta ? { count: cardsMeta.cards, families: cardsMeta.families, skipped: cardsMeta.skipped, rules: cardsMeta.rules } : null,
      },
    },
    shards,
  );
}
