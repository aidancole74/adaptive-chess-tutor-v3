/**
 * Pure repertoire logic over the rating-banded book. All suggestions are computed from book statistics;
 * nothing here encodes opening theory.
 */
import { Chess } from 'chess.js';
import { epdOf, tryMove } from '../engine/chessUtil';
import { START_EPD, type Book, type BookMove, type OpeningNames } from './openings';
import type { BookBand } from './types';

export interface Repertoire {
  color: 'w' | 'b';
  /** The user's chosen move (UCI) keyed by EPD, for positions where the user is to move. */
  choices: Record<string, string>;
  name?: string;
}

export interface DefaultRule {
  /** A move must be played in at least this share of the position's games to be eligible (default 0.10). */
  minPopularity: number;
  /** ...and have at least this many games (default 30), so the score is not noise. */
  minGames: number;
}

export const DEFAULT_RULE: DefaultRule = { minPopularity: 0.1, minGames: 30 };

/**
 * Default move for a user-to-move position: the best-scoring move (mover's view) among moves that are popular
 * enough in this band (`rule`); ties go to the more played move. Falls back to the most played move when no
 * move is eligible, and to null when the position is not in the book.
 */
export function defaultMove(book: Book, band: BookBand, epd: string, rule: DefaultRule = DEFAULT_RULE): BookMove | null {
  const moves = book.movesAt(band, epd);
  if (moves.length === 0) return null;
  const eligible = moves.filter((m) => m.freq >= rule.minPopularity && m.games >= rule.minGames);
  if (eligible.length === 0) return moves[0] ?? null;
  return eligible.reduce((best, m) => (m.scorePct > best.scorePct || (m.scorePct === best.scorePct && m.games > best.games) ? m : best));
}

export interface TreeOptions {
  /** Deepest ply (moves played before the user's move) at which a node is created. Default 14 = book depth. */
  maxPly: number;
  /** Opponent replies below this share of the position's games are not drilled. Default 0.05. */
  minOpponentFreq: number;
  maxNodes: number;
  rule: DefaultRule;
  /** Used to fill `openingName`. */
  names?: OpeningNames;
}

export const DEFAULT_TREE_OPTIONS: TreeOptions = { maxPly: 14, minOpponentFreq: 0.05, maxNodes: 400, rule: DEFAULT_RULE };

export interface RepertoireNode {
  /** Position where the user is to move. */
  epd: string;
  fen: string;
  /** UCI line from the start position (the most likely order found). */
  line: string[];
  userMove: string;
  /** True when `userMove` comes from `rep.choices`, false when it is the data-driven default. */
  chosen: boolean;
  ply: number;
  /** Product of the opponent's book move frequencies along the line, summed over transpositions (0..1). */
  opponentFreqProduct: number;
  openingName: string;
  /** Spaced-repetition key: `op:${color}:${epd}`. */
  memoryKey: string;
}

export function memoryKeyFor(color: 'w' | 'b', epd: string): string {
  return `op:${color}:${epd}`;
}

interface Frontier {
  fen: string;
  epd: string;
  line: string[];
  prob: number;
}

/**
 * Walks the book from the start position. At user-to-move positions it follows `rep.choices` (falling back to
 * `defaultMove`); at opponent-to-move positions it branches on every book move with frequency >=
 * `minOpponentFreq`. Positions are merged by EPD (the first, most likely line is kept and the probabilities of
 * later transpositions are added). Expansion is most-likely-first, so `maxNodes` keeps the lines the user will
 * meet most often. Each returned node is one spaced-repetition item.
 */
