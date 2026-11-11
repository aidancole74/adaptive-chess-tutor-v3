/** Small chess.js helpers shared by the app and the pipelines. */
import { Chess, type Move } from 'chess.js';

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function uciOf(m: Pick<Move, 'from' | 'to' | 'promotion'>): string {
  return m.from + m.to + (m.promotion ?? '');
}

export function parseUci(uci: string): { from: string; to: string; promotion?: string } {
  return { from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci.length > 4 ? uci[4] : undefined };
}

/** Applies a UCI move; returns the Move or null when illegal (never throws). */
export function tryMove(chess: Chess, uci: string): Move | null {
  try {
    return chess.move(parseUci(uci));
  } catch {
    return null;
  }
}

/** Applies UCI moves from a FEN. Returns null if any move is illegal. */
export function playLine(fen: string, ucis: string[]): { chess: Chess; sans: string[] } | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const sans: string[] = [];
  for (const u of ucis) {
    const m = tryMove(chess, u);
    if (!m) return null;
    sans.push(m.san);
  }
  return { chess, sans };
}

export function sanLine(fen: string, ucis: string[]): string[] {
  return playLine(fen, ucis)?.sans ?? [];
}

/** First four FEN fields: position identity ignoring move counters (used for transpositions and caches). */
export function epdOf(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

/** Material signature such as "KQRPPPkrrpp": white upper-case then black lower-case, in KQRBNP order. */
export function materialSignature(fen: string): string {
  const board = fen.split(' ')[0] ?? '';
  const order = 'KQRBNP';
  const count = (ch: string): number => board.split(ch).length - 1;
  let s = '';
  for (const p of order) s += p.repeat(count(p));
  for (const p of order.toLowerCase()) s += p.repeat(count(p));
  return s;
}

export function pieceCount(fen: string): number {
  return (fen.split(' ')[0] ?? '').replace(/[^a-zA-Z]/g, '').length;
}

export function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(' ')[1] === 'b' ? 'b' : 'w';
}

export function isValidFen(fen: string): boolean {
  try {
    new Chess(fen);
    return true;
  } catch {
    return false;
  }
}

/** Coarse game phase from material (non-pawn, non-king piece points). */
export function phaseOf(fen: string): 'opening' | 'middlegame' | 'endgame' {
  const board = fen.split(' ')[0] ?? '';
  const pts: Record<string, number> = { q: 9, r: 5, b: 3, n: 3 };
  let total = 0;
  for (const ch of board.toLowerCase()) total += pts[ch] ?? 0;
  const fullmove = Number(fen.split(' ')[5] ?? 1);
  if (total <= 26) return 'endgame';
  if (fullmove <= 12 && total >= 56) return 'opening';
  return 'middlegame';
}
