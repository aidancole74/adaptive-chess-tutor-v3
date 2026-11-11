/** Test helpers shared by the feature and motif tests (not used by the app). */
import { Chess } from 'chess.js';
import { attackersOf, findKing, parseFen, signOf, type Sign } from './board';

/**
 * Asserts a constructed fixture is a legal position: chess.js accepts the FEN, and the side that
 * is NOT to move is not in check. Returns the FEN so fixtures can be declared inline.
 */
export function legal(fen: string): string {
  const chess = new Chess(fen); // throws on malformed FEN / missing kings
  const b = parseFen(fen);
  const waiting = -signOf(chess.turn()) as Sign;
  const king = findKing(b.sq, waiting);
  if (king < 0 || attackersOf(b.sq, king, -waiting as Sign).length > 0) {
    throw new Error(`Illegal fixture (side not to move is in check): ${fen}`);
  }
  return fen;
}

/** Deterministic 32-bit LCG. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Positions (with the move played next, when any) sampled from random legal playouts. */
export function randomPositions(count: number, seed: number): { fen: string; uci: string }[] {
  const rnd = lcg(seed);
  const out: { fen: string; uci: string }[] = [];
  while (out.length < count) {
    const chess = new Chess();
    for (let ply = 0; ply < 120 && out.length < count; ply++) {
      const moves = chess.moves({ verbose: true });
      if (moves.length === 0 || chess.isDraw()) break;
      const m = moves[Math.floor(rnd() * moves.length)]!;
      if (ply >= 4) out.push({ fen: chess.fen(), uci: m.from + m.to + (m.promotion ?? '') });
      chess.move(m);
    }
  }
  return out;
}

/** Colour-reversed mirror of a FEN (ranks flipped, colours and side to move swapped). */
export function mirrorFen(fen: string): string {
  const [placement = '', turn, castling = '-', ep = '-', half = '0', full = '1'] = fen.split(' ');
  const swap = (s: string): string => s.replace(/[a-zA-Z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
  const rows = placement.split('/').reverse().map(swap).join('/');
  const cast = castling === '-' ? '-' : [...swap(castling)].sort().join('');
  const epm = ep === '-' ? '-' : ep.charAt(0) + String(9 - Number(ep.charAt(1)));
  return `${rows} ${turn === 'w' ? 'b' : 'w'} ${cast} ${epm} ${half} ${full}`;
}
