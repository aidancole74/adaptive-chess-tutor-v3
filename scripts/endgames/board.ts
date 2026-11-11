/** Board helpers for the procedural endgame generators: squares, FEN assembly, symmetry transforms, legality. */
import { Chess } from 'chess.js';

/** Square index 0..63 with a1 = 0, h1 = 7, a8 = 56. */
export type Sq = number;
export type Rng = () => number;
export type Placement = [piece: string, sq: Sq][];

export const F = (s: Sq): number => s & 7;
export const R = (s: Sq): number => s >> 3;
export const sq = (file: number, rank: number): Sq => rank * 8 + file;
export const onBoard = (file: number, rank: number): boolean => file >= 0 && file < 8 && rank >= 0 && rank < 8;
export const sqName = (s: Sq): string => 'abcdefgh'.charAt(F(s)) + String(R(s) + 1);
export const sqOf = (name: string): Sq => sq(name.charCodeAt(0) - 97, name.charCodeAt(1) - 49);
export const dist = (a: Sq, b: Sq): number => Math.max(Math.abs(F(a) - F(b)), Math.abs(R(a) - R(b)));
/** 0 = dark square (a1), 1 = light square. */
export const colourOf = (s: Sq): number => (F(s) + R(s)) & 1;
export const between = (x: number, a: number, b: number): boolean => x > Math.min(a, b) && x < Math.max(a, b);
export const uci = (from: Sq, to: Sq): string => sqName(from) + sqName(to);

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Integer in [lo, hi]. */
export const ri = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
export const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;
export const randSq = (rng: Rng): Sq => ri(rng, 0, 63);

/** Random square within Chebyshev distance [lo, hi] of `c`, or -1 when none exists. */
export function near(rng: Rng, c: Sq, lo: number, hi: number): Sq {
  const opts: Sq[] = [];
  for (let s = 0; s < 64; s++) {
    const d = dist(s, c);
    if (d >= lo && d <= hi) opts.push(s);
  }
  return opts.length ? pick(rng, opts) : -1;
}

/** Builds a FEN (no castling, no en passant, counters "0 1"). Null on overlapping / off-board squares. */
export function fenOf(pl: Placement, stm: 'w' | 'b'): string | null {
  const board = new Array<string>(64).fill('');
  for (const [p, s] of pl) {
    if (!Number.isInteger(s) || s < 0 || s > 63 || board[s] !== '') return null;
    if ((p === 'P' || p === 'p') && (R(s) === 0 || R(s) === 7)) return null;
    board[s] = p;
  }
  const rows: string[] = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = board[sq(f, r)] ?? '';
      if (p === '') empty++;
      else {
        if (empty) row += empty;
        empty = 0;
        row += p;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${stm} - - 0 1`;
}

/** Piece letters by square index ('' = empty). */
export function boardOf(fen: string): string[] {
  const board = new Array<string>(64).fill('');
  const rows = (fen.split(' ')[0] ?? '').split('/');
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') f += Number(ch);
      else board[sq(f++, 7 - i)] = ch;
    }
  });
  return board;
}

export function placementOf(fen: string): Placement {
  const out: Placement = [];
  boardOf(fen).forEach((p, s) => {
    if (p) out.push([p, s]);
  });
  return out;
}

export const stmOf = (fen: string): 'w' | 'b' => (fen.split(' ')[1] === 'b' ? 'b' : 'w');

export function withStm(fen: string, stm: 'w' | 'b'): string {
  return `${fen.split(' ')[0] ?? ''} ${stm} - - 0 1`;
}

/**
 * A usable start position: parses in chess.js, the side NOT to move is not in check, and the
 * game is not already over (mate, stalemate, insufficient material).
 */
export function legalStart(fen: string): boolean {
  try {
    const c = new Chess(fen);
    if (c.isGameOver() || c.moves().length === 0) return false;
    const other = new Chess(withStm(fen, stmOf(fen) === 'w' ? 'b' : 'w'));
    return !other.isCheck();
  } catch {
    return false;
  }
}

/** Position after a UCI move, with counters reset ("0 1") and no en-passant square. Null when illegal. */
export function afterMove(fen: string, move: string): string | null {
  try {
    const c = new Chess(fen);
    c.move({ from: move.slice(0, 2), to: move.slice(2, 4), promotion: move.length > 4 ? move.charAt(4) : undefined });
    return withStm(c.fen(), c.turn());
  } catch {
    return null;
  }
}

/** Verbose legal moves in the position (empty when the FEN is invalid). */
export function legalMoves(fen: string): { from: Sq; to: Sq; piece: string; captured: boolean; uci: string }[] {
  try {
    return new Chess(fen).moves({ verbose: true }).map((m) => ({
      from: sqOf(m.from),
      to: sqOf(m.to),
      piece: m.piece,
      captured: m.captured !== undefined,
      uci: m.from + m.to + (m.promotion ?? ''),
    }));
  } catch {
    return [];
  }
}

/* ---------- symmetry: colour flip (ranks mirrored + colours swapped) and file mirror ---------- */

export interface Xf {
  flip: boolean;
  mirror: boolean;
}

export const xfSq = (s: Sq, xf: Xf): Sq => sq(xf.mirror ? 7 - F(s) : F(s), xf.flip ? 7 - R(s) : R(s));

/** Both transforms are involutions and commute, so the same Xf maps back. Valid without castling / en passant. */
export function xfUci(move: string, xf: Xf): string {
  return sqName(xfSq(sqOf(move.slice(0, 2)), xf)) + sqName(xfSq(sqOf(move.slice(2, 4)), xf)) + move.slice(4);
}

const swapCase = (p: string): string => (p === p.toUpperCase() ? p.toLowerCase() : p.toUpperCase());

export function xfFen(fen: string, xf: Xf): string {
  const pl: Placement = placementOf(fen).map(([p, s]) => [xf.flip ? swapCase(p) : p, xfSq(s, xf)]);
  const stm = stmOf(fen);
  const out = fenOf(pl, xf.flip ? (stm === 'w' ? 'b' : 'w') : stm);
  if (out === null) throw new Error(`cannot transform ${fen}`);
  return out;
}

/** Symmetry-independent identity of a position (minimum over the four transforms). */
export function canonicalKey(fen: string): string {
  let best = '';
  for (const flip of [false, true]) {
    for (const mirror of [false, true]) {
      const k = xfFen(fen, { flip, mirror }).split(' ').slice(0, 2).join(' ');
      if (best === '' || k < best) best = k;
    }
  }
  return best;
}
