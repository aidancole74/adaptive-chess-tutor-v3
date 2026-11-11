/** Shared helpers for the traps and cards stages: a representative line from the start position to every book position. */
import { Chess } from 'chess.js';
import type { BookShard, BookStat } from '../../src/content/types';
import { START_FEN, epdOf, parseUci } from '../../src/engine/chessUtil';

export interface PositionLine {
  fen: string;
  line: string[];
}

/** Sums the move statistics of several shards (all bands) into one position map. */
export function mergeShards(shards: BookShard[]): Record<string, Record<string, BookStat>> {
  const out: Record<string, Record<string, BookStat>> = {};
  for (const s of shards) {
    for (const epd in s.positions) {
      const src = s.positions[epd];
      if (!src) continue;
      const dst = (out[epd] ??= {});
      for (const uci in src) {
        const a = src[uci];
        if (!a) continue;
        const b = dst[uci];
        dst[uci] = b ? [b[0] + a[0], b[1] + a[1], b[2] + a[2], b[3] + a[3]] : [a[0], a[1], a[2], a[3]];
      }
    }
  }
  return out;
}

export function positionGames(moves: Record<string, BookStat> | undefined): number {
  let t = 0;
  if (moves) for (const u in moves) t += moves[u]?.[0] ?? 0;
  return t;
}

/**
 * Breadth-first walk of the book from the start position. Each position gets the line of its first visit at the
 * smallest ply; within a ply, parents and moves are processed most-played first, so the line is the most common
 * order the book can show. Positions reached only through pruned moves are absent. Includes leaf positions
 * (e.g. after ply 14) that have no moves of their own.
 */
export function bookLines(positions: Record<string, Record<string, BookStat>>, maxPly = 14): Map<string, PositionLine> {
  const out = new Map<string, PositionLine>();
  const startEpd = epdOf(START_FEN);
  out.set(startEpd, { fen: START_FEN, line: [] });
  let level: string[] = [startEpd];
  const chess = new Chess();
  for (let ply = 0; ply < maxPly && level.length; ply++) {
    level.sort((a, b) => positionGames(positions[b]) - positionGames(positions[a]));
    const next: string[] = [];
    for (const epd of level) {
      const moves = positions[epd];
      const from = out.get(epd);
      if (!moves || !from) continue;
      const ordered = Object.entries(moves).sort((a, b) => b[1][0] - a[1][0]);
      for (const [uci] of ordered) {
        try {
          chess.load(from.fen);
          chess.move(parseUci(uci));
        } catch {
          continue;
        }
        const fen = chess.fen();
        const e = epdOf(fen);
        if (out.has(e)) continue;
        out.set(e, { fen, line: [...from.line, uci] });
        next.push(e);
      }
    }
    level = next;
  }
  return out;
}

/** Small stable hash for ids. */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}
