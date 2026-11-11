/**
 * Time-management analysis from recorded clocks (Lichess / Chess.com %clk, or the Lichess API
 * `clocks` array). Pure functions; no engine needed beyond the GameAnalysis cp losses.
 *
 * Clock convention: ImportedMove.clockMs is the mover's remaining time AFTER the move, with the
 * increment for that move already added (how Lichess and Chess.com record it). So
 *   timeSpent(ply) = clockBefore - clockAfter + increment,
 * where clockBefore is the mover's previous recorded clock (or the base time on their first move).
 * Lag compensation can make a value slightly negative; it is clamped to 0.
 */
import type { ErrorCause } from '../exercises/types';
import type { ImportedGame } from '../importers/types';
import type { GameAnalysis, Mistake } from './types';

/** "Instant": under 3 s or under 2% of the base time, whichever is larger. */
export const INSTANT_MS = 3000;
export const INSTANT_BASE_FRACTION = 0.02;
/** Time trouble: less than 10% of the base time left before the move. */
export const TROUBLE_BASE_FRACTION = 0.1;
/** Long think: more than 3x the game's median time per move. */
export const LONG_THINK_FACTOR = 3;
/** "Easy" (heuristic): the move lost less than this many centipawns. */
export const EASY_MAX_CP_LOSS = 30;
export const SPEED_BINS_MS = [0, 2000, 5000, 10000, 20000, 40000, 90000];

export interface PlyClock {
  /** Mover's clock before the move (ms), or null without clocks. */
  clockBeforeMs: number | null;
  clockAfterMs: number | null;
  timeSpentMs: number | null;
}

/** Per-ply clock data, index = ply - 1. */
export function plyClocks(game: Pick<ImportedGame, 'moves' | 'timeControl'>): PlyClock[] {
  const baseMs = game.timeControl ? game.timeControl.base * 1000 : null;
  const incMs = game.timeControl ? game.timeControl.inc * 1000 : 0;
  return game.moves.map((m, i) => {
    const after = m.clockMs;
    const prev = i >= 2 ? game.moves[i - 2]!.clockMs : baseMs;
    if (after === null || prev === null) return { clockBeforeMs: prev, clockAfterMs: after, timeSpentMs: null };
    return { clockBeforeMs: prev, clockAfterMs: after, timeSpentMs: Math.max(0, prev - after + incMs) };
  });
}

export interface TimeInfo {
  timeSpentMs: number | null;
  clockBeforeMs: number | null;
  /** Base time in ms (null for untimed / correspondence). */
  baseMs: number | null;
}

export function isInstant(t: TimeInfo): boolean {
  if (t.timeSpentMs === null) return false;
  // Both conditions (the stricter limit): "< 3 s OR < 2% of base" labelled most blitz mistakes as instant.
  const limit = t.baseMs ? Math.min(INSTANT_MS, t.baseMs * INSTANT_BASE_FRACTION) : INSTANT_MS;
  return t.timeSpentMs < limit;
}

export function inTimeTrouble(t: TimeInfo): boolean {
  return t.clockBeforeMs !== null && t.baseMs !== null && t.baseMs > 0 && t.clockBeforeMs < t.baseMs * TROUBLE_BASE_FRACTION;
}

/**
 * Plies needed to see the tactic, per motif (HEURISTIC proxy; the detectors only inspect the key
 * move). Mate in N = 2N-1 plies. A hanging piece or a fork is visible after one move. Pins, skewers,
 * discovered attacks and back-rank checks need the reply and the follow-up (3 plies).
 */
export function tacticDepthPlies(theme: string): number | null {
  const mate = /^mateIn(\d)$/.exec(theme);
  if (mate) return 2 * Number(mate[1]) - 1;
  if (theme === 'hangingPiece' || theme === 'fork') return 1;
  if (theme === 'pin' || theme === 'skewer' || theme === 'discoveredAttack' || theme === 'backRankMate') return 3;
  return null;
}

/**
 * Error cause for a mistake (HEURISTIC, shown to the user as such):
 * - 'time': made in time trouble (< 10% of base left);
 * - 'discipline': played instantly (< 3 s and < 2% of base) - no blunder check;
 * - 'vision': the primary motif is a 1-2 ply tactic (hanging piece, mate in 1, fork);
 * - 'calculation': the primary motif is a tactic needing >= 3 plies (mate in 2+, pin, skewer, ...);
 * - 'knowledge': the only finding is a missed strategic feature;
 * - null: unclassified mistake with normal thinking time (no basis for a cause).
 */
export function inferCause(mistake: Pick<Mistake, 'primary'>, t: TimeInfo): ErrorCause | null {
  if (inTimeTrouble(t)) return 'time';
  if (isInstant(t)) return 'discipline';
  const p = mistake.primary;
  if (!p) return null;
  if (!p.conceptId.startsWith('tactics/')) return 'knowledge';
  const depth = tacticDepthPlies(p.theme);
  if (depth === null) return 'calculation';
  return depth <= 2 ? 'vision' : 'calculation';
}

