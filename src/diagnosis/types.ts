/** Game-analysis contracts (stored with the game in Dexie as StoredGame.analysis). */
import type { DetectedMotif } from '../engine/motifs';

export type EvalSource = 'embedded' | 'engine';

/** One analysed ply. Evaluations are from the MOVER's point of view, mate scores folded to +-MATE_CAP. */
export interface PlyEval {
  /** 1-based ply number (ply 1 = first move of the game). */
  ply: number;
  color: 'w' | 'b';
  san: string;
  uci: string;
  evalBeforeCp: number;
  evalAfterCp: number;
  cpLoss: number;
  /** Mate-in-N available to the mover before the move (engine / embedded), else null. */
  mateBefore: number | null;
  /** Mate-in-N against the mover after the move, else null. */
  mateAfter: number | null;
  clockMs: number | null;
  timeSpentMs: number | null;
  source: EvalSource;
}

export interface Mistake {
  ply: number;
  color: 'w' | 'b';
  /** Position before the mistake. */
  fen: string;
  /** Played move (UCI) and SAN. */
  played: string;
  playedSan: string;
  /** Engine best move (UCI) and SAN. */
  best: string;
  bestSan: string;
  /** Engine principal variation from `fen` (UCI) and its SAN. */
  bestPv: string[];
  bestPvSan: string[];
  /** Engine line after the played move (opponent first, UCI) and its SAN. */
  refutationPv: string[];
  refutationPvSan: string[];
  /** Other engine first moves within ALT_MARGIN_CP of the best (MultiPV), UCI. */
  alternatives: string[];
  evalBeforeCp: number;
  evalAfterCp: number;
  cpLoss: number;
  mateBefore: number | null;
  mateAfter: number | null;
  /** Engine evaluation (side to move POV, unfolded) of the best line at `fen`. */
  bestLine: { cp: number | null; mate: number | null; depth: number };
  motifs: DetectedMotif[];
  primary: DetectedMotif | null;
  conceptId: string | null;
  unclassified: boolean;
  clockMs: number | null;
  timeSpentMs: number | null;
  source: EvalSource;
}

export interface DetectorCoverage {
  mistakes: number;
  classified: number;
  /** Mistakes per detector of their PRIMARY motif (sums to `classified`). */
  byDetector: Record<string, number>;
}

export interface GameAnalysis {
  gameId: string;
  depth: number;
  /** Colour(s) analysed: the user's colour, or null when both sides were analysed. */
  userColor: 'w' | 'b' | null;
  moves: PlyEval[];
  mistakes: Mistake[];
  coverage: DetectorCoverage;
  /** Position evaluations from WHITE's point of view (folded), index = position before ply index+1; null when not evaluated. */
  graph: (number | null)[];
  /** Number of evaluations taken from the game file vs computed by the engine. */
  evalSources: { embedded: number; engine: number };
  /** Ply at which the game left the opening book (filled by the openings module). */
  bookExit?: number;
  analysedAt: number;
}
