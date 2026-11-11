/** Shared content-pack contracts. Pipelines in scripts/ write these; the app reads them lazily. */

export type Domain =
  | 'tactics'
  | 'endgames'
  | 'openings'
  | 'strategy'
  | 'calculation'
  | 'defense'
  | 'time'
  | 'sparring';

export const DOMAINS: Domain[] = ['tactics', 'endgames', 'openings', 'strategy', 'calculation', 'defense', 'time', 'sparring'];

export interface PackShard {
  /** File name relative to the pack directory, e.g. "r1200.json". */
  file: string;
  /** Shard key: rating band start for tactics, endgame type, book band, ... */
  key: string;
  count: number;
  bytes: number;
}

/** Written by each pipeline to public/packs/<id>/pack.json. */
export interface PackInfo {
  id: string;
  domain: Domain;
  /** Bump when the shard format or selection changes; the loader invalidates caches on change. */
  version: string;
  license: string;
  source: string;
  generatedAt: string;
  count: number;
  shards: PackShard[];
  /** Pipeline-specific summary (theme counts, verification pass rates, ...). Used by the QA report. */
  meta?: Record<string, unknown>;
}

/** public/packs/manifest.json, produced by `npm run data:manifest`. */
export interface PackManifest {
  schema: 1;
  generatedAt: string;
  packs: PackInfo[];
}

/* ---------- Tactics (Lichess puzzle DB, CC0) ---------- */

/**
 * Compact tuple: [id, fen, moves, rating, ratingDeviation, themes, openingTags].
 * `fen` is the position BEFORE the opponent's first move; `moves` is space-separated UCI where
 * moves[0] is the opponent's move and the solution starts at moves[1]. `themes` is space-separated
 * Lichess theme names.
 */
export type TacticTuple = [id: string, fen: string, moves: string, rating: number, rd: number, themes: string, openingTags: string];

export interface TacticItem {
  id: string;
  fen: string;
  moves: string[];
  rating: number;
  rd: number;
  themes: string[];
  openingTags: string[];
}

/* ---------- Endgames (procedural, Lichess tablebase verified) ---------- */

export type TbCategory = 'win' | 'draw' | 'loss';

export interface EndgameItem {
  id: string;
  /** Concept id, e.g. "endgames/rook/lucena". */
  concept: string;
  fen: string;
  /** Tablebase category for the side to move (cursed-win / blessed-loss are folded into draw and never shipped). */
  category: TbCategory;
  /** Distance to mate in plies for the side to move when known. */
  dtm: number | null;
  dtz: number | null;
  /** Every legal move with the resulting category from the MOVER's point of view. */
  moves: { uci: string; san: string; category: TbCategory; dtm: number | null }[];
  /** Moves that preserve the best achievable category (the accepted answers). */
  best: string[];
  /** True when exactly one move preserves the result (good "only move" exercise). */
  onlyMove: boolean;
  tier: number;
  /** Full-move target for play-it-out, derived from DTM with slack; null when not a play-out item. */
  playoutTarget: number | null;
  /** Always true for shipped items: verified against tablebase.lichess.ovh at build time. */
  verified: boolean;
}

/* ---------- Openings (chess-openings CC0 + Lichess game dump CC0) ---------- */

/** [eco, name, uciMoves (space separated), epd of final position] */
export type OpeningNameTuple = [eco: string, name: string, uci: string, epd: string];

/** Rating bands for the book. */
export const BOOK_BANDS = ['0-1199', '1200-1599', '1600-1999', '2000+'] as const;
export type BookBand = (typeof BOOK_BANDS)[number];

/** Per-move stats: [games, whiteWins, draws, blackWins]. */
export type BookStat = [games: number, white: number, draws: number, black: number];

/**
 * Book shard for one band: positions keyed by EPD (first four FEN fields) so transpositions merge.
 * Only the first 14 plies are aggregated; rare moves are pruned by the pipeline.
 */
export interface BookShard {
  band: BookBand;
  games: number;
  positions: Record<string, Record<string, BookStat>>;
}

/** A popular-but-bad move found in the book and confirmed by engine evaluation. */
export interface TrapItem {
  id: string;
  /** EPD of the position where the mistake is commonly played. */
  epd: string;
  fen: string;
  /** UCI line from the start position leading here (most common order). */
  line: string[];
  /** The tempting mistake and how often it is played in this band. */
  mistake: string;
  mistakeFreq: number;
  band: BookBand;
  /** Engine-best punishment and evaluations (centipawns, punisher's point of view). */
  refutation: string[];
  evalBeforeCp: number;
  evalAfterCp: number;
  depth: number;
  openingName: string;
  verified: boolean;
}

/* ---------- Strategy bank (Stockfish MultiPV over high-rated games) ---------- */

export interface StrategyItem {
  id: string;
  fen: string;
  /** Best move and principal variation (UCI). The PV's leading moves contain no captures or checks. */
  best: string;
  pv: string[];
  /** Evaluations in centipawns from the side to move's point of view. */
  bestCp: number;
  secondCp: number;
  /** MultiPV lines: uci first move + cp. */
  lines: { uci: string; cp: number }[];
  depth: number;
  /** Lichess game id the position was sampled from. */
  sourceGame: string;
  ply: number;
  /** Static features present in the position (names from src/engine/features), per side. */
  features: { w: string[]; b: string[] };
  /** Features that change after the best move: "+name" gained, "-name" lost, prefixed with side, e.g. "w+outpost". */
  featureDeltas: string[];
  /** Heuristic plan label for the best move (see src/engine/features/plans.ts). */
  plan: string;
  /** Plan labels of clearly inferior alternatives (cp loss >= margin), used as distractors. */
  otherPlans: { plan: string; uci: string; cpLoss: number }[];
  /** Equal-material trade available in the position, with its engine verdict. */
  trade: { uci: string; cp: number; verdict: 'good' | 'neutral' | 'bad' } | null;
  /** Dominant pawn-structure label (for similarity penalties). */
  structure: string;
  tier: number;
  verified: boolean;
}
