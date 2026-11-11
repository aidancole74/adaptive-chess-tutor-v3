/** Imported-game contract shared by the importers (PGN, Lichess, Chess.com) and the diagnosis pipeline. */

export type GameSource = 'lichess' | 'chesscom' | 'pgn';
export type GameSpeed = 'bullet' | 'blitz' | 'rapid' | 'classical' | 'correspondence';

/** An evaluation embedded in the source (Lichess server analysis), from WHITE's point of view. */
export interface EmbeddedEval {
  cp: number | null;
  mate: number | null;
}

export interface ImportedMove {
  san: string;
  uci: string;
  /** Position before the move. */
  fenBefore: string;
  /** Mover's remaining clock after the move, in milliseconds, when the source records clocks. */
  clockMs: number | null;
  /** Evaluation of the position AFTER the move (white's point of view), when the source embeds one. */
  embeddedEval: EmbeddedEval | null;
}

export interface ImportedGame {
  /** Stable id: "lichess:<gameId>", "chesscom:<uuid|url id>" or "pgn:<hash>". */
  id: string;
  source: GameSource;
  url?: string;
  white: string;
  black: string;
  whiteElo?: number;
  blackElo?: number;
  /** Colour the importing user played, or null when unknown (both sides are analysed then). */
  userColor: 'w' | 'b' | null;
  /** "1-0", "0-1", "1/2-1/2" or "*". */
  result: string;
  /** Seconds. */
  timeControl: { base: number; inc: number } | null;
  speed: GameSpeed | null;
  startFen: string;
  moves: ImportedMove[];
  opening?: { eco?: string; name?: string };
  /** Epoch milliseconds. */
  playedAt?: number;
}

export interface ImportError {
  /** 0-based index of the game in the input (PGN) or the stream (NDJSON). */
  index: number;
  message: string;
  /** Header summary to help the user find the game, e.g. "alice vs bob, 2026.10.01". */
  label?: string;
}

/** Speed class from a time control, using Lichess's estimate (base + 40 * increment seconds). */
export function speedOf(tc: { base: number; inc: number } | null): GameSpeed | null {
  if (!tc) return null;
  const est = tc.base + 40 * tc.inc;
  if (est < 180) return 'bullet';
  if (est < 480) return 'blitz';
  if (est < 1500) return 'rapid';
  return 'classical';
}

/** Small deterministic string hash (FNV-1a, 32 bit) used for ids of pasted PGN games. */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
