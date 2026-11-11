/** Tactics pack codec: compact tuples <-> TacticItem, rating-band shard keys, and the shown puzzle position. */
import { Chess } from 'chess.js';
import { tryMove } from '../engine/chessUtil';
import type { TacticItem, TacticTuple } from './types';

/** Shards cover 200 rating points each; ratings outside [MIN, MAX + 199] are clamped into the edge bands. */
export const TACTIC_BAND_SIZE = 200;
export const TACTIC_BAND_MIN = 400;
export const TACTIC_BAND_MAX = 2800;

/** Start of the 200-point band a rating falls in (clamped to the shipped range). */
export function bandStartForRating(rating: number): number {
  const start = Math.floor(rating / TACTIC_BAND_SIZE) * TACTIC_BAND_SIZE;
  return Math.min(TACTIC_BAND_MAX, Math.max(TACTIC_BAND_MIN, start));
}

/** Shard key for a rating: the band start as a string, e.g. 1234 -> "1200". */
export function bandKeyForRating(rating: number): string {
  return String(bandStartForRating(rating));
}

/** Shard file name for a band key, e.g. "800" -> "r0800.json". */
export function bandFileForKey(key: string): string {
  return `r${key.padStart(4, '0')}.json`;
}

/** All band keys in ascending order (some may be absent from a given pack; check pack.json). */
export function allBandKeys(): string[] {
  const keys: string[] = [];
  for (let b = TACTIC_BAND_MIN; b <= TACTIC_BAND_MAX; b += TACTIC_BAND_SIZE) keys.push(String(b));
  return keys;
}

const words = (s: string): string[] => (s ? s.split(' ').filter(Boolean) : []);

export function decodeTactic(tuple: TacticTuple): TacticItem {
  const [id, fen, moves, rating, rd, themes, openingTags] = tuple;
  return { id, fen, moves: words(moves), rating, rd, themes: words(themes), openingTags: words(openingTags) };
}

export function encodeTactic(item: TacticItem): TacticTuple {
  return [item.id, item.fen, item.moves.join(' '), item.rating, item.rd, item.themes.join(' '), item.openingTags.join(' ')];
}

/**
 * The position the user actually solves: `item.fen` with the opponent's first move applied.
 * Throws when the FEN or the first move is invalid (never the case for items from a built pack,
 * which the pipeline validates with chess.js).
 */
export function positionAfterFirstMove(item: TacticItem): { fen: string; userColor: 'w' | 'b' } {
  const first = item.moves[0];
  if (!first) throw new Error(`tactic ${item.id}: no moves`);
  const chess = new Chess(item.fen);
  if (!tryMove(chess, first)) throw new Error(`tactic ${item.id}: illegal first move ${first}`);
  return { fen: chess.fen(), userColor: chess.turn() };
}