export interface SpeedBin {
  label: string;
  fromMs: number;
  toMs: number | null;
  moves: number;
  mistakes: number;
  /** mistakes / moves, null when the bin is empty. */
  rate: number | null;
}

export interface TimeReport {
  games: number;
  /** Games that had clock data. */
  gamesWithClocks: number;
  movesWithClocks: number;
  medianSpentMs: number | null;
  instantMistakes: { gameId: string; ply: number; timeSpentMs: number; cpLoss: number }[];
  longThinksOnEasyMoves: { gameId: string; ply: number; timeSpentMs: number; cpLoss: number; medianMs: number }[];
  timeTrouble: {
    movesInTrouble: number;
    mistakesInTrouble: number;
    /** Share of all (clocked) analysed moves made in time trouble. */
    shareOfMoves: number | null;
    /** Share of all (clocked) mistakes made in time trouble. Compare with shareOfMoves. */
    shareOfMistakes: number | null;
  };
  speedAccuracy: SpeedBin[];
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const binLabel = (from: number, to: number | null): string => (to === null ? `${from / 1000}s+` : `${from / 1000}-${to / 1000}s`);

/**
 * Time report over analysed games. Only analysed plies (the user's moves, or both sides when the
 * colour is unknown) count. "Long thinks on easy moves" uses only the cp-loss test: it does NOT check
 * whether the position was critical / an only-move situation, so some long thinks it lists were
 * justified - documented as a heuristic.
 */
export function timeReport(items: { game: ImportedGame; analysis: GameAnalysis }[]): TimeReport {
  const bins: SpeedBin[] = SPEED_BINS_MS.map((from, i) => {
    const to = SPEED_BINS_MS[i + 1] ?? null;
    return { label: binLabel(from, to), fromMs: from, toMs: to, moves: 0, mistakes: 0, rate: null };
  });
  const report: TimeReport = {
    games: items.length,
    gamesWithClocks: 0,
    movesWithClocks: 0,
    medianSpentMs: null,
    instantMistakes: [],
    longThinksOnEasyMoves: [],
    timeTrouble: { movesInTrouble: 0, mistakesInTrouble: 0, shareOfMoves: null, shareOfMistakes: null },
    speedAccuracy: bins,
  };
  const allSpent: number[] = [];
  let clockedMistakes = 0;
  for (const { game, analysis } of items) {
    const clocks = plyClocks(game);
    const baseMs = game.timeControl ? game.timeControl.base * 1000 : null;
    const mistakePlies = new Set(analysis.mistakes.map((m) => m.ply));
    const spent = analysis.moves.map((p) => clocks[p.ply - 1]?.timeSpentMs ?? null).filter((x): x is number => x !== null);
    if (spent.length === 0) continue;
    report.gamesWithClocks++;
    allSpent.push(...spent);
    const med = median(spent)!;
    for (const p of analysis.moves) {
      const c = clocks[p.ply - 1];
      if (!c || c.timeSpentMs === null) continue;
      report.movesWithClocks++;
      const isMistake = mistakePlies.has(p.ply);
      const info: TimeInfo = { timeSpentMs: c.timeSpentMs, clockBeforeMs: c.clockBeforeMs, baseMs };
      const bin = bins.find((b) => c.timeSpentMs! >= b.fromMs && (b.toMs === null || c.timeSpentMs! < b.toMs))!;
      bin.moves++;
      if (isMistake) {
        bin.mistakes++;
        clockedMistakes++;
        if (isInstant(info)) report.instantMistakes.push({ gameId: game.id, ply: p.ply, timeSpentMs: c.timeSpentMs, cpLoss: p.cpLoss });
      }
      if (inTimeTrouble(info)) {
        report.timeTrouble.movesInTrouble++;
        if (isMistake) report.timeTrouble.mistakesInTrouble++;
      }
      if (med > 0 && c.timeSpentMs > LONG_THINK_FACTOR * med && p.cpLoss < EASY_MAX_CP_LOSS) {
        report.longThinksOnEasyMoves.push({ gameId: game.id, ply: p.ply, timeSpentMs: c.timeSpentMs, cpLoss: p.cpLoss, medianMs: med });
      }
    }
  }
  for (const b of bins) b.rate = b.moves > 0 ? b.mistakes / b.moves : null;
  report.medianSpentMs = median(allSpent);
  if (report.movesWithClocks > 0) report.timeTrouble.shareOfMoves = report.timeTrouble.movesInTrouble / report.movesWithClocks;
  if (clockedMistakes > 0) report.timeTrouble.shareOfMistakes = report.timeTrouble.mistakesInTrouble / clockedMistakes;
  return report;
}

/** TimeInfo for one ply of a game (for inferCause). */
export function timeInfoFor(game: Pick<ImportedGame, 'moves' | 'timeControl'>, ply: number, clocks = plyClocks(game)): TimeInfo {
  const c = clocks[ply - 1];
  return { timeSpentMs: c?.timeSpentMs ?? null, clockBeforeMs: c?.clockBeforeMs ?? null, baseMs: game.timeControl ? game.timeControl.base * 1000 : null };
}
