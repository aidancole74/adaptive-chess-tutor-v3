/**
 * Small local retrograde solvers used ONLY to pre-filter candidates (so that few tablebase
 * requests are wasted). Nothing computed here is shipped: every kept position and every claim is
 * re-verified against the Lichess tablebase. The solvers are deliberately approximate at the
 * edges (promotion is treated as won unless the new queen can be captured at once).
 */
import { F, R, dist, type Sq } from './board';

const KM: Sq[][] = [];
for (let s = 0; s < 64; s++) {
  const out: Sq[] = [];
  for (let t = 0; t < 64; t++) if (t !== s && dist(s, t) === 1) out.push(t);
  KM.push(out);
}
export const kingMoves = (s: Sq): readonly Sq[] => KM[s] ?? [];

const adj = (a: Sq, b: Sq): boolean => dist(a, b) <= 1;
/** Does a white pawn on p attack s? */
export const wpAtt = (p: Sq, s: Sq): boolean => R(s) === R(p) + 1 && Math.abs(F(s) - F(p)) === 1;
/** Does a black pawn on p attack s? */
export const bpAtt = (p: Sq, s: Sq): boolean => R(s) === R(p) - 1 && Math.abs(F(s) - F(p)) === 1;

/* ---------- K+P (white) vs K: win / not-win bitbase ---------- */

const kIdx = (stm: number, wk: Sq, bk: Sq, p: Sq): number => ((stm * 64 + wk) * 64 + bk) * 64 + p;
let kpk: Uint8Array | null = null;

export function kpkLegal(stm: 'w' | 'b', wk: Sq, bk: Sq, p: Sq): boolean {
  if (wk === bk || wk === p || bk === p || adj(wk, bk)) return false;
  if (R(p) < 1 || R(p) > 6) return false;
  return !(stm === 'w' && wpAtt(p, bk));
}

export interface LocalMove {
  from: Sq;
  to: Sq;
  /** True when the move keeps a white win (white moves) / when White still wins after it (black moves). */
  whiteWins: boolean;
  pawn: boolean;
  capture: boolean;
}

function kpkWhiteMovesRaw(win: Uint8Array, wk: Sq, bk: Sq, p: Sq): LocalMove[] {
  const out: LocalMove[] = [];
  for (const t of kingMoves(wk)) {
    if (t === p || adj(t, bk)) continue;
    out.push({ from: wk, to: t, whiteWins: win[kIdx(1, t, bk, p)] === 1, pawn: false, capture: false });
  }
  const t1 = p + 8;
  if (t1 !== wk && t1 !== bk) {
    if (R(t1) === 7) out.push({ from: p, to: t1, whiteWins: !(adj(bk, t1) && !adj(wk, t1)), pawn: true, capture: false });
    else {
      out.push({ from: p, to: t1, whiteWins: win[kIdx(1, wk, bk, t1)] === 1, pawn: true, capture: false });
      const t2 = p + 16;
      if (R(p) === 1 && t2 !== wk && t2 !== bk) out.push({ from: p, to: t2, whiteWins: win[kIdx(1, wk, bk, t2)] === 1, pawn: true, capture: false });
    }
  }
  return out;
}

function kpkBlackMovesRaw(win: Uint8Array, wk: Sq, bk: Sq, p: Sq): LocalMove[] {
  const out: LocalMove[] = [];
  for (const t of kingMoves(bk)) {
    if (adj(t, wk) || wpAtt(p, t)) continue;
    if (t === p) out.push({ from: bk, to: t, whiteWins: false, pawn: false, capture: true });
    else out.push({ from: bk, to: t, whiteWins: win[kIdx(0, wk, t, p)] === 1, pawn: false, capture: false });
  }
  return out;
}

function kpkTable(): Uint8Array {
  if (kpk) return kpk;
  const win = new Uint8Array(2 * 64 * 64 * 64);
  let changed = true;
  while (changed) {
    changed = false;
    for (let wk = 0; wk < 64; wk++) {
      for (let bk = 0; bk < 64; bk++) {
        if (wk === bk || adj(wk, bk)) continue;
        for (let p = 8; p < 56; p++) {
          if (p === wk || p === bk) continue;
          if (win[kIdx(0, wk, bk, p)] === 0 && !wpAtt(p, bk) && kpkWhiteMovesRaw(win, wk, bk, p).some((m) => m.whiteWins)) {
            win[kIdx(0, wk, bk, p)] = 1;
            changed = true;
          }
          if (win[kIdx(1, wk, bk, p)] === 0) {
            const ms = kpkBlackMovesRaw(win, wk, bk, p);
            if (ms.length > 0 && ms.every((m) => m.whiteWins)) {
              win[kIdx(1, wk, bk, p)] = 1;
              changed = true;
            }
          }
        }
      }
    }
  }
  kpk = win;
  return win;
}

