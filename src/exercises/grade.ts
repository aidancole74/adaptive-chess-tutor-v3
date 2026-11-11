/** Pure grading for every interaction kind. */
import { Chess } from 'chess.js';
import { tryMove } from '../engine/chessUtil';
import type { ChoiceInteraction, LineInteraction, SetInteraction } from './types';

const norm = (uci: string): string => uci.trim().toLowerCase();

/** Number of moves the user must play in a line interaction. */
export function userPlies(it: LineInteraction): number {
  return Math.ceil(it.solution.length / 2);
}

/** Position the user faces at the start (fen + preMoves). Null if the content is broken. */
export function lineStart(it: LineInteraction): Chess | null {
  try {
    const chess = new Chess(it.fen);
    for (const m of it.preMoves) if (!tryMove(chess, m)) return null;
    return chess;
  } catch {
    return null;
  }
}

/**
 * Is `uci` accepted as the user's move number `ply` (0-based) in the position `fenBefore`?
 * Accepts the solution move, listed alternatives, and (when enabled) any move that checkmates.
 */
export function lineMoveOk(it: LineInteraction, ply: number, uci: string, fenBefore: string): boolean {
  const u = norm(uci);
  const expected = it.solution[ply * 2];
  if (expected && norm(expected) === u) return true;
  if (it.alternatives?.[ply]?.some((a) => norm(a) === u)) return true;
  if (it.acceptAnyMate) {
    const chess = new Chess(fenBefore);
    if (tryMove(chess, u) && chess.isCheckmate()) return true;
  }
  return false;
}

/** Score for a line: 1 clean, reduced by hints; partial credit (max 0.5) for a failed line. */
export function lineScore(totalPlies: number, correctPlies: number, failed: boolean, hintsUsed: number): { score: number; solved: boolean } {
  if (failed) return { score: totalPlies > 0 ? (0.5 * correctPlies) / totalPlies : 0, solved: false };
  const score = hintsUsed === 0 ? 1 : hintsUsed === 1 ? 0.7 : 0.4;
  return { score, solved: true };
}

export function gradeChoice(it: ChoiceInteraction, chosen: string[]): { solved: boolean; score: number } {
  const correct = new Set(it.correct);
  const picked = new Set(chosen);
  if (!it.multi) {
    const ok = picked.size === 1 && correct.has(chosen[0]!);
    return { solved: ok, score: ok ? 1 : 0 };
  }
  let hit = 0;
  let wrong = 0;
  for (const c of picked) {
    if (correct.has(c)) hit++;
    else wrong++;
  }
  const solved = hit === correct.size && wrong === 0;
  const score = solved ? 1 : Math.max(0, (hit - wrong) / Math.max(1, correct.size)) * 0.8;
  return { solved, score };
}

const FILES = 'abcdefgh';
export function isSquare(s: string): boolean {
  return /^[a-h][1-8]$/.test(s);
}
export function isLightSquare(sq: string): boolean {
  return (FILES.indexOf(sq[0]!) + Number(sq[1])) % 2 === 0;
}
export function knightNeighbours(sq: string): string[] {
  const f = FILES.indexOf(sq[0]!);
  const r = Number(sq[1]) - 1;
  const out: string[] = [];
  for (const [df, dr] of [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const) {
    const nf = f + df;
    const nr = r + dr;
    if (nf >= 0 && nf < 8 && nr >= 0 && nr < 8) out.push(`${FILES[nf]}${nr + 1}`);
  }
  return out;
}
/** Shortest knight path on an empty board (BFS), including both endpoints. */
export function shortestKnightPath(from: string, to: string): string[] {
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const n of knightNeighbours(cur)) {
      if (!prev.has(n)) {
        prev.set(n, cur);
        queue.push(n);
      }
    }
  }
  const path: string[] = [];
  for (let c: string | null = to; c; c = prev.get(c) ?? null) path.unshift(c);
  return path;
}

export interface SetGrade {
  solved: boolean;
  score: number;
  missing: string[];
  wrong: string[];
}

export function gradeSet(it: SetInteraction, entries: string[]): SetGrade {
  const given = [...new Set(entries.map(norm))];
  if (it.mode === 'path') {
    // Any legal knight path of minimal length from `from` to `to` is accepted.
    const from = it.from ?? it.expected[0]!;
    const to = it.to ?? it.expected[it.expected.length - 1]!;
    const path = entries.map(norm);
    const full = path[0] === from ? path : [from, ...path];
    let legal = full[full.length - 1] === to;
    for (let i = 1; i < full.length && legal; i++) legal = knightNeighbours(full[i - 1]!).includes(full[i]!);
    const minimal = shortestKnightPath(from, to).length;
    const solved = legal && full.length === minimal;
    return { solved, score: solved ? 1 : legal ? 0.5 : 0, missing: solved ? [] : it.expected, wrong: [] };
  }
  const expected = new Set(it.expected.map(norm));
  const wrong = given.filter((g) => !expected.has(g));
  const missing = [...expected].filter((e) => !given.includes(e));
  const frac = expected.size === 0 ? (wrong.length === 0 ? 1 : 0) : (expected.size - missing.length) / expected.size;
  const solved = frac >= it.passFraction && wrong.length <= it.maxWrong;
  const score = Math.max(0, frac - 0.15 * wrong.length);
  return { solved, score: solved ? Math.max(score, 0.6) : Math.min(score, 0.5), missing, wrong };
}
