/** Static positional features. All of this is heuristic description, never an evaluation claim. */

export type Side = 'w' | 'b';

export type StructureLabel =
  | 'iqp-white'
  | 'iqp-black'
  | 'hanging-pawns-white'
  | 'hanging-pawns-black'
  | 'carlsbad'
  | 'maroczy-white'
  | 'maroczy-black'
  | 'symmetrical'
  | 'open-centre'
  | 'closed-centre'
  | 'other';

export interface SideFeatures {
  /** Squares of pawns in each category. */
  isolated: string[];
  doubled: string[];
  backward: string[];
  passed: string[];
  /** Pair of adjacent pawns on semi-open files with no neighbours (c+d typically). */
  hangingPawns: string[];
  /** Isolated d-pawn. */
  iqp: boolean;
  /** File letters fully open for this side's rooks/queens are in `PositionFeatures.openFiles`; these are semi-open for this side. */
  semiOpenFiles: string[];
  /** Squares in the enemy half protected by own pawn that no enemy pawn can ever attack; `occupied` when a knight/bishop sits there. */
  outposts: { square: string; occupied: boolean }[];
  /** Squares in own camp (ranks 3-4 for White, 5-6 for Black relative) that own pawns can no longer protect. */
  weakSquares: string[];
  /** 0 (safe) .. 10 (very exposed): pawn-shield holes, open files next to king, attackers near king. */
  kingDanger: number;
  kingShieldPawns: number;
  castled: boolean;
  /** Pseudo-legal mobility of pieces (not pawns/king). */
  mobility: number;
  bishopPair: boolean;
  /** Bishops with >= 3 own central/own-colour pawns on their square colour. */
  badBishops: string[];
  goodBishops: string[];
  /** Number of squares attacked/controlled in the enemy half minus pawns behind: simple space count. */
  space: number;
  /** Minor pieces off the back rank + castled bonus + connected rooks. */
  development: number;
  /** Rooks on open or semi-open files. */
  rooksOnOpenFiles: string[];
  material: number;
}

export interface PositionFeatures {
  fen: string;
  w: SideFeatures;
  b: SideFeatures;
  openFiles: string[];
  structure: StructureLabel;
  phase: 'opening' | 'middlegame' | 'endgame';
  /** Material signature such as "KRPPkrp". */
  materialSignature: string;
}

/**
 * Named, comparable feature flags used for labels, deltas and "why" attributions.
 * Names double as leaf ids of strategy concepts where one exists (e.g. "outpost", "bishop-pair").
 */
export type FeatureName =
  | 'isolated'
  | 'doubled'
  | 'backward'
  | 'passed'
  | 'hanging-pawns'
  | 'iqp'
  | 'carlsbad'
  | 'maroczy'
  | 'open-file'
  | 'semi-open-file'
  | 'outpost'
  | 'weak-squares'
  | 'king-safety'
  | 'activity'
  | 'bishop-pair'
  | 'good-bad-bishop'
  | 'space'
  | 'development';

/** Implemented in ./extract.ts */
export type ExtractFeatures = (fen: string) => PositionFeatures;
/** Implemented in ./flags.ts: which named features favour each side, with a short factual detail string. */
export type FeatureFlags = (f: PositionFeatures) => { name: FeatureName; side: Side; detail: string }[];
