import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeTactic } from '../content/tactics';
import type { TacticItem, TacticTuple } from '../content/types';
import { TIER_MID, primaryTacticConcept } from '../curriculum/concepts';
import { epdOf } from '../engine/chessUtil';
import { parsePgn } from '../importers/pgn';
import { analyseGame } from './analyze';
import { diagnose, motifsOnBestLine, sampleOpportunities, seedFromGames } from './diagnose';
import { buildSpotMistake, pairSimilar, spotMistakeDifficulty } from './exercises';
import { scriptedEngine } from './testUtil';

// Real Lichess game vuOeeysw (CC0); 38. Ne6?? drops the knight to 38... Qxe6.
const ROOT = path.join(import.meta.dirname, '..', '..');
const game = parsePgn(fs.readFileSync(path.join(ROOT, 'src', 'importers', 'fixtures', 'lichess-clocked.pgn'), 'utf8'), { username: 'KavithaN20' }).games[1]!;
const before = game.moves[74]!.fenBefore;
const after = game.moves[75]!.fenBefore;

async function analysed() {
  // Scripted engine: best b3c3 (+0) with a second line within 50 cp; after Ne6 the queen takes on e6.
  const engine = scriptedEngine({
    [before]: [{ cp: 0, pv: ['b3c3'] }, { cp: -30, pv: ['b3c2'] }, { cp: -200, pv: ['b3b1'] }],
    [after]: { cp: 500, pv: ['a6e6'] },
  });
  return analyseGame(game, engine);
}

describe('buildSpotMistake', () => {
  it('builds a line exercise from the position before the classified mistake', async () => {
    const a = await analysed();
    const m = a.mistakes.find((x) => x.ply === 75)!;
    const ex = buildSpotMistake(game, m)!;
    expect(ex).toMatchObject({
      id: 'spot:lichess:vuOeeysw:75',
      format: 'spot-mistake',
      domain: 'tactics',
      conceptId: 'tactics/basics/hangingPiece',
      difficultySource: 'tier-prior',
      color: 'w',
      verified: true,
      prompt: 'You played 38. Ne6 here. Find the better move.',
    });
    expect(ex.interaction).toMatchObject({ kind: 'line', fen: before, orientation: 'white', preMoves: [], solution: ['b3c3'], alternatives: { 0: ['b3c2'] } });
    expect(ex.sim.sourceGame).toBe(game.id);
    const engineFacts = ex.facts.filter((f) => f.t === 'engine');
    expect(engineFacts).toHaveLength(2);
    expect(engineFacts[1]).toMatchObject({ pvSan: ['Qxe6'], cp: 500 });
    expect(ex.facts.some((f) => f.t === 'motif' && f.name.startsWith('Hanging piece'))).toBe(true);
    expect(ex.facts.find((f) => f.t === 'source')).toMatchObject({ url: 'https://lichess.org/vuOeeysw#75' });
  });

  it('returns null for unclassified mistakes', async () => {
    const a = await analysed();
    const m = { ...a.mistakes.find((x) => x.ply === 75)!, primary: null, conceptId: null, unclassified: true, motifs: [] };
    expect(buildSpotMistake(game, m)).toBeNull();
  });

  it('difficulty starts at the tier prior and drops with larger losses', () => {
    const c = 'tactics/basics/hangingPiece'; // tier 0
    expect(spotMistakeDifficulty(c, 150)).toBe(TIER_MID[0]! + 100);
    expect(spotMistakeDifficulty(c, 650)).toBe(TIER_MID[0]!);
    expect(spotMistakeDifficulty(c, 3000)).toBe(TIER_MID[0]! - 100);
  });
});

describe('pairSimilar (real tactics pack shard)', () => {
  const shard = path.join(ROOT, 'public', 'packs', 'tactics', 'r1400.json');
  const items: TacticItem[] = fs.existsSync(shard) ? (JSON.parse(fs.readFileSync(shard, 'utf8')) as TacticTuple[]).map(decodeTactic) : [];
  const provider = { itemsFor: (c: string) => items.filter((it) => primaryTacticConcept(it.themes) === c).sort((a, b) => a.rating - b.rating) };

  it.skipIf(items.length === 0)('picks puzzles of the same concept nearest the rating and skips positions from the game', () => {
    const concept = 'tactics/double-attack/fork';
    const all = provider.itemsFor(concept);
    const out = pairSimilar({ conceptId: concept }, provider, 3, { rating: 1500 });
    expect(out).toHaveLength(3);
    expect(out.every((e) => e.conceptId === concept && e.format === 'solve')).toBe(true);
    const nearest = [...all].sort((a, b) => Math.abs(a.rating - 1500) - Math.abs(b.rating - 1500))[0]!;
    expect(out[0]!.itemId).toBe(nearest.id);
    const excluded = pairSimilar({ conceptId: concept }, provider, 3, { rating: 1500, gameFens: [nearest.fen] });
    expect(excluded.map((e) => e.itemId)).not.toContain(nearest.id);
    expect(pairSimilar({ conceptId: null }, provider, 3, { rating: 1500 })).toEqual([]);
  });
});

describe('diagnose', () => {
  it('reports miss/allowed rates against opportunities, causes and coverage', async () => {
    const a = await analysed();
    const engine = scriptedEngine({ [before]: { cp: 0, pv: ['b3c3'] } });
    let seed = 1;
    const rng = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const sample = await sampleOpportunities(game, a, engine, { sampleSize: 5, rng });
    expect(sample.sampled).toBe(5);
    expect(sample.nonMistakeMoves).toBe(a.moves.length - a.mistakes.length);
    const d = diagnose([{ game, analysis: a }], [sample]);
    expect(d.mistakes).toBe(1);
    expect(d.coverage).toEqual({ mistakes: 1, classified: 1, byDetector: { hangingPiece: 1 } });
    const hp = d.concepts.find((c) => c.conceptId === 'tactics/basics/hangingPiece')!;
    expect(hp.allowed).toBe(1);
    expect(hp.allowedPer100Moves).toBeCloseTo(100 / a.moves.length);
    // 38. Ne6 took 17 s with 1:35 left: not instant, not time trouble -> 1-ply tactic = vision.
    expect(d.causes.vision).toBe(1);
  });

  it('motifsOnBestLine maps detector hits to concepts', () => {
    // After 38. Ne6 the best reply Qxe6 captures the undefended knight.
    expect(motifsOnBestLine(after, ['a6e6'], null)).toContain('tactics/basics/hangingPiece');
    expect(motifsOnBestLine(after, ['a6e6'], 2)).toContain('tactics/mating/mateIn2');
    expect(epdOf(after)).not.toBe(epdOf(before));
  });

  it('seedFromGames uses the median of the user ratings and shrinks sigma with count', () => {
    expect(seedFromGames([{ userColor: null, whiteElo: 1500, blackElo: 1500 }])).toBeNull();
    const one = seedFromGames([{ userColor: 'w', whiteElo: 1106, blackElo: 1109 }])!;
    expect(one).toEqual({ rating: 1106, sigma: 350, count: 1 });
    const many = seedFromGames(Array.from({ length: 25 }, (_, i) => ({ userColor: 'b' as const, whiteElo: 0, blackElo: 1400 + i })))!;
    expect(many.rating).toBe(1412);
    expect(many.sigma).toBe(170);
  });
});
