import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { playLine } from '../engine/chessUtil';
import { parsePgn } from '../importers/pgn';
import type { ImportedGame } from '../importers/types';
import { AnalysisQueue, MATE_CAP, analyseGame, foldScore } from './analyze';
import { scriptedEngine } from './testUtil';

// Real Lichess games (CC0): see src/importers/fixtures.
const FIX = path.join(import.meta.dirname, '..', 'importers', 'fixtures');
const clocked = parsePgn(fs.readFileSync(path.join(FIX, 'lichess-clocked.pgn'), 'utf8'), { username: 'KavithaN20' }).games;
const evalGame = parsePgn(fs.readFileSync(path.join(FIX, 'lichess-eval.pgn'), 'utf8'), { username: 'DrNykterstein' }).games[0]!;

/** Position before ply `k` (1-based), or after the last move for k = moves + 1. */
function fenAt(g: ImportedGame, k: number): string {
  const m = g.moves[k - 1];
  if (m) return m.fenBefore;
  const last = g.moves[g.moves.length - 1]!;
  return playLine(last.fenBefore, [last.uci])!.chess.fen();
}

/** First `n` plies of a game, as its own game. */
function truncate(g: ImportedGame, n: number, userColor: 'w' | 'b' | null): ImportedGame {
  return { ...g, moves: g.moves.slice(0, n), userColor };
}

describe('foldScore', () => {
  it('folds mates to +-MATE_CAP and clamps large cp', () => {
    expect(foldScore({ cp: null, mate: 3 })).toBe(MATE_CAP);
    expect(foldScore({ cp: null, mate: -1 })).toBe(-MATE_CAP);
    expect(foldScore({ cp: null, mate: 0 })).toBe(-MATE_CAP);
    expect(foldScore({ cp: 4000, mate: null })).toBe(MATE_CAP);
    expect(foldScore({ cp: -35, mate: null })).toBe(-35);
  });
});

