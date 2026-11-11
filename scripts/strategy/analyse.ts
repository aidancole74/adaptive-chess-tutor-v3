/**
 * Strategy bank: per-position analysis shared by the worker processes.
 *
 * Selection rules (every label below comes from Stockfish output or the feature extractors):
 *  - MultiPV 4 at the requested depth.
 *  - QUIET: the best line's first 3 plies contain no capture, check or promotion (replayed with chess.js).
 *  - |bestCp| <= MAX_ABS_CP and no mate score in any MultiPV line (decided / tactical positions are dropped).
 *  - The best move beats the second-best by >= MARGIN_CP centipawns, so there is one clearly best quiet move.
 *    60 cp is a bit more than half a pawn: at depth 14 evaluation noise between near-equal moves is
 *    typically 10-30 cp, so a 60 cp gap is a stable "this move is better" signal without demanding a tactic.
 *  - Trade: an equal-value capture with static exchange 0 whose target is defended (a capture-recapture),
 *    evaluated with `searchmoves` at the same depth; verdict by loss vs best: <= 30 good, <= 100 neutral, else bad.
 */
import { Chess, type Move } from 'chess.js';
import { epdOf, playLine } from '../../src/engine/chessUtil';
import { classifyPlan, extractFeatures, featureDeltas, featureNamesBySide } from '../../src/engine/features';
import { applyUci, attackersOf, parseFen, seeCapture, sqIndex } from '../../src/engine/features/board';
import { TIER_MID, tierOfRating } from '../../src/curriculum/concepts';
import type { StrategyItem } from '../../src/content/types';
import { cpOf, type NodeStockfish, type SfLine } from '../lib/pack';

export const MARGIN_CP = 60;
export const MAX_ABS_CP = 400;
export const QUIET_PLIES = 3;
export const MULTIPV = 4;
/**
 * Cheap prefilter (a speed device only; it never produces a label): depth 8, MultiPV 2. A position goes on to
 * the full search only when the shallow best line is quiet, no mate is shown, |cp| <= 600 and the shallow
 * margin is >= 20 cp. Calibrated on 560 sampled positions: the full search cost ~1.1 s/position vs ~28 ms for
 * the prefilter; 15% of positions pass and they contain 17 of the 29 positions the full rules keep, so the
 * cost per kept item drops ~3x. It biases the bank slightly towards positions whose best move stands out early.
 */
export const PRE_DEPTH = 8;
export const PRE_MARGIN_CP = 20;
export const PRE_MAX_ABS_CP = 600;

export interface Task {
  key: string;
  game: string;
  ply: number;
  fen: string;
}

export type Rejection =
  | 'too-few-moves'
  | 'mate-score'
  | 'decided'
  | 'best-not-quiet'
  | 'small-margin'
  | 'engine-error'
  | 'pre-decided'
  | 'pre-not-quiet'
  | 'pre-small-margin';

export type TaskResult = { key: string; item: StrategyItem } | { key: string; reject: Rejection };

const VALUE: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

/** True when the first `plies` moves of `pv` contain no capture, check or promotion. */
export function pvIsQuiet(fen: string, pv: string[], plies = QUIET_PLIES): boolean {
  const lead = pv.slice(0, plies);
  if (lead.length === 0) return false;
  const chess = new Chess(fen);
  for (const u of lead) {
    let m: Move;
    try {
      m = chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u.length > 4 ? u[4] : undefined });
    } catch {
      return false;
    }
    if (m.captured || m.promotion || m.san.includes('+') || m.san.includes('#')) return false;
  }
  return true;
}

/**
 * Candidate equal-material trade: a legal capture of an equal-value piece that is not a check or promotion,
 * whose static exchange is exactly 0 and whose target square the opponent still defends after the capture
 * (so a recapture is available). Most natural first: same piece type, then higher value, then UCI order.
 */
export function pickTrade(fen: string): string | null {
  const chess = new Chess(fen);
  const board = parseFen(fen);
  const oppSign = board.turn === 'w' ? -1 : 1;
  const ep = fen.split(' ')[3] ?? '-';
  const epIdx = ep === '-' ? -1 : sqIndex(ep);
  const cands: { uci: string; same: boolean; value: number }[] = [];
  for (const m of chess.moves({ verbose: true })) {
    if (!m.captured || m.promotion || m.san.includes('+') || m.san.includes('#')) continue;
    const vA = VALUE[m.piece] ?? 0;
    const vC = VALUE[m.captured] ?? 0;
    if (vA !== vC || m.piece === 'k') continue;
    const from = sqIndex(m.from);
    const to = sqIndex(m.to);
    if (seeCapture(board.sq, from, to, epIdx) !== 0) continue;
    const after = applyUci(board, m.from + m.to);
    if (!after || attackersOf(after.sq, to, oppSign as 1 | -1).length === 0) continue;
    cands.push({ uci: m.from + m.to, same: m.piece === m.captured, value: vA });
  }
  cands.sort((a, b) => Number(b.same) - Number(a.same) || b.value - a.value || a.uci.localeCompare(b.uci));
  return cands[0]?.uci ?? null;
}

