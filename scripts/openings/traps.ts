/**
 * Traps stage: popular-but-bad book moves, confirmed by Stockfish.
 *
 * Candidate (per band): in a book position, a move played in >= 5% of the position's games and >= 150 games
 * whose score for the mover is >= 12 percentage points below the best-scoring popular alternative (same
 * popularity rule). Confirmation (Stockfish lite, depth 16): the engine's best move in the position vs the
 * mistake (searchmoves); kept only when the drop is >= 150 cp. The refutation is the engine PV after the mistake.
 * Safe moves: popular book moves (>= 5%, >= 150 games) and the engine's first choice whose evaluation is within
 * 60 cp of the engine best and that are not themselves the mistake. Engine results are cached per FEN in
 * .cache/openings/engine-cache.json so the stage can be resumed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BOOK_BANDS, type BookBand } from '../../src/content/types';
import { OpeningNames, scorePct, type OpeningTrap, type TrapSafeMove } from '../../src/content/openings';
import { epdOf, playLine, sideToMove } from '../../src/engine/chessUtil';
import { NodeStockfish, cpOf, type SfLine } from '../lib/pack';
import { OPENINGS_CACHE, readBookShards } from './book';
import { bookLines, fnv, positionGames } from './lines';
import type { OpeningNameTuple } from '../../src/content/types';

export const TRAP_RULES = {
  minFreq: 0.05,
  minGames: 150,
  minScoreGapPct: 12,
  minDropCp: 150,
  depth: 16,
  safeMarginCp: 60,
  maxCandidates: 1500,
} as const;

export interface TrapsMeta {
  candidates: number;
  candidatesPerBand: Record<string, number>;
  analysed: number;
  confirmed: number;
  confirmedPerBand: Record<string, number>;
  uniquePositions: number;
  rules: typeof TRAP_RULES;
}

interface EngineEntry {
  lines: { uci: string; cp: number; pv: string[]; depth: number }[];
}

const CLAMP = 10000;
const clampCp = (x: number): number => Math.max(-CLAMP, Math.min(CLAMP, x));

export async function runTrapsStage(): Promise<TrapsMeta> {
  const shards = readBookShards();
  if (!shards) throw new Error('traps: run the book stage first');
  const namesFile = path.join(OPENINGS_CACHE, 'names.json');
  const names = new OpeningNames(fs.existsSync(namesFile) ? (JSON.parse(fs.readFileSync(namesFile, 'utf8')) as OpeningNameTuple[]) : []);
  const cacheFile = path.join(OPENINGS_CACHE, 'engine-cache.json');
  const cache: Record<string, EngineEntry> = fs.existsSync(cacheFile) ? (JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Record<string, EngineEntry>) : {};
  const saveCache = (): void => fs.writeFileSync(cacheFile, JSON.stringify(cache));

  interface Cand {
    band: BookBand;
    epd: string;
    fen: string;
    line: string[];
    mistake: string;
    games: number;
    freq: number;
    score: number;
    bestAlt: string;
    bestAltScore: number;
    popular: string[];
    posGames: number;
  }
  const cands: Cand[] = [];
  const candidatesPerBand: Record<string, number> = {};
  for (const shard of shards) {
    const lines = bookLines(shard.positions);
    let n = 0;
    for (const epd in shard.positions) {
      const moves = shard.positions[epd];
      const pl = lines.get(epd);
      if (!moves || !pl) continue;
      const total = positionGames(moves);
      const side = sideToMove(pl.fen);
      const popular = Object.entries(moves).filter(([, s]) => s[0] >= TRAP_RULES.minGames && s[0] / total >= TRAP_RULES.minFreq);
      if (popular.length < 2) continue;
      for (const [uci, st] of popular) {
        const sc = scorePct(st, side);
        let best: [string, number] | null = null;
        for (const [u2, s2] of popular) {
          if (u2 === uci) continue;
          const sc2 = scorePct(s2, side);
          if (!best || sc2 > best[1]) best = [u2, sc2];
        }
        if (!best || best[1] - sc < TRAP_RULES.minScoreGapPct) continue;
        cands.push({ band: shard.band, epd, fen: pl.fen, line: pl.line, mistake: uci, games: st[0], freq: st[0] / total, score: sc, bestAlt: best[0], bestAltScore: best[1], popular: popular.map(([u]) => u), posGames: total });
        n++;
      }
    }
    candidatesPerBand[shard.band] = n;
  }
  cands.sort((a, b) => b.games - a.games);
  const todo = cands.slice(0, TRAP_RULES.maxCandidates);
  console.log(`[traps] ${cands.length} candidates (${JSON.stringify(candidatesPerBand)}); analysing ${todo.length}`);

  const sf = new NodeStockfish();
  await sf.init({ Hash: 128 });
  const toEntry = (ls: SfLine[]): EngineEntry => ({ lines: ls.filter((l) => l.pv.length > 0).map((l) => ({ uci: l.pv[0] as string, cp: clampCp(cpOf(l)), pv: l.pv, depth: l.depth })) });
  const analyse = async (fen: string, key: string, opts: { multipv?: number; searchmoves?: string[] }): Promise<EngineEntry> => {
    const hit = cache[key];
    if (hit) return hit;
    const e = toEntry(await sf.analyse(fen, { depth: TRAP_RULES.depth, ...opts }));
    cache[key] = e;
    return e;
  };

  const traps: OpeningTrap[] = [];
  const confirmedPerBand: Record<string, number> = Object.fromEntries(BOOK_BANDS.map((b) => [b, 0]));
  const t0 = Date.now();
  let analysed = 0;
  for (const c of todo) {
    analysed++;
    // Best move plus evaluations of each popular move (searchmoves keeps the cost to one search per move).
    const top = await analyse(c.fen, `top:${c.fen}`, { multipv: 1 });
    const best = top.lines[0];
    if (!best) continue;
    const evalOf = async (uci: string): Promise<number | null> => {
      if (uci === best.uci) return best.cp;
      const e = await analyse(c.fen, `mv:${c.fen}:${uci}`, { searchmoves: [uci] });
      return e.lines[0]?.cp ?? null;
    };
    const mistakeCp = await evalOf(c.mistake);
    if (mistakeCp === null || best.cp - mistakeCp < TRAP_RULES.minDropCp) continue;
    const after = playLine(c.fen, [c.mistake]);
    if (!after) continue;
    const afterFen = after.chess.fen();
    const refute = await analyse(afterFen, `top:${afterFen}`, { multipv: 1 });
    const ref = refute.lines[0];
    if (!ref || ref.pv.length === 0) continue;
    const refSan = playLine(afterFen, ref.pv)?.sans ?? [];
    if (refSan.length === 0) continue;
    const safe: TrapSafeMove[] = [];
    const side = sideToMove(c.fen);
    const shard = shards.find((s) => s.band === c.band);
    const moves = shard?.positions[c.epd] ?? {};
    for (const uci of new Set([best.uci, ...c.popular])) {
      if (uci === c.mistake) continue;
      const cp = await evalOf(uci);
      if (cp === null || best.cp - cp > TRAP_RULES.safeMarginCp) continue;
      const san = playLine(c.fen, [uci])?.sans[0];
      if (!san) continue;
      const st = moves[uci];
      safe.push({ uci, san, cp, games: st?.[0] ?? 0, scorePct: st ? Math.round(scorePct(st, side) * 10) / 10 : 0 });
    }
    const named = names.nameForLine([...c.line, c.mistake]) ?? names.nameForLine(c.line);
    traps.push({
      id: `trap-${c.band}-${fnv(c.epd + c.mistake)}`,
      epd: c.epd,
      fen: c.fen,
      line: c.line,
      mistake: c.mistake,
      mistakeFreq: Math.round(c.freq * 1000) / 1000,
      band: c.band,
      refutation: ref.pv,
      evalBeforeCp: -best.cp,
      evalAfterCp: ref.cp,
      depth: Math.min(best.depth, ref.depth),
      openingName: named?.name ?? '',
      verified: true,
      mistakeSan: after.sans[0] as string,
      mistakeGames: c.games,
      mistakeScorePct: Math.round(c.score * 10) / 10,
      bestAltUci: c.bestAlt,
      bestAltScorePct: Math.round(c.bestAltScore * 10) / 10,
      refutationSan: refSan,
      safeMoves: safe.sort((a, b) => b.cp - a.cp),
    });
    confirmedPerBand[c.band] = (confirmedPerBand[c.band] ?? 0) + 1;
    if (analysed % 20 === 0) {
      saveCache();
      console.log(`[traps] ${analysed}/${todo.length} analysed, ${traps.length} confirmed, ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  }
  saveCache();
  sf.quit();
  traps.sort((a, b) => (a.band < b.band ? -1 : a.band > b.band ? 1 : b.mistakeGames - a.mistakeGames));
  const meta: TrapsMeta = {
    candidates: cands.length,
    candidatesPerBand,
    analysed,
    confirmed: traps.length,
    confirmedPerBand,
    uniquePositions: new Set(traps.map((t) => epdOf(t.fen))).size,
    rules: TRAP_RULES,
  };
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'traps.json'), JSON.stringify(traps));
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'traps-meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[traps] ${traps.length} confirmed of ${analysed} analysed (${cands.length} candidates)`);
  return meta;
}