describe('analyseGame sign conventions and threshold', () => {
  const g = clocked[0]!; // aila - GEIMIDEISH
  it('computes cp loss from the mover POV (black mover, engine scores side-to-move POV)', async () => {
    // Before ply 2 (black to move): +50 for black. After ply 2 (white to move): +250 for white.
    const engine = scriptedEngine({ [fenAt(g, 2)]: { cp: 50 }, [fenAt(g, 3)]: { cp: 250 } });
    const a = await analyseGame(truncate(g, 4, 'b'), engine);
    const p2 = a.moves.find((m) => m.ply === 2)!;
    expect(p2).toMatchObject({ color: 'b', evalBeforeCp: 50, evalAfterCp: -250, cpLoss: 300, source: 'engine' });
    expect(a.moves.map((m) => m.ply)).toEqual([2, 4]);
    expect(a.mistakes.map((m) => m.ply)).toEqual([2]);
    // Graph is from white's POV: position before ply 2 is -50 for white, after is +250.
    expect(a.graph[1]).toBe(-50);
    expect(a.graph[2]).toBe(250);
  });

  it('a gain is never a negative loss', async () => {
    const engine = scriptedEngine({ [fenAt(g, 1)]: { cp: 0 }, [fenAt(g, 2)]: { cp: -300 } });
    const a = await analyseGame(truncate(g, 2, 'w'), engine);
    expect(a.moves[0]).toMatchObject({ evalBeforeCp: 0, evalAfterCp: 300, cpLoss: 0 });
  });

  it('flags a mistake at exactly 150 cp but not at 149', async () => {
    const at = async (after: number): Promise<number> => {
      const engine = scriptedEngine({ [fenAt(g, 1)]: { cp: 20 }, [fenAt(g, 2)]: { cp: after } });
      return (await analyseGame(truncate(g, 2, 'w'), engine)).mistakes.length;
    };
    expect(await at(129)).toBe(0); // loss 149
    expect(await at(130)).toBe(1); // loss 150
  });

  it('folds a missed mate to the cap', async () => {
    const engine = scriptedEngine({ [fenAt(g, 1)]: { mate: 4 }, [fenAt(g, 2)]: { cp: 100 } });
    const a = await analyseGame(truncate(g, 2, 'w'), engine);
    expect(a.moves[0]).toMatchObject({ evalBeforeCp: MATE_CAP, evalAfterCp: -100, cpLoss: MATE_CAP + 100, mateBefore: 4, mateAfter: null });
    expect(a.mistakes[0]!.mateBefore).toBe(4);
  });

  it('never calls the engine-best move a mistake', async () => {
    const engine = scriptedEngine({ [fenAt(g, 1)]: { cp: 20, pv: [g.moves[0]!.uci] }, [fenAt(g, 2)]: { cp: 400 } });
    const a = await analyseGame(truncate(g, 2, 'w'), engine);
    expect(a.moves[0]!.cpLoss).toBe(420);
    expect(a.mistakes).toEqual([]);
  });

  it('analyses both sides when the user colour is unknown and reports progress per ply', async () => {
    const seen: number[] = [];
    const a = await analyseGame(truncate(g, 6, null), scriptedEngine(), { onProgress: (p) => seen.push(p.ply) });
    expect(a.moves.map((m) => m.ply)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('embedded evals', () => {
  it('uses the game file evals for both positions and the engine only for the first ply and mistakes', async () => {
    const engine = scriptedEngine();
    const a = await analyseGame(evalGame, engine);
    expect(a.userColor).toBe('b');
    // Black's 17... gxf3 (ply 34): after 17. f4 +0.19, after gxf3 +0.36 (white POV) -> 17 cp lost by Black.
    const p34 = a.moves.find((m) => m.ply === 34)!;
    expect(p34).toMatchObject({ source: 'embedded', evalBeforeCp: -19, evalAfterCp: -36, cpLoss: 17 });
    expect(a.moves.every((m) => m.source === 'embedded')).toBe(true);
    expect(a.mistakes).toEqual([]);
    // No user ply starts from the initial position (black), so the engine is never needed.
    expect(engine.calls).toHaveLength(0);
    expect(a.evalSources.engine).toBe(0);
  });

  it('for White (the side that blundered with 18. Bf4) it finds the mistake from embedded evals and asks the engine for lines', async () => {
    const white = { ...evalGame, userColor: 'w' as const };
    const engine = scriptedEngine();
    const a = await analyseGame(white, engine);
    // 18. Bf4: +0.36 -> -6.43 (white POV) = 679 cp loss.
    const m = a.mistakes.find((x) => x.ply === 35)!;
    expect(m).toMatchObject({ playedSan: 'Bf4', cpLoss: 679, source: 'embedded', evalBeforeCp: 36, evalAfterCp: -643 });
    // Engine calls: ply 1 (start position + after 1. e4), and for each mistake: MultiPV before + refutation after.
    const multipv = engine.calls.filter((c) => c.opts?.multipv === 3);
    expect(multipv.map((c) => c.fen)).toContain(m.fen);
    expect(engine.calls.length).toBe(2 + 2 * a.mistakes.length);
  });
});

describe('classification with the real detectors', () => {
  it("38. Ne6?? in vuOeeysw is classified as allowing a hanging piece (Qxe6)", async () => {
    const g = clocked[1]!;
    expect(g.moves[74]!.san).toBe('Ne6');
    const before = fenAt(g, 75);
    const after = fenAt(g, 76);
    const engine = scriptedEngine({ [before]: { cp: 0, pv: ['b3c3'] }, [after]: { cp: 500, pv: ['a6e6'] } });
    const a = await analyseGame(truncate(g, 76, 'w'), engine);
    const m = a.mistakes.find((x) => x.ply === 75)!;
    expect(m.primary).toMatchObject({ theme: 'hangingPiece', kind: 'allowed', conceptId: 'tactics/basics/hangingPiece' });
    expect(m.refutationPvSan).toEqual(['Qxe6']);
    expect(a.coverage).toEqual({ mistakes: 1, classified: 1, byDetector: { hangingPiece: 1 } });
    expect(m.timeSpentMs).toBe(17_000); // 1:35 -> 1:18
  });
});

describe('AnalysisQueue', () => {
  it('analyses games one at a time and stops on cancel', async () => {
    const q = new AnalysisQueue(scriptedEngine());
    const started: string[] = [];
    const done: string[] = [];
    const games = [truncate(clocked[0]!, 8, 'w'), truncate(clocked[1]!, 8, 'w'), truncate(clocked[2]!, 8, 'w')];
    const res = await q.run(games, {
      onGameStart: (g) => started.push(g.id),
      onProgress: (_g, p) => {
        if (p.done === 2 && started.length === 2) q.cancel();
      },
      onGameDone: (g) => {
        done.push(g.id);
      },
    });
    expect(done).toEqual([games[0]!.id]);
    expect(res).toHaveLength(1);
    expect(started).toHaveLength(2);
  });
});
