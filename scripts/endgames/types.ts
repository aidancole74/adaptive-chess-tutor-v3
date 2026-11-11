/**
 * Generator contract for the endgame pipeline.
 *
 * Generators work in a fixed "white frame" (White is the side the structure is described for).
 * build.ts applies a random colour flip / file mirror before probing, ships the transformed
 * position, and hands generators a view of the probe mapped back into the white frame. So the
 * shipped FEN is always the one the tablebase was asked about.
 */
import type { TbMove, TbProbeOk } from '../../src/engine/tablebase';
import { boardOf, sqOf, type Rng, type Sq } from './board';

export interface Cand {
  /** White-frame FEN. */
  fen: string;
  /** Predicted bucket; lets the build skip candidates for buckets that are already full. */
  bucket?: string;
  /** Generator-private numbers (squares, flags). */
  d?: Record<string, number>;
  /** Generator-private expected move (white-frame UCI). */
  move?: string;
}

export interface Verdict {
  bucket: string;
  /** Suitable for play-it-out (wins need a DTM; draws use a fixed hold length). */
  playout: boolean;
}

export interface Ctx {
  rng: Rng;
  /** Probe another white-frame position (same transform, cached, counted). Null unless exact and ok. */
  probe(fen: string): Promise<TbProbeOk | null>;
}

export interface Generator {
  concept: string;
  /** What is verified for every kept item (goes into the pack meta). */
  property: string;
  /** Bucket caps as fractions of the per-concept target (may sum to more than 1). */
  buckets: Record<string, number>;
  /** Probe budget as a multiple of the per-concept target (default 3). */
  probeFactor?: number;
  candidate(rng: Rng): Cand | null;
  accept(c: Cand, p: TbProbeOk, ctx: Ctx): Verdict | null | Promise<Verdict | null>;
}

/* ---------- helpers shared by the accept functions ---------- */

export const best = (p: TbProbeOk): TbMove[] => {
  const top = p.category;
  return p.moves.filter((m) => m.category === top);
};
export const isCapture = (m: TbMove): boolean => m.san.includes('x');
export const from = (m: TbMove): Sq => sqOf(m.uci.slice(0, 2));
export const to = (m: TbMove): Sq => sqOf(m.uci.slice(2, 4));
/** Upper-case letter of the piece a move moves, read from the white-frame FEN. */
export const mover = (fen: string, m: TbMove): string => (boardOf(fen)[from(m)] ?? '').toUpperCase();
