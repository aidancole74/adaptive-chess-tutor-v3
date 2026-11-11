/**
 * Minimal array board used by the feature extractors and motif detectors.
 * It is NOT a rules engine: there is no legality checking (pins, checks). Callers that need
 * legality use chess.js; this module exists so that static scans cost microseconds.
 *
 * Squares are 0..63 with a1 = 0, h1 = 7, a8 = 56. Pieces are signed: white > 0, black < 0.
 */
import type { Side } from './types';

export const PAWN = 1;
export const KNIGHT = 2;
export const BISHOP = 3;
export const ROOK = 4;
export const QUEEN = 5;
export const KING = 6;

/** 1 for White, -1 for Black. */
export type Sign = 1 | -1;

export interface Board {
  sq: Int8Array;
  turn: Side;
  castling: string;
  /** En-passant target square index or -1. */
  ep: number;
  halfmove: number;
  fullmove: number;
}

/** Piece values in pawns, indexed by piece type (king = 100 so it is always the most valuable target). */
export const PIECE_VALUE: readonly number[] = [0, 1, 3, 3, 5, 9, 100];
export const PIECE_NAME: readonly string[] = ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];

const PIECE_CHARS = ' pnbrqk';
const FILES = 'abcdefgh';

export function signOf(side: Side): Sign {
  return side === 'w' ? 1 : -1;
}
export function sideOf(sign: number): Side {
  return sign > 0 ? 'w' : 'b';
}
export function fileOf(s: number): number {
  return s & 7;
}
export function rankOf(s: number): number {
  return s >> 3;
}
export function sqName(s: number): string {
  return FILES.charAt(s & 7) + String((s >> 3) + 1);
}
/** Returns -1 for anything that is not a square name. */
export function sqIndex(name: string): number {
  const f = name.charCodeAt(0) - 97;
  const r = name.charCodeAt(1) - 49;
  if (name.length < 2 || f < 0 || f > 7 || r < 0 || r > 7) return -1;
  return r * 8 + f;
}
export function pieceAt(sq: Int8Array, s: number): number {
  return sq[s] ?? 0;
}
export function typeAt(sq: Int8Array, s: number): number {
  const p = sq[s] ?? 0;
  return p < 0 ? -p : p;
}

/* ---------- precomputed geometry ---------- */

/** Direction order: 0..3 orthogonal (N, S, E, W), 4..7 diagonal (NE, NW, SE, SW). */
const DIRS: readonly (readonly [number, number])[] = [
  [0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, 1], [1, -1], [-1, -1],
];
const KNIGHT_STEPS: readonly (readonly [number, number])[] = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];

/** RAYS[s][d] = squares from s outward in direction d, nearest first. */
export const RAYS: readonly (readonly (readonly number[])[])[] = [];
export const KNIGHT_TARGETS: readonly (readonly number[])[] = [];
export const KING_TARGETS: readonly (readonly number[])[] = [];
{
  const rays = RAYS as number[][][];
  const kn = KNIGHT_TARGETS as number[][];
  const kg = KING_TARGETS as number[][];
  for (let s = 0; s < 64; s++) {
    const f = s & 7;
    const r = s >> 3;
    const perDir: number[][] = [];
    const king: number[] = [];
    for (const [df, dr] of DIRS) {
      const ray: number[] = [];
      let nf = f + df;
      let nr = r + dr;
      while (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) {
        ray.push(nr * 8 + nf);
        nf += df;
        nr += dr;
      }
      perDir.push(ray);
      if (ray.length > 0) king.push(ray[0]!);
    }
    rays.push(perDir);
    kg.push(king);
    const knight: number[] = [];
    for (const [df, dr] of KNIGHT_STEPS) {
      const nf = f + df;
      const nr = r + dr;
      if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) knight.push(nr * 8 + nf);
    }
    kn.push(knight);
  }
}

/** Ray direction indices a slider of the given type moves along (empty for non-sliders). */
export function sliderDirs(type: number): readonly number[] {
  if (type === BISHOP) return DIAG_DIRS;
  if (type === ROOK) return ORTHO_DIRS;
  if (type === QUEEN) return ALL_DIRS;
  return NO_DIRS;
}
const ORTHO_DIRS: readonly number[] = [0, 1, 2, 3];
const DIAG_DIRS: readonly number[] = [4, 5, 6, 7];
const ALL_DIRS: readonly number[] = [0, 1, 2, 3, 4, 5, 6, 7];
const NO_DIRS: readonly number[] = [];

/** The direction index pointing the opposite way. */
export function oppositeDir(d: number): number {
  return d ^ 1 ^ (d >= 4 ? 2 : 0);
}

