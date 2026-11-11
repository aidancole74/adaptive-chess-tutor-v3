/**
 * Cards stage: structure/plan cards from computed facts.
 *
 * For each opening family (name before the colon in chess-openings) take the book positions at ply 12 and 13
 * (the deepest plies that still have recorded continuations; ply 14 positions have none because only 14 plies are
 * aggregated), ranked by games summed over all bands. A family qualifies with >= CARD_RULES.minFamilyGames games
 * over those positions; up to CARD_RULES.perFamily positions with >= CARD_RULES.minPositionGames games each become
 * cards. Each card carries extractFeatures/featureFlags output (heuristic), open files, and the top book
 * continuations per band. No prose theory.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_BANDS, type BookBand, type OpeningNameTuple } from '../../src/content/types';
import { OpeningNames, scorePct, type CardContinuation, type CardFlag, type StructureCard } from '../../src/content/openings';
import { playLine, sideToMove } from '../../src/engine/chessUtil';
import { OPENINGS_CACHE, readBookShards } from './book';
import { bookLines, fnv, mergeShards, positionGames } from './lines';

export const CARD_RULES = { plies: [12, 13], minFamilyGames: 300, minPositionGames: 80, perFamily: 3, continuationsPerBand: 3 } as const;

export interface CardsMeta {
  cards: number;
  families: number;
  skipped: string | null;
  rules: typeof CARD_RULES;
}

export async function runCardsStage(): Promise<CardsMeta> {
  const shards = readBookShards();
  if (!shards) throw new Error('cards: run the book stage first');
  const namesFile = path.join(OPENINGS_CACHE, 'names.json');
  if (!fs.existsSync(namesFile)) throw new Error('cards: run the names stage first');
  const names = new OpeningNames(JSON.parse(fs.readFileSync(namesFile, 'utf8')) as OpeningNameTuple[]);
  let features: typeof import('../../src/engine/features');
  try {
    features = await import('../../src/engine/features');
  } catch (e) {
    const meta: CardsMeta = { cards: 0, families: 0, skipped: `features unavailable: ${(e as Error).message}`, rules: CARD_RULES };
    fs.writeFileSync(path.join(OPENINGS_CACHE, 'cards-meta.json'), JSON.stringify(meta, null, 1));
    console.warn(`[cards] skipped: ${meta.skipped}`);
    return meta;
  }
  const merged = mergeShards(shards);
  const lines = bookLines(merged);
  const byFamily = new Map<string, { epd: string; fen: string; line: string[]; games: number; name: string }[]>();
  for (const [epd, pl] of lines) {
    if (!(CARD_RULES.plies as readonly number[]).includes(pl.line.length)) continue;
    const games = positionGames(merged[epd]);
    if (games < CARD_RULES.minPositionGames) continue;
    const named = names.nameForLine(pl.line);
    if (!named) continue;
    const list = byFamily.get(named.family) ?? [];
    list.push({ epd, fen: pl.fen, line: pl.line, games, name: named.name });
    byFamily.set(named.family, list);
  }
  const cards: StructureCard[] = [];
  let families = 0;
  for (const [family, list] of [...byFamily.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const total = list.reduce((a, p) => a + p.games, 0);
    if (total < CARD_RULES.minFamilyGames) continue;
    families++;
    list.sort((a, b) => b.games - a.games);
    for (const p of list.slice(0, CARD_RULES.perFamily)) {
      const f = features.extractFeatures(p.fen);
      const flags: { w: CardFlag[]; b: CardFlag[] } = { w: [], b: [] };
      for (const fl of features.featureFlags(f)) flags[fl.side].push({ name: fl.name, detail: fl.detail });
      const side = sideToMove(p.fen);
      const bookContinuations: Partial<Record<BookBand, CardContinuation[]>> = {};
      for (const band of BOOK_BANDS) {
        const moves = shards.find((s) => s.band === band)?.positions[p.epd];
        if (!moves) continue;
        const top: CardContinuation[] = [];
        for (const [uci, st] of Object.entries(moves).sort((a, b) => b[1][0] - a[1][0]).slice(0, CARD_RULES.continuationsPerBand)) {
          const san = playLine(p.fen, [uci])?.sans[0];
          if (san) top.push({ uci, san, games: st[0], scorePct: Math.round(scorePct(st, side) * 10) / 10 });
        }
        if (top.length) bookContinuations[band] = top;
      }
      cards.push({
        id: `card-${fnv(p.epd)}`,
        family,
        name: p.name,
        eco: names.ecoRange(family),
        fen: p.fen,
        epd: p.epd,
        line: p.line,
        ply: p.line.length,
        games: p.games,
        structure: f.structure,
        flags,
        openFiles: f.openFiles,
        bookContinuations,
      });
    }
  }
  const meta: CardsMeta = { cards: cards.length, families, skipped: null, rules: CARD_RULES };
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'cards.json'), JSON.stringify(cards));
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'cards-meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[cards] ${cards.length} cards over ${families} families`);
  return meta;
}
