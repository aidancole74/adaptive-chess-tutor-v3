/**
 * Mutual zugzwang and triangulation, found with local retrograde solvers (pre-filter only) and
 * verified with the tablebase:
 *  - zugzwang: the side to move has exactly one move that keeps its result, and in the position
 *    after that move the opponent (to move) does strictly worse than it would if it could pass
 *    (second probe of the same placement with the side to move swapped);
 *  - triangulation: the attacker's DTM-optimal winning line, against the tablebase's longest
 *    defence, returns to the starting placement with the defender to move (5 plies). Every attacker
 *    move of the line is in the tablebase's DTM-optimal set, so losing the tempo is (one of) the
 *    fastest ways to win; the final position is a defender loss because the last move was winning.
 */
import { afterMove, fenOf, near, ri, sq, uci, withStm, type Rng, type Sq } from './board';
import { blockedSolver, kpkBlackMoves, kpkLegal, kpkWhiteMoves, kpkWin, type BlockedSolver } from './local';
import { best, type Cand, type Generator } from './types';
import type { TbProbeOk } from '../../src/engine/tablebase';
import { optimalMoves } from '../../src/engine/tablebase';

const RANK = { win: 2, draw: 1, loss: 0 } as const;

const kpkFen = (wk: Sq, bk: Sq, p: Sq, stm: 'w' | 'b'): string | null =>
  fenOf(
    [
      ['K', wk],
      ['k', bk],
      ['P', p],
    ],
    stm,
  );
const blockedFen = (s: BlockedSolver, wk: Sq, bk: Sq, stm: 'w' | 'b'): string | null =>
  fenOf(
    [
      ['K', wk],
      ['k', bk],
      ['P', s.wp],
      ['p', s.bp],
    ],
    stm,
  );

function kpkZugzwang(rng: Rng): Cand | null {
  const p = sq(ri(rng, 0, 7), ri(rng, 1, 5));
  const wk = near(rng, p, 1, 3);
  const bk = near(rng, p, 1, 3);
  if (wk < 0 || bk < 0) return null;
  if (rng() < 0.5) {
    if (!kpkLegal('w', wk, bk, p) || !kpkWin('w', wk, bk, p)) return null;
    const wins = kpkWhiteMoves(wk, bk, p).filter((m) => m.whiteWins);
    const m = wins[0];
    if (wins.length !== 1 || !m || m.pawn) return null;
    // After m Black is to move and lost; with White to move instead it would not be a win.
    if (!kpkLegal('w', m.to, bk, p) || kpkWin('w', m.to, bk, p)) return null;
    const fen = kpkFen(wk, bk, p, 'w');
    return fen ? { fen, bucket: 'attacker', move: uci(m.from, m.to) } : null;
  }
  if (!kpkLegal('b', wk, bk, p) || kpkWin('b', wk, bk, p)) return null;
  const ms = kpkBlackMoves(wk, bk, p);
  const draws = ms.filter((m) => !m.whiteWins);
  const m = draws[0];
  if (ms.length < 2 || draws.length !== 1 || !m || m.capture) return null;
  if (!kpkLegal('b', wk, m.to, p) || !kpkWin('b', wk, m.to, p)) return null;
  const fen = kpkFen(wk, bk, p, 'b');
  return fen ? { fen, bucket: 'defender', move: uci(m.from, m.to) } : null;
}

function blockedZugzwang(rng: Rng): Cand | null {
  const s = blockedSolver(sq(ri(rng, 0, 7), ri(rng, 1, 5)));
  const wk = near(rng, s.wp, 1, 3);
  const bk = near(rng, s.bp, 1, 3);
  if (wk < 0 || bk < 0) return null;
  const stm = rng() < 0.5 ? 'w' : 'b';
  if (!s.legal(stm, wk, bk)) return null;
  const now = s.result(stm, wk, bk);
  if (stm === 'w') {
    const keep = s.whiteMoves(wk, bk).filter((m) => m.res === now);
    const m = keep[0];
    if (keep.length !== 1 || !m || m.capture || !s.legal('w', m.to, bk)) return null;
    if (s.result('w', m.to, bk) >= now) return null;
    const fen = blockedFen(s, wk, bk, 'w');
    return fen ? { fen, bucket: now === 1 ? 'attacker' : 'defender', move: uci(wk, m.to) } : null;
  }
  const keep = s.blackMoves(wk, bk).filter((m) => m.res === now);
  const m = keep[0];
  if (keep.length !== 1 || !m || m.capture || !s.legal('b', wk, m.to)) return null;
  if (s.result('b', wk, m.to) <= now) return null;
  const fen = blockedFen(s, wk, bk, 'b');
  return fen ? { fen, bucket: now === -1 ? 'attacker' : 'defender', move: uci(bk, m.to) } : null;
}