/**
 * Tier heuristic (documented): the exercise is "find the one clearly best quiet move".
 *  rating = 1700
 *    - 1.5 * (margin - 60), at most -300   (the bigger the gap to the 2nd move, the easier it is to feel)
 *    + plan adjustment: castling/develop -250; rook-to-open-file, piece-to-outpost, centralize -100;
 *      improve-piece, prophylaxis +150; others 0   (natural moves vs subtle ones)
 *    + 4 per legal move above 30, clamped to +-100  (more choice = harder)
 *  clamped to 1100..2300 and mapped through tierOfRating (difficulty shown to the scheduler is TIER_MID[tier]).
 */
export function tierFor(margin: number, plan: string, legalMoves: number): number {
  let r = 1700 - Math.min(300, 1.5 * Math.max(0, margin - MARGIN_CP));
  if (plan === 'develop' || plan === 'king-safety') r -= 250;
  else if (plan === 'rook-to-open-file' || plan === 'piece-to-outpost' || plan === 'centralize') r -= 100;
  else if (plan === 'improve-piece' || plan === 'prophylaxis') r += 150;
  r += Math.max(-100, Math.min(100, 4 * (legalMoves - 30)));
  r = Math.max(1100, Math.min(2300, r));
  const t = tierOfRating(r);
  return Math.min(t, TIER_MID.length - 1);
}

export async function analyseTask(sf: NodeStockfish, task: Task, depth: number, prefilter = true): Promise<TaskResult> {
  const { fen } = task;
  let lines: SfLine[];
  try {
    sf.newGame();
    if (prefilter) {
      const pre = await sf.analyse(fen, { depth: PRE_DEPTH, multipv: 2 });
      const p0 = pre[0];
      const p1 = pre[1];
      if (!p0 || !p1 || p0.pv.length === 0) return { key: task.key, reject: 'too-few-moves' };
      if (p0.mate !== null || p1.mate !== null || Math.abs(cpOf(p0)) > PRE_MAX_ABS_CP) return { key: task.key, reject: 'pre-decided' };
      if (!pvIsQuiet(fen, p0.pv)) return { key: task.key, reject: 'pre-not-quiet' };
      if (cpOf(p0) - cpOf(p1) < PRE_MARGIN_CP) return { key: task.key, reject: 'pre-small-margin' };
      sf.newGame();
    }
    lines = await sf.analyse(fen, { depth, multipv: MULTIPV });
  } catch {
    return { key: task.key, reject: 'engine-error' };
  }
  const best = lines[0];
  const second = lines[1];
  if (!best || !second || best.pv.length === 0 || second.pv.length === 0) return { key: task.key, reject: 'too-few-moves' };
  if (lines.some((l) => l.mate !== null)) return { key: task.key, reject: 'mate-score' };
  const bestCp = cpOf(best);
  const secondCp = cpOf(second);
  if (Math.abs(bestCp) > MAX_ABS_CP) return { key: task.key, reject: 'decided' };
  if (!pvIsQuiet(fen, best.pv)) return { key: task.key, reject: 'best-not-quiet' };
  const margin = bestCp - secondCp;
  if (margin < MARGIN_CP) return { key: task.key, reject: 'small-margin' };

  const bestUci = best.pv[0]!;
  const fBefore = extractFeatures(fen);
  const afterBest = playLine(fen, [bestUci]);
  if (!afterBest) return { key: task.key, reject: 'engine-error' };
  const fAfter = extractFeatures(afterBest.chess.fen());
  const plan = classifyPlan(fen, bestUci).plan;
  const otherPlans = lines
    .slice(1)
    .filter((l) => l.pv[0] && bestCp - cpOf(l) >= MARGIN_CP)
    .map((l) => ({ plan: classifyPlan(fen, l.pv[0]!).plan as string, uci: l.pv[0]!, cpLoss: bestCp - cpOf(l) }));

  let trade: StrategyItem['trade'] = null;
  const tradeUci = pickTrade(fen);
  if (tradeUci) {
    let tradeCp: number | null = null;
    const inLines = lines.find((l) => l.pv[0] === tradeUci);
    if (inLines) tradeCp = cpOf(inLines);
    else {
      try {
        const tl = await sf.analyse(fen, { depth, multipv: 1, searchmoves: [tradeUci] });
        const l0 = tl[0];
        if (l0 && l0.pv[0] === tradeUci) tradeCp = cpOf(l0);
      } catch {
        tradeCp = null;
      }
    }
    if (tradeCp !== null && Math.abs(tradeCp) < 50000) {
      const loss = bestCp - tradeCp;
      trade = { uci: tradeUci, cp: tradeCp, verdict: loss <= 30 ? 'good' : loss <= 100 ? 'neutral' : 'bad' };
    }
  }

  const names = featureNamesBySide(fBefore);
  const legal = new Chess(fen).moves().length;
  const item: StrategyItem = {
    id: `st-${task.game}-${task.ply}`,
    fen,
    best: bestUci,
    pv: best.pv,
    bestCp,
    secondCp,
    lines: lines.filter((l) => l.pv[0]).map((l) => ({ uci: l.pv[0]!, cp: cpOf(l) })),
    depth: best.depth,
    sourceGame: task.game,
    ply: task.ply,
    features: { w: [...names.w], b: [...names.b] },
    featureDeltas: featureDeltas(fBefore, fAfter),
    plan,
    otherPlans,
    trade,
    structure: fBefore.structure,
    tier: tierFor(margin, plan, legal),
    verified: true,
  };
  return { key: task.key, item };
}

export function epdKey(fen: string): string {
  return epdOf(fen);
}