/** Local estimate: does White (K+P) win? */
export function kpkWin(stm: 'w' | 'b', wk: Sq, bk: Sq, p: Sq): boolean {
  return kpkLegal(stm, wk, bk, p) && kpkTable()[kIdx(stm === 'w' ? 0 : 1, wk, bk, p)] === 1;
}
export const kpkWhiteMoves = (wk: Sq, bk: Sq, p: Sq): LocalMove[] => kpkWhiteMovesRaw(kpkTable(), wk, bk, p);
export const kpkBlackMoves = (wk: Sq, bk: Sq, p: Sq): LocalMove[] => kpkBlackMovesRaw(kpkTable(), wk, bk, p);

/* ---------- K+P vs K+P with the pawns blocked on one file (white pawn on wp, black pawn on wp+8) ---------- */

export interface BlockedSolver {
  wp: Sq;
  bp: Sq;
  legal(stm: 'w' | 'b', wk: Sq, bk: Sq): boolean;
  /** 1 = White wins, 0 = draw, -1 = Black wins (local estimate). */
  result(stm: 'w' | 'b', wk: Sq, bk: Sq): number;
  whiteMoves(wk: Sq, bk: Sq): { to: Sq; res: number; capture: boolean }[];
  blackMoves(wk: Sq, bk: Sq): { to: Sq; res: number; capture: boolean }[];
}

const solvers = new Map<Sq, BlockedSolver>();

export function blockedSolver(wp: Sq): BlockedSolver {
  const cached = solvers.get(wp);
  if (cached) return cached;
  const bp = wp + 8;
  const ww = new Uint8Array(2 * 64 * 64);
  const bw = new Uint8Array(2 * 64 * 64);
  const idx = (stm: number, wk: Sq, bk: Sq): number => (stm * 64 + wk) * 64 + bk;
  const base = (wk: Sq, bk: Sq): boolean => wk !== bk && wk !== wp && wk !== bp && bk !== wp && bk !== bp && !adj(wk, bk);
  const legal = (stm: 'w' | 'b', wk: Sq, bk: Sq): boolean => base(wk, bk) && (stm === 'w' ? !wpAtt(wp, bk) : !bpAtt(bp, wk));
  const res = (stm: number, wk: Sq, bk: Sq): number => (ww[idx(stm, wk, bk)] === 1 ? 1 : bw[idx(stm, wk, bk)] === 1 ? -1 : 0);
  const whiteMoves = (wk: Sq, bk: Sq): { to: Sq; res: number; capture: boolean }[] => {
    const out: { to: Sq; res: number; capture: boolean }[] = [];
    for (const t of kingMoves(wk)) {
      if (t === wp || adj(t, bk) || bpAtt(bp, t)) continue;
      if (t === bp) out.push({ to: t, res: kpkWin('b', t, bk, wp) ? 1 : 0, capture: true });
      else out.push({ to: t, res: res(1, t, bk), capture: false });
    }
    return out;
  };
  const blackMoves = (wk: Sq, bk: Sq): { to: Sq; res: number; capture: boolean }[] => {
    const out: { to: Sq; res: number; capture: boolean }[] = [];
    for (const t of kingMoves(bk)) {
      if (t === bp || adj(t, wk) || wpAtt(wp, t)) continue;
      // Black K+P vs K with White to move: colour-flipped KPK lookup with "black" to move.
      if (t === wp) out.push({ to: t, res: kpkWin('b', t ^ 56, wk ^ 56, bp ^ 56) ? -1 : 0, capture: true });
      else out.push({ to: t, res: res(0, wk, t), capture: false });
    }
    return out;
  };
  let changed = true;
  while (changed) {
    changed = false;
    for (let wk = 0; wk < 64; wk++) {
      for (let bk = 0; bk < 64; bk++) {
        if (!base(wk, bk)) continue;
        const wtm = !wpAtt(wp, bk);
        const btm = !bpAtt(bp, wk);
        const wm = wtm ? whiteMoves(wk, bk) : [];
        const bm = btm ? blackMoves(wk, bk) : [];
        if (wtm) {
          if (ww[idx(0, wk, bk)] === 0 && wm.some((m) => m.res === 1)) {
            ww[idx(0, wk, bk)] = 1;
            changed = true;
          }
          // White to move with no legal move is stalemate here (a lone pawn cannot give mate), never a loss.
          if (bw[idx(0, wk, bk)] === 0 && wm.length > 0 && wm.every((m) => m.res === -1)) {
            bw[idx(0, wk, bk)] = 1;
            changed = true;
          }
        }
        if (btm) {
          if (bw[idx(1, wk, bk)] === 0 && bm.some((m) => m.res === -1)) {
            bw[idx(1, wk, bk)] = 1;
            changed = true;
          }
          if (ww[idx(1, wk, bk)] === 0 && bm.length > 0 && bm.every((m) => m.res === 1)) {
            ww[idx(1, wk, bk)] = 1;
            changed = true;
          }
        }
      }
    }
  }
  const solver: BlockedSolver = {
    wp,
    bp,
    legal,
    result: (stm, wk, bk) => (legal(stm, wk, bk) ? res(stm === 'w' ? 0 : 1, wk, bk) : 0),
    whiteMoves,
    blackMoves,
  };
  solvers.set(wp, solver);
  return solver;
}