export function buildRepertoireTree(book: Book, band: BookBand, rep: Repertoire, opts: Partial<TreeOptions> = {}): RepertoireNode[] {
  const o: TreeOptions = { ...DEFAULT_TREE_OPTIONS, ...opts };
  const nodes = new Map<string, RepertoireNode>();
  const seenOpponent = new Set<string>();
  const start = new Chess();
  const frontier: Frontier[] = [{ fen: start.fen(), epd: START_EPD, line: [], prob: 1 }];
  while (frontier.length > 0) {
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if ((frontier[i] as Frontier).prob > (frontier[bi] as Frontier).prob) bi = i;
    const cur = frontier.splice(bi, 1)[0] as Frontier;
    const ply = cur.line.length;
    const userToMove = (ply % 2 === 0 ? 'w' : 'b') === rep.color;
    if (userToMove) {
      const existing = nodes.get(cur.epd);
      if (existing) {
        existing.opponentFreqProduct = Math.min(1, existing.opponentFreqProduct + cur.prob);
        continue;
      }
      if (ply > o.maxPly - 1 || nodes.size >= o.maxNodes) continue;
      const chess = new Chess(cur.fen);
      const choice = rep.choices[cur.epd];
      let userMove: string | null = null;
      let chosen = false;
      if (choice && tryMove(chess, choice)) {
        userMove = choice;
        chosen = true;
      } else {
        const d = defaultMove(book, band, cur.epd, o.rule);
        if (d && tryMove(chess, d.uci)) userMove = d.uci;
      }
      if (!userMove) continue;
      const line = [...cur.line, userMove];
      nodes.set(cur.epd, {
        epd: cur.epd,
        fen: cur.fen,
        line: cur.line,
        userMove,
        chosen,
        ply,
        opponentFreqProduct: cur.prob,
        openingName: o.names?.nameForLine(line)?.name ?? '',
        memoryKey: memoryKeyFor(rep.color, cur.epd),
      });
      const fen = chess.fen();
      frontier.push({ fen, epd: epdOf(fen), line, prob: cur.prob });
    } else {
      if (seenOpponent.has(cur.epd) || ply > o.maxPly - 2) continue;
      seenOpponent.add(cur.epd);
      for (const m of book.movesAt(band, cur.epd)) {
        if (m.freq < o.minOpponentFreq) continue;
        const chess = new Chess(cur.fen);
        if (!tryMove(chess, m.uci)) continue;
        const fen = chess.fen();
        frontier.push({ fen, epd: epdOf(fen), line: [...cur.line, m.uci], prob: cur.prob * m.freq });
      }
    }
  }
  return [...nodes.values()].sort((a, b) => a.ply - b.ply || b.opponentFreqProduct - a.opponentFreqProduct);
}

/**
 * Rating-appropriate default repertoire for a colour: the `defaultMove` rule applied at every user-to-move
 * position reachable through opponent replies above the frequency threshold. Named after the opening reached
 * on the single most likely line.
 */
export function suggestDefaults(book: Book, names: OpeningNames, band: BookBand, color: 'w' | 'b', opts: Partial<TreeOptions> = {}): Repertoire {
  const tree = buildRepertoireTree(book, band, { color, choices: {} }, { ...opts, names });
  const choices: Record<string, string> = {};
  for (const n of tree) choices[n.epd] = n.userMove;
  // Main line: follow the user's move and the opponent's most played reply.
  const chess = new Chess();
  const line: string[] = [];
  for (let ply = 0; ply < (opts.maxPly ?? DEFAULT_TREE_OPTIONS.maxPly); ply++) {
    const epd = epdOf(chess.fen());
    const uci = (ply % 2 === 0 ? 'w' : 'b') === color ? choices[epd] : book.movesAt(band, epd)[0]?.uci;
    if (!uci || !tryMove(chess, uci)) break;
    line.push(uci);
  }
  const name = names.nameForLine(line)?.name;
  return name ? { color, choices, name } : { color, choices };
}

/** Adds the user's moves along a UCI line (e.g. an entry from `listOpeningsForColor`) to a repertoire. */
export function withLine(rep: Repertoire, line: string[]): Repertoire {
  const choices = { ...rep.choices };
  const chess = new Chess();
  for (let ply = 0; ply < line.length; ply++) {
    const epd = epdOf(chess.fen());
    const uci = line[ply] as string;
    if (!tryMove(chess, uci)) break;
    if ((ply % 2 === 0 ? 'w' : 'b') === rep.color) choices[epd] = uci;
  }
  return { ...rep, choices };
}

