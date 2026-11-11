/** Shared helper: replay SAN moves with chess.js into ImportedMove records (legality is enforced here). */
import { Chess } from 'chess.js';
import { START_FEN, uciOf } from '../engine/chessUtil';
import type { EmbeddedEval, ImportedMove } from './types';

export interface MoveAnnotations {
  clockMs: number | null;
  embeddedEval: EmbeddedEval | null;
}

/** Normalises common SAN spellings chess.js may reject (zero castling, annotation glyphs). */
export function cleanSan(raw: string): string {
  return raw
    .replace(/^0-0-0/, 'O-O-O')
    .replace(/^0-0/, 'O-O')
    .replace(/[!?]+$/, '')
    .replace(/[−]/g, '-');
}

/**
 * Replays `sans` from `startFen`. Returns the moves, or an error naming the first illegal move
 * (with its 1-based ply) so the importer can report it instead of guessing.
 */
export function replaySans(
  startFen: string,
  sans: string[],
  notes: (ply: number) => MoveAnnotations = () => ({ clockMs: null, embeddedEval: null }),
): { ok: true; moves: ImportedMove[]; startFen: string } | { ok: false; error: string } {
  let chess: Chess;
  try {
    chess = new Chess(startFen);
  } catch (e) {
    return { ok: false, error: `Invalid start position (${(e as Error).message})` };
  }
  const fen0 = chess.fen();
  const moves: ImportedMove[] = [];
  for (let i = 0; i < sans.length; i++) {
    const san = cleanSan(sans[i]!);
    const fenBefore = chess.fen();
    let m;
    try {
      m = chess.move(san);
    } catch {
      m = null;
    }
    if (!m) {
      const moveNo = fenBefore.split(' ')[5] ?? '?';
      return { ok: false, error: `Illegal or unreadable move "${sans[i]}" at ply ${i + 1} (move ${moveNo})` };
    }
    const n = notes(i);
    moves.push({ san: m.san, uci: uciOf(m), fenBefore, clockMs: n.clockMs, embeddedEval: n.embeddedEval });
  }
  return { ok: true, moves, startFen: fen0 };
}

export { START_FEN };