const zugzwang: Generator = {
  concept: 'endgames/pawn/zugzwang',
  property:
    'K+P vs K or K+P vs K+P (blocked pawns): exactly one move keeps the side to move\'s result, and after it the opponent to move ' +
    'scores strictly worse than with the same placement and the mover to move (mutual zugzwang, two tablebase probes).',
  buckets: { attacker: 0.6, defender: 0.6 },
  probeFactor: 4,
  candidate: (rng) => (rng() < 0.5 ? kpkZugzwang(rng) : blockedZugzwang(rng)),
  async accept(c, p, ctx) {
    const b = best(p);
    const m = b[0];
    if (b.length !== 1 || !m || m.uci !== c.move || p.moves.length < 2) return null;
    const stm = c.fen.split(' ')[1] === 'b' ? 'b' : 'w';
    const q = afterMove(c.fen, m.uci);
    if (!q) return null;
    const swapped = await ctx.probe(withStm(q, stm));
    if (!swapped) return null;
    // m.category: mover's result with the opponent to move in Q; swapped.category: mover's result if the mover could move again.
    if (RANK[swapped.category] >= RANK[m.category]) return null;
    return { bucket: c.bucket ?? (p.category === 'win' ? 'attacker' : 'defender'), playout: true };
  },
};

/* ---------- triangulation ---------- */

interface Depths {
  s: BlockedSolver;
  /** Local plies-to-capture estimate for White wins: index (stm*64+wk)*64+bk. */
  d: Int16Array;
}
const depthCache = new Map<Sq, Depths>();
const INF = 9999;

export function depths(wp: Sq): Depths {
  const hit = depthCache.get(wp);
  if (hit) return hit;
  const s = blockedSolver(wp);
  const d = new Int16Array(2 * 64 * 64).fill(INF);
  const ix = (stm: number, wk: Sq, bk: Sq): number => (stm * 64 + wk) * 64 + bk;
  for (let it = 0; it < 200; it++) {
    let changed = false;
    for (let wk = 0; wk < 64; wk++) {
      for (let bk = 0; bk < 64; bk++) {
        if (s.legal('w', wk, bk) && s.result('w', wk, bk) === 1) {
          let v = INF;
          for (const m of s.whiteMoves(wk, bk)) {
            if (m.res !== 1) continue;
            v = Math.min(v, m.capture ? 1 : 1 + (d[ix(1, m.to, bk)] ?? INF));
          }
          if (v < (d[ix(0, wk, bk)] ?? INF)) {
            d[ix(0, wk, bk)] = v;
            changed = true;
          }
        }
        if (s.legal('b', wk, bk) && s.result('b', wk, bk) === 1) {
          let v = 0;
          for (const m of s.blackMoves(wk, bk)) v = Math.max(v, m.capture ? 1 : 1 + (d[ix(0, wk, m.to)] ?? INF));
          v = Math.min(v, INF);
          if (v < (d[ix(1, wk, bk)] ?? INF)) {
            d[ix(1, wk, bk)] = v;
            changed = true;
          }
        }
      }
    }
    if (!changed) break;
  }
  const out = { s, d };
  depthCache.set(wp, out);
  return out;
}

