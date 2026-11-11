/**
 * Openings pack: types and pure lookups over loaded shards (names.json, book-*.json, traps.json, cards.json).
 * Everything here is data produced by `npm run data:openings`; nothing is hand-written theory.
 */
import { Chess } from 'chess.js';
import { START_FEN, epdOf, tryMove } from '../engine/chessUtil';
import { BOOK_BANDS, type BookBand, type BookShard, type BookStat, type OpeningNameTuple, type TrapItem } from './types';

export const START_EPD = epdOf(START_FEN);

/* ---------- names ---------- */

export interface OpeningName {
  eco: string;
  name: string;
  /** Text before the first colon, e.g. "Sicilian Defense". */
  family: string;
  line: string[];
  epd: string;
}

export function familyOf(name: string): string {
  const i = name.indexOf(':');
  return (i >= 0 ? name.slice(0, i) : name).trim();
}

export class OpeningNames {
  readonly all: OpeningName[] = [];
  private byEpd = new Map<string, OpeningName>();

  constructor(tuples: OpeningNameTuple[]) {
    for (const [eco, name, uci, epd] of tuples) {
      const entry: OpeningName = { eco, name, family: familyOf(name), line: uci ? uci.split(' ') : [], epd };
      this.all.push(entry);
      const prev = this.byEpd.get(epd);
      // When two named lines reach the same position keep the shorter one (the more common move order).
      if (!prev || entry.line.length < prev.line.length) this.byEpd.set(epd, entry);
    }
  }

  get size(): number {
    return this.all.length;
  }

  nameForEpd(epd: string): OpeningName | null {
    return this.byEpd.get(epd) ?? null;
  }

  /**
   * Deepest named position along a UCI line from the start position. Positions are matched by EPD, so a named
   * opening reached by transposition is recognised. `ply` is the number of moves played when the name applies.
   * Stops at the first illegal move.
   */
  nameForLine(line: string[]): (OpeningName & { ply: number }) | null {
    const chess = new Chess();
    let best: (OpeningName & { ply: number }) | null = null;
    for (let i = 0; i < line.length; i++) {
      if (!tryMove(chess, line[i] as string)) break;
      const hit = this.byEpd.get(epdOf(chess.fen()));
      if (hit) best = { ...hit, ply: i + 1 };
    }
    return best;
  }

  /** Lowest and highest ECO code among the named lines of a family, e.g. "B20-B99" (or "C50" when single). */
  ecoRange(family: string): string {
    let lo = '';
    let hi = '';
    for (const n of this.all) {
      if (n.family !== family) continue;
      if (!lo || n.eco < lo) lo = n.eco;
      if (!hi || n.eco > hi) hi = n.eco;
    }
    return lo === hi ? lo : `${lo}-${hi}`;
  }
}

/* ---------- book ---------- */

export function bandForRating(rating: number): BookBand {
  return rating < 1200 ? '0-1199' : rating < 1600 ? '1200-1599' : rating < 2000 ? '1600-1999' : '2000+';
}

export function moverOfEpd(epd: string): 'w' | 'b' {
  return epd.split(' ')[1] === 'b' ? 'b' : 'w';
}

/** Score in percent (win = 1, draw = 0.5) from `side`'s point of view. */
export function scorePct(stat: BookStat, side: 'w' | 'b'): number {
  const [games, white, draws, black] = stat;
  if (games <= 0) return 0;
  return (((side === 'w' ? white : black) + draws / 2) / games) * 100;
}

export interface BookMove {
  uci: string;
  games: number;
  white: number;
  draws: number;
  black: number;
  /** Share of the position's (unpruned) book games in which this move was played, 0..1. */
  freq: number;
  /** Score in percent from the mover's point of view. */
  scorePct: number;
}

export class Book {
  private shards = new Map<BookBand, BookShard>();

  constructor(shards: BookShard[]) {
    for (const s of shards) this.shards.set(s.band, s);
  }

  bands(): BookBand[] {
    return BOOK_BANDS.filter((b) => this.shards.has(b));
  }

  hasBand(band: BookBand): boolean {
    return this.shards.has(band);
  }

  /** Games aggregated for the band. */
  games(band: BookBand): number {
    return this.shards.get(band)?.games ?? 0;
  }

  positionCount(band: BookBand): number {
    const s = this.shards.get(band);
    return s ? Object.keys(s.positions).length : 0;
  }

  has(band: BookBand, epd: string): boolean {
    return this.shards.get(band)?.positions[epd] !== undefined;
  }

  /** Book moves in a position, most played first. Empty when the position is not in the band's book. */
  movesAt(band: BookBand, epd: string): BookMove[] {
    const pos = this.shards.get(band)?.positions[epd];
    if (!pos) return [];
    const side = moverOfEpd(epd);
    let total = 0;
    for (const uci in pos) total += pos[uci]?.[0] ?? 0;
    const out: BookMove[] = [];
    for (const uci in pos) {
      const st = pos[uci];
      if (!st) continue;
      out.push({ uci, games: st[0], white: st[1], draws: st[2], black: st[3], freq: total ? st[0] / total : 0, scorePct: scorePct(st, side) });
    }
    return out.sort((a, b) => b.games - a.games || (a.uci < b.uci ? -1 : 1));
  }

  move(band: BookBand, epd: string, uci: string): BookMove | null {
    return this.movesAt(band, epd).find((m) => m.uci === uci) ?? null;
  }

  /** Sum of the games of all book moves in the position. */
  positionGames(band: BookBand, epd: string): number {
    const pos = this.shards.get(band)?.positions[epd];
    let total = 0;
    if (pos) for (const uci in pos) total += pos[uci]?.[0] ?? 0;
    return total;
  }
}

/* ---------- traps and structure cards (pipeline output) ---------- */

/** A move the pipeline verified with the engine as safe in a trap position. */
export interface TrapSafeMove {
  uci: string;
  san: string;
  /** Engine evaluation in centipawns from the mover's point of view. */
  cp: number;
  games: number;
  scorePct: number;
}

/**
 * traps.json items: the shared TrapItem plus the book statistics and engine-verified alternatives the
 * trap exercises need. `evalBeforeCp` / `evalAfterCp` are from the punisher's point of view.
 */
export interface OpeningTrap extends TrapItem {
  mistakeSan: string;
  mistakeGames: number;
  /** Score in percent of the mistake from the mover's point of view, and of the best-scoring popular alternative. */
  mistakeScorePct: number;
  bestAltUci: string;
  bestAltScorePct: number;
  refutationSan: string[];
  /** Popular book moves (and the engine's first choice) within the pipeline's margin of the engine's best move. */
  safeMoves: TrapSafeMove[];
}

export interface CardFlag {
  name: string;
  detail: string;
}

export interface CardContinuation {
  uci: string;
  san: string;
  games: number;
  /** Score in percent from the mover's point of view. */
  scorePct: number;
}

/** cards.json items: computed facts about a frequent late-opening position of an opening family. */
export interface StructureCard {
  id: string;
  family: string;
  /** Most specific opening name matched along the line. */
  name: string;
  /** ECO range of the family in chess-openings, e.g. "B20-B99". */
  eco: string;
  fen: string;
  epd: string;
  /** UCI line from the start position (most common order in the book). */
  line: string[];
  ply: number;
  /** Book games (all bands) that reached the position. */
  games: number;
  /** Pawn-structure label from src/engine/features (heuristic). */
  structure: string;
  /** Heuristic feature flags favouring each side. */
  flags: { w: CardFlag[]; b: CardFlag[] };
  openFiles: string[];
  bookContinuations: Partial<Record<BookBand, CardContinuation[]>>;
}