/* ---------- FEN ---------- */

export function parseFen(fen: string): Board {
  const parts = fen.trim().split(/\s+/);
  const sq = new Int8Array(64);
  const placement = parts[0] ?? '';
  let f = 0;
  let r = 7;
  for (let i = 0; i < placement.length; i++) {
    const ch = placement.charAt(i);
    if (ch === '/') {
      r--;
      f = 0;
    } else if (ch >= '1' && ch <= '8') {
      f += ch.charCodeAt(0) - 48;
    } else {
      const t = PIECE_CHARS.indexOf(ch.toLowerCase());
      if (t > 0 && f < 8 && r >= 0) sq[r * 8 + f] = ch === ch.toLowerCase() ? -t : t;
      f++;
    }
  }
  return {
    sq,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling: parts[2] ?? '-',
    ep: parts[3] && parts[3] !== '-' ? sqIndex(parts[3]) : -1,
    halfmove: Number(parts[4] ?? 0) || 0,
    fullmove: Number(parts[5] ?? 1) || 1,
  };
}

export function toFen(b: Board): string {
  let out = '';
  for (let r = 7; r >= 0; r--) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = b.sq[r * 8 + f] ?? 0;
      if (p === 0) {
        empty++;
        continue;
      }
      if (empty > 0) {
        out += String(empty);
        empty = 0;
      }
      const ch = PIECE_CHARS.charAt(p < 0 ? -p : p);
      out += p > 0 ? ch.toUpperCase() : ch;
    }
    if (empty > 0) out += String(empty);
    if (r > 0) out += '/';
  }
  return `${out} ${b.turn} ${b.castling || '-'} ${b.ep >= 0 ? sqName(b.ep) : '-'} ${b.halfmove} ${b.fullmove}`;
}

/**
 * Applies a UCI move without checking legality (castling, en passant and promotion are handled).
 * Returns null when the from-square does not hold a piece of the side to move.
 * The en-passant square is set after every double pawn push (chess.js only sets it when a capture
 * is possible), so compare positions through the placement field, not the whole FEN.
 */
export function applyUci(b: Board, uci: string): Board | null {
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  if (from < 0 || to < 0) return null;
  const sign = signOf(b.turn);
  const piece = b.sq[from] ?? 0;
  if (piece === 0 || piece * sign < 0) return null;
  const type = piece * sign;
  const sq = b.sq.slice();
  const captured = sq[to] ?? 0;
  let ep = -1;
  let isCapture = captured !== 0;
  sq[from] = 0;
  sq[to] = piece;
  if (type === PAWN) {
    if (to === b.ep && fileOf(from) !== fileOf(to) && captured === 0) {
      sq[to - 8 * sign] = 0;
      isCapture = true;
    }
    if (Math.abs(to - from) === 16) ep = from + 8 * sign;
    const promo = uci.length > 4 ? PIECE_CHARS.indexOf(uci.charAt(4).toLowerCase()) : 0;
    const lastRank = sign > 0 ? 7 : 0;
    if (rankOf(to) === lastRank) sq[to] = sign * (promo > 1 ? promo : QUEEN);
  } else if (type === KING && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    const rank = rankOf(from) * 8;
    if (fileOf(to) === 6) {
      sq[rank + 5] = sq[rank + 7] ?? 0;
      sq[rank + 7] = 0;
    } else {
      sq[rank + 3] = sq[rank] ?? 0;
      sq[rank] = 0;
    }
  }
  let castling = b.castling;
  if (castling !== '-') {
    const strip = (chars: string): void => {
      for (const c of chars) castling = castling.replace(c, '');
    };
    if (type === KING) strip(sign > 0 ? 'KQ' : 'kq');
    for (const s of [from, to]) {
      if (s === 0) strip('Q');
      else if (s === 7) strip('K');
      else if (s === 56) strip('q');
      else if (s === 63) strip('k');
    }
    if (castling === '') castling = '-';
  }
  return {
    sq,
    turn: b.turn === 'w' ? 'b' : 'w',
    castling,
    ep,
    halfmove: type === PAWN || isCapture ? 0 : b.halfmove + 1,
    fullmove: b.fullmove + (b.turn === 'b' ? 1 : 0),
  };
}

/* ---------- attacks ---------- */

/**
 * Squares attacked (or defended: own-occupied squares are included) by the piece on `from`.
 * Pawns return their capture squares only. Sliders stop at the first piece in each direction.
 */