/** Local search for W,B,W,B,W king moves (optimal by the local depth) returning to (wk, bk) with Black to move. */
function localTriangle(t: Depths, wk: Sq, bk: Sq): string[] | null {
  const ix = (stm: number, a: Sq, b: Sq): number => (stm * 64 + a) * 64 + b;
  const dv = (stm: number, a: Sq, b: Sq): number => t.d[ix(stm, a, b)] ?? INF;
  // Locally optimal white king moves; a capture ends the line, so when only a capture is optimal there is no triangle.
  const wOpt = (a: Sq, b: Sq): Sq[] => {
    const ms = t.s.whiteMoves(a, b).filter((m) => m.res === 1);
    const val = (m: { to: Sq; capture: boolean }): number => (m.capture ? 1 : 1 + dv(1, m.to, b));
    const best = Math.min(...ms.map(val));
    return ms.filter((m) => !m.capture && val(m) === best).map((m) => m.to);
  };
  const bOpt = (a: Sq, b: Sq): Sq[] => {
    const ms = t.s.blackMoves(a, b).filter((m) => !m.capture);
    const worst = Math.max(...ms.map((m) => dv(0, a, m.to)));
    return ms.filter((m) => dv(0, a, m.to) === worst).map((m) => m.to);
  };
  for (const w1 of wOpt(wk, bk))
    for (const b1 of bOpt(w1, bk))
      for (const w2 of wOpt(w1, b1))
        for (const b2 of bOpt(w2, b1)) {
          if (b2 !== bk) continue;
          for (const w3 of wOpt(w2, b2)) if (w3 === wk) return [uci(wk, w1), uci(bk, b1), uci(w1, w2), uci(b1, b2), uci(w2, w3)];
        }
  return null;
}

const triangulation: Generator = {
  concept: 'endgames/pawn/triangulation',
  property:
    'K+P vs K+P (blocked pawns), attacker to move and winning; following DTM-optimal attacker moves and longest-resistance defence ' +
    '(tablebase move lists at every ply) the line returns to the same placement with the defender to move after 5 plies, ' +
    'and that placement with the defender to move is a tablebase loss whose DTM is exactly 5 plies shorter.',
  buckets: { triangle: 1 },
  probeFactor: 2.5,
  candidate(rng) {
    const t = depths(sq(ri(rng, 0, 7), ri(rng, 1, 4)));
    const wk = near(rng, t.s.wp, 1, 3);
    const bk = near(rng, t.s.bp, 1, 3);
    if (wk < 0 || bk < 0 || !t.s.legal('w', wk, bk) || !t.s.legal('b', wk, bk)) return null;
    if (t.s.result('w', wk, bk) !== 1 || t.s.result('b', wk, bk) !== 1) return null;
    // Locally, losing the tempo must be the fastest plan: depth(attacker to move) = 5 + depth(defender to move).
    const ix = (stm: number): number => (stm * 64 + wk) * 64 + bk;
    if ((t.d[ix(0)] ?? INF) !== 5 + (t.d[ix(1)] ?? INF)) return null;
    const line = localTriangle(t, wk, bk);
    if (!line) return null;
    const fen = blockedFen(t.s, wk, bk, 'w');
    return fen ? { fen, bucket: 'triangle', d: { wk, bk }, move: line.join(' ') } : null;
  },
  async accept(c, p, ctx) {
    if (p.category !== 'win' || !c.move || p.dtm === null) return null;
    const line = c.move.split(' ');
    // Cheap test first: the same placement with the defender to move is lost exactly 5 plies closer to mate.
    const swapped = await ctx.probe(withStm(c.fen, 'b'));
    if (!swapped || swapped.category !== 'loss' || swapped.dtm !== -(p.dtm - line.length)) return null;
    let fen = c.fen;
    let probe: TbProbeOk | null = p;
    for (let i = 0; i < line.length; i++) {
      const mv = line[i] ?? '';
      if (!probe) return null;
      const opt = optimalMoves(probe);
      if (opt.by !== 'dtm' || !opt.moves.some((m) => m.uci === mv)) return null;
      const next = afterMove(fen, mv);
      if (!next) return null;
      fen = next;
      probe = i < line.length - 1 ? await ctx.probe(fen) : null;
    }
    // Same placement, defender to move: the last attacker move in the line was winning, so this is a defender loss.
    if (fen.split(' ')[0] !== c.fen.split(' ')[0]) return null;
    return { bucket: 'triangle', playout: true };
  },
};

export const zugzwangGenerators: Generator[] = [zugzwang];

/**
 * Not part of the build: within the time box no blocked K+P vs K+P placement was found whose local
 * depth model makes the 5-ply tempo-losing triangle the fastest plan (local filter yields 0 candidates;
 * an earlier filter yielded 200 candidates, all refuted by the tablebase because a direct capture was faster).
 * Kept for future work; the concept ships zero items (see TRIANGULATION_UNVERIFIED in build.ts).
 */
export const triangulationExperimental = triangulation;
