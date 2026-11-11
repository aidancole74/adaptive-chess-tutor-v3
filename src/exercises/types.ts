/** The Exercise contract shared by content builders, the scheduler and the session UI. */
import type { Domain } from '../content/types';

export type ExerciseFormat =
  // tactics
  | 'solve'
  | 'spot-motif'
  | 'find-defense'
  | 'tactic-or-not'
  // endgames
  | 'eg-best-move'
  | 'eg-win-or-draw'
  | 'eg-playout'
  // openings
  | 'opening-line'
  | 'opening-deviation'
  | 'opening-trap'
  | 'structure-card'
  // strategy
  | 'quiet-best-move'
  | 'who-is-better'
  | 'choose-plan'
  | 'evaluate-trade'
  // calculation & visualization
  | 'calc-line'
  | 'candidates'
  | 'blindfold'
  | 'coordinates'
  | 'square-color'
  | 'knight-path'
  // defense & conversion, sparring
  | 'convert'
  | 'hold'
  | 'sparring'
  // process
  | 'blunder-check'
  | 'timed-drill'
  // diagnosis & curriculum
  | 'spot-mistake'
  | 'lesson';

export type Orientation = 'white' | 'black';

/** Play a forced line: the user plays solution[0], the app replies solution[1], and so on. */
export interface LineInteraction {
  kind: 'line';
  fen: string;
  orientation: Orientation;
  /** UCI moves animated before the user moves (e.g. the opponent's move that starts a puzzle). */
  preMoves: string[];
  /** UCI moves alternating user / reply, starting with the user. */
  solution: string[];
  /** Additional accepted user moves per user ply index (0 = first user move). */
  alternatives?: Record<number, string[]>;
  /** Accept any move that delivers checkmate on the final user ply (Lichess convention). */
  acceptAnyMate?: boolean;
  /** 'pieces' hides pieces (blindfold); 'after-pre' shows the start position but not the pre-moves' result. */
  hide?: 'none' | 'pieces' | 'after-pre';
  /** Number of user plies that must be entered up front before any feedback (calculation drills). */
  commitDepth?: number;
}

export interface ChoiceInteraction {
  kind: 'choice';
  fen?: string;
  orientation?: Orientation;
  /** UCI moves applied to `fen` before showing it. */
  preMoves?: string[];
  options: { id: string; label: string }[];
  /** Ids of the correct options. For multi-select every correct id and no incorrect id must be chosen. */
  correct: string[];
  multi: boolean;
  highlight?: string[];
}

/** Click squares or enter a set of moves (coordinates, knight paths, candidate lists). */
export interface SetInteraction {
  kind: 'set';
  fen?: string;
  orientation?: Orientation;
  mode: 'squares' | 'moves' | 'path';
  /** Expected squares ("e4") or UCI moves. For 'path' the list is one shortest path; any shortest legal knight path is accepted. */
  expected: string[];
  /** Fraction of expected entries (with no wrong entries beyond `maxWrong`) needed to count as solved. */
  passFraction: number;
  maxWrong: number;
  hide?: 'none' | 'pieces' | 'board-labels';
  /** For 'path': start and target squares. */
  from?: string;
  to?: string;
}

/** Play a position out against the tablebase or the engine. */
export interface PlayoutInteraction {
  kind: 'playout';
  fen: string;
  orientation: Orientation;
  opponent: 'tablebase' | 'engine';
  objective:
    | { type: 'mate-within'; moves: number }
    | { type: 'draw' ; moves: number }
    | { type: 'convert'; startCp: number; retainFraction: number; moves: number }
    | { type: 'hold'; startCp: number; maxExtraLossCp: number; moves: number }
    | { type: 'spar'; goal: string; moves: number; minCp: number };
  /** Engine opponent strength (UCI_Elo) when opponent === 'engine'. */
  opponentElo?: number;
}

export interface CardInteraction {
  kind: 'card';
  fen?: string;
  orientation?: Orientation;
  /** UCI moves applied to `fen` before showing it. */
  preMoves?: string[];
  title: string;
  /** Paragraphs built from verified facts / computed features. */
  body: string[];
  highlight?: string[];
}

export type Interaction = LineInteraction | ChoiceInteraction | SetInteraction | PlayoutInteraction | CardInteraction;

/** Verified facts; explanation templates may only use these. */
export type Fact =
  | { t: 'solution'; san: string[] }
  | { t: 'engine'; fen: string; pvSan: string[]; cp: number | null; mate: number | null; depth: number }
  | { t: 'tablebase'; fen: string; category: 'win' | 'draw' | 'loss'; dtm: number | null; bestSan: string[] }
  | { t: 'motif'; name: string; squares?: string[] }
  | { t: 'feature'; name: string; side: 'w' | 'b'; detail: string; heuristic: true }
  | { t: 'book'; band: string; moves: { san: string; games: number; scorePct: number }[] }
  | { t: 'source'; label: string; url?: string }
  | { t: 'note'; text: string };

/** Keys the scheduler uses for similarity penalties. */
export interface SimilarityKey {
  themes: string[];
  /** Material signature such as "KRPPkrp" (white upper-case, black lower-case, sorted). */
  material: string;
  structure?: string;
  sourceGame?: string;
}

/** What the scheduler needs to score an item without loading its interaction. */
export interface Candidate {
  id: string;
  itemId: string;
  domain: Domain;
  conceptId: string;
  secondaryConcepts?: string[];
  format: ExerciseFormat;
  /** Difficulty on the Lichess puzzle-rating scale. */
  difficulty: number;
  difficultySource: 'lichess' | 'tier-prior' | 'learned';
  sim: SimilarityKey;
  phase: 'opening' | 'middlegame' | 'endgame';
  /** Side the user plays. */
  color: 'w' | 'b';
  /** Set for memorised content (opening nodes, endgame technique, principle cards): FSRS key. */
  memoryKey?: string;
  verified: boolean;
}

export interface Exercise extends Candidate {
  prompt: string;
  interaction: Interaction;
  facts: Fact[];
  /** Suggested seconds for a careful solve; timed drills override this. */
  timeBudgetSec?: number;
}

export interface ExerciseResult {
  exerciseId: string;
  /** 0..1: fraction solved (1 = fully correct without hints). */
  score: number;
  solved: boolean;
  hintsUsed: number;
  timeMs: number;
  /** 1..5 confidence asked before answering, when enabled. */
  confidence?: number;
  /** Error cause, from user tagging or inference from clocks. */
  cause?: ErrorCause;
  /** For play-outs: evaluation retention or moves used. */
  detail?: Record<string, number | string>;
}

export type ErrorCause = 'knowledge' | 'vision' | 'calculation' | 'time' | 'discipline';
export const ERROR_CAUSES: ErrorCause[] = ['knowledge', 'vision', 'calculation', 'time', 'discipline'];