export function attacksFrom(sq: Int8Array, from: number): number[] {
  const piece = sq[from] ?? 0;
  const out: number[] = [];
  if (piece === 0) return out;
  const sign = piece > 0 ? 1 : -1;
  const type = piece * sign;
  if (type === PAWN) {
    const f = from & 7;
    const fwd = from + 8 * sign;
    if (fwd >= 0 && fwd < 64) {
      if (f > 0) out.push(fwd - 1);
      if (f < 7) out.push(fwd + 1);
    }
    return out;
  }
  if (type === KNIGHT) return KNIGHT_TARGETS[from]!.slice();
  if (type === KING) return KING_TARGETS[from]!.slice();
  const rays = RAYS[from]!;
  for (const d of sliderDirs(type)) {
    const ray = rays[d]!;
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i]!;
      out.push(s);
      if (sq[s] !== 0) break;
    }
  }
  return out;
}

/** Squares of the pieces of `by` that attack `target` (no x-rays; pins are ignored). */
export function attackersOf(sq: Int8Array, target: number, by: Sign): number[] {
  const out: number[] = [];
  const f = target & 7;
  // A pawn of `by` attacks target from one rank behind (from its own point of view).
  const back = target - 8 * by;
  if (back >= 0 && back < 64) {
    if (f > 0 && sq[back - 1] === by * PAWN) out.push(back - 1);
    if (f < 7 && sq[back + 1] === by * PAWN) out.push(back + 1);
  }
  for (const s of KNIGHT_TARGETS[target]!) if (sq[s] === by * KNIGHT) out.push(s);
  for (const s of KING_TARGETS[target]!) if (sq[s] === by * KING) out.push(s);
  const rays = RAYS[target]!;
  for (let d = 0; d < 8; d++) {
    const ray = rays[d]!;
    for (let i = 0; i < ray.length; i++) {
      const s = ray[i]!;
      const p = sq[s]!;
      if (p === 0) continue;
      const t = p * by;
      if (t === QUEEN || t === (d < 4 ? ROOK : BISHOP)) out.push(s);
      break;
    }
  }
  return out;
}

export function isAttacked(sq: Int8Array, target: number, by: Sign): boolean {
  return attackersOf(sq, target, by).length > 0;
}

export function findKing(sq: Int8Array, sign: Sign): number {
  for (let s = 0; s < 64; s++) if (sq[s] === sign * KING) return s;
  return -1;
}

/* ---------- static exchange evaluation ---------- */

/**
 * Static exchange evaluation on the array board: material (in pawns) that `side` wins by starting
 * a capture sequence on `target`, both sides always recapturing with their least valuable attacker
 * and free to stop. 0 when there is nothing to take or no profitable capture.
 * X-ray attackers are uncovered as pieces are removed. Pins and promotions are ignored; a king
 * only captures when the square is no longer attacked.
 */
export function seeOnBoard(sqIn: Int8Array, target: number, side: Sign): number {
  const victim = sqIn[target] ?? 0;
  if (victim === 0 || victim * side > 0) return 0;
  return seeLoop(sqIn.slice(), target, side);
}

/**
 * Net material (in pawns, may be negative) won by the specific capture from -> to, assuming the
 * opponent then answers optimally on that square. En passant counts as winning a pawn.
 */
export function seeCapture(sqIn: Int8Array, from: number, to: number, ep = -1): number {
  const piece = sqIn[from] ?? 0;
  if (piece === 0) return 0;
  const sign: Sign = piece > 0 ? 1 : -1;
  const sq = sqIn.slice();
  let gain = PIECE_VALUE[typeAt(sq, to)] ?? 0;
  if (piece * sign === PAWN && to === ep && gain === 0 && fileOf(from) !== fileOf(to)) {
    sq[to - 8 * sign] = 0;
    gain = 1;
  }
  sq[to] = piece;
  sq[from] = 0;
  return gain - seeLoop(sq, to, -sign as Sign);
}

function seeLoop(sq: Int8Array, target: number, first: Sign): number {
  const gains: number[] = [];
  let side: Sign = first;
  for (;;) {
    const attackers = attackersOf(sq, target, side);
    if (attackers.length === 0) break;
    let best = attackers[0]!;
    for (const a of attackers) if (PIECE_VALUE[typeAt(sq, a)]! < PIECE_VALUE[typeAt(sq, best)]!) best = a;
    const occupant = sq[target]!;
    const mover = sq[best]!;
    sq[target] = mover;
    sq[best] = 0;
    if (mover * side === KING && attackersOf(sq, target, -side as Sign).length > 0) break;
    gains.push(PIECE_VALUE[occupant < 0 ? -occupant : occupant]!);
    side = -side as Sign;
  }
  let v = 0;
  for (let i = gains.length - 1; i >= 0; i--) v = Math.max(0, gains[i]! - v);
  return v;
}