export interface BookExit {
  /** Index into the game's moves of the move that left the book / repertoire. */
  ply: number;
  by: 'user' | 'opponent';
  /** Position before the move. */
  epd: string;
  /** What the repertoire (user) or the book expected there, most played first; null when the book has no data. */
  expected: string[] | null;
  played: string;
  /** True when the played move is itself a book move (a user move that is in the book but not in the repertoire). */
  known: boolean;
}

/**
 * Where a real game left the repertoire / book. The user's colour is `rep.color` (or `userColor` without a
 * repertoire). A user move differing from the repertoire choice is an exit even when it is a book move
 * (`known: true`); any move the band's book does not contain is an exit. Returns null when the game ends while
 * still in book, or on an illegal move.
 */
export function findBookExit(movesUci: string[], book: Book, band: BookBand, rep?: Repertoire, userColor: 'w' | 'b' = rep?.color ?? 'w'): BookExit | null {
  const chess = new Chess();
  for (let ply = 0; ply < movesUci.length; ply++) {
    const epd = epdOf(chess.fen());
    const played = movesUci[ply] as string;
    const by: 'user' | 'opponent' = (ply % 2 === 0 ? 'w' : 'b') === userColor ? 'user' : 'opponent';
    const bookMoves = book.movesAt(band, epd);
    const known = bookMoves.some((m) => m.uci === played);
    const choice = by === 'user' ? rep?.choices[epd] : undefined;
    if (choice && choice !== played) return { ply, by, epd, expected: [choice], played, known };
    if (!known && !(choice && choice === played && bookMoves.length > 0)) {
      return { ply, by, epd, expected: bookMoves.length ? bookMoves.map((m) => m.uci) : null, played, known: false };
    }
    if (!tryMove(chess, played)) return null;
  }
  return null;
}

export interface OpeningOption {
  family: string;
  /** Name and ECO of the family's entry line. */
  name: string;
  eco: string;
  /** Shortest named line of the family that the band's book covers. */
  line: string[];
  epd: string;
  /** Games in the band in which the entry line's last move was played, and its score for `color` in percent. */
  games: number;
  scorePct: number;
  /** Named lines of the family that the band's book covers. */
  variations: number;
}

/**
 * Selectable openings for the repertoire builder: one entry per opening family whose entry line (the shortest
 * named line of the family) ends with a move by `color` and is present in the band's book. Sorted by games.
 */
export function listOpeningsForColor(names: OpeningNames, book: Book, band: BookBand, color: 'w' | 'b', minGames = 1): OpeningOption[] {
  const byFamily = new Map<string, OpeningOption>();
  for (const n of names.all) {
    if (n.line.length === 0) continue;
    const chess = new Chess();
    let last: BookMove | null = null;
    let ok = true;
    for (const uci of n.line) {
      last = book.move(band, epdOf(chess.fen()), uci);
      if (!last || !tryMove(chess, uci)) {
        ok = false;
        break;
      }
    }
    if (!ok || !last) continue;
    const prev = byFamily.get(n.family);
    const variations = (prev?.variations ?? 0) + 1;
    if (prev && prev.line.length <= n.line.length) {
      prev.variations = variations;
      continue;
    }
    const whiteMovedLast = n.line.length % 2 === 1;
    const mover = whiteMovedLast ? 'w' : 'b';
    byFamily.set(n.family, {
      family: n.family,
      name: n.name,
      eco: n.eco,
      line: n.line,
      epd: n.epd,
      games: last.games,
      scorePct: mover === color ? last.scorePct : 100 - last.scorePct,
      variations,
    });
  }
  return [...byFamily.values()]
    .filter((o) => (o.line.length % 2 === 1 ? 'w' : 'b') === color && o.games >= minGames)
    .sort((a, b) => b.games - a.games || (a.family < b.family ? -1 : 1));
}
