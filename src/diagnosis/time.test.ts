import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DetectedMotif } from '../engine/motifs';
import { parsePgn } from '../importers/pgn';
import { analyseGame } from './analyze';
import { scriptedEngine } from './testUtil';
import { inferCause, isInstant, inTimeTrouble, plyClocks, tacticDepthPlies, timeReport, type TimeInfo } from './time';

// Real Lichess game vuOeeysw (CC0), 5+0, Black lost on time.
const FIX = path.join(import.meta.dirname, '..', 'importers', 'fixtures');
const game = parsePgn(fs.readFileSync(path.join(FIX, 'lichess-clocked.pgn'), 'utf8'), { username: 'franky5019' }).games[1]!;

const motif = (theme: string, conceptId: string, kind: 'missed' | 'allowed' = 'allowed'): DetectedMotif => ({ theme, conceptId, kind, squares: [], detail: '' });
const info = (p: Partial<TimeInfo>): TimeInfo => ({ timeSpentMs: 20_000, clockBeforeMs: 200_000, baseMs: 300_000, ...p });

describe('plyClocks', () => {
  it('derives time spent from consecutive clocks of the same side', () => {
    const c = plyClocks(game);
    expect(c[0]).toEqual({ clockBeforeMs: 300_000, clockAfterMs: 300_000, timeSpentMs: 0 });
    expect(c[74]!.timeSpentMs).toBe(17_000); // 37. Nf8+ 1:35 -> 38. Ne6 1:18
    expect(c[85]).toEqual({ clockBeforeMs: 10_000, clockAfterMs: 6_000, timeSpentMs: 4_000 }); // 43... Nb4
  });
  it('adds the increment and returns null without clocks', () => {
    const inc = plyClocks({ ...game, timeControl: { base: 300, inc: 2 } });
    expect(inc[74]!.timeSpentMs).toBe(19_000);
    const none = plyClocks({ ...game, moves: game.moves.map((m) => ({ ...m, clockMs: null })) });
    expect(none.every((c) => c.timeSpentMs === null)).toBe(true);
  });
});

describe('instant / time trouble thresholds', () => {
  it('instant is < min(3 s, 2% of base): both limits must hold', () => {
    expect(isInstant(info({ timeSpentMs: 1_100, baseMs: 60_000 }))).toBe(true); // 2% of 1 min = 1.2 s
    expect(isInstant(info({ timeSpentMs: 2_999, baseMs: 60_000 }))).toBe(false);
    expect(isInstant(info({ timeSpentMs: 3_000, baseMs: 60_000 }))).toBe(false);
    expect(isInstant(info({ timeSpentMs: 5_000, baseMs: 600_000 }))).toBe(false); // capped at 3 s
    expect(isInstant(info({ timeSpentMs: 2_500, baseMs: 600_000 }))).toBe(true);
    expect(isInstant(info({ timeSpentMs: null }))).toBe(false);
  });
  it('time trouble is < 10% of base left before the move', () => {
    expect(inTimeTrouble(info({ clockBeforeMs: 29_999 }))).toBe(true);
    expect(inTimeTrouble(info({ clockBeforeMs: 30_000 }))).toBe(false);
    expect(inTimeTrouble(info({ baseMs: null }))).toBe(false);
  });
});

describe('inferCause (heuristic)', () => {
  it('orders time > discipline > motif depth', () => {
    const fork = { primary: motif('fork', 'tactics/double-attack/fork') };
    expect(inferCause(fork, info({ clockBeforeMs: 10_000, timeSpentMs: 1_000 }))).toBe('time');
    expect(inferCause(fork, info({ timeSpentMs: 1_000 }))).toBe('discipline');
    expect(inferCause(fork, info({}))).toBe('vision');
    expect(inferCause({ primary: motif('hangingPiece', 'tactics/basics/hangingPiece') }, info({}))).toBe('vision');
    expect(inferCause({ primary: motif('mateIn1', 'tactics/basics/mateIn1') }, info({}))).toBe('vision');
    expect(inferCause({ primary: motif('mateIn2', 'tactics/mating/mateIn2') }, info({}))).toBe('calculation');
    expect(inferCause({ primary: motif('pin', 'tactics/double-attack/pin') }, info({}))).toBe('calculation');
    expect(inferCause({ primary: motif('outpost', 'strategy/squares/outpost', 'missed') }, info({}))).toBe('knowledge');
    expect(inferCause({ primary: null }, info({}))).toBeNull();
  });
  it('maps mate in N to 2N-1 plies', () => {
    expect(tacticDepthPlies('mateIn3')).toBe(5);
    expect(tacticDepthPlies('outpost')).toBeNull();
  });
});

describe('timeReport', () => {
  it('finds the time-trouble mistake and fills the speed-accuracy bins', async () => {
    // Scripted evals: only 43... Nb4 (ply 86, 10 s left of 300) loses 400 cp.
    const engine = scriptedEngine({ [game.moves[85]!.fenBefore]: { cp: 0 }, [game.moves[86]!.fenBefore]: { cp: 400 } });
    const analysis = await analyseGame(game, engine);
    expect(analysis.mistakes.map((m) => m.ply)).toEqual([86]);
    const r = timeReport([{ game, analysis }]);
    expect(r.gamesWithClocks).toBe(1);
    expect(r.movesWithClocks).toBe(44);
    expect(r.timeTrouble.mistakesInTrouble).toBe(1);
    expect(r.timeTrouble.shareOfMistakes).toBe(1);
    expect(r.timeTrouble.shareOfMoves).toBeGreaterThan(0);
    expect(r.timeTrouble.shareOfMoves).toBeLessThan(0.2);
    expect(r.speedAccuracy.reduce((a, b) => a + b.moves, 0)).toBe(44);
    const bin = r.speedAccuracy.find((b) => b.mistakes === 1)!;
    expect(bin.label).toBe('2-5s');
    // 4 s is above the 3 s cap, so this time-trouble mistake is not instant.
    expect(r.instantMistakes).toEqual([]);
    expect(r.longThinksOnEasyMoves.every((l) => l.timeSpentMs > 3 * l.medianMs && l.cpLoss < 30)).toBe(true);
    expect(r.longThinksOnEasyMoves.length).toBeGreaterThan(0);
  });
});
