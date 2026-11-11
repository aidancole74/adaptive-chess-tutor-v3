/**
 * Opening exercise builders (pure): repertoire lines, deviations, traps and structure cards.
 * Prompts and card bodies are templates over pipeline facts (book counts, engine evaluations, computed
 * features); no opening theory is written here.
 *
 * Difficulty is a 'tier-prior' on the puzzle-rating scale until the learner model has data:
 *  - opening-line:      800 + 40 per ply of depth + 60 per halving of the line's likelihood
 *                       (opponentFreqProduct; rarer lines are met less often and remembered worse), 600..2000.
 *  - opening-deviation: 1300 + 20 per ply, capped at 1700 (no memorised answer to lean on).
 *  - trap avoid:        1000 + 4 per percentage point of games in which the mistake is played (more tempting = harder), max 1500.
 *  - trap punish:       1200 + 50 per extra user move in the refutation, minus up to 200 for a large evaluation swing.
 *  - structure-card:    1000 (cards are reviewed by memory scheduling, not by difficulty).
 */
import { Chess } from 'chess.js';
import { familyOf, type Book, type OpeningTrap, type StructureCard } from '../content/openings';
import type { RepertoireNode } from '../content/repertoire';
import type { BookBand } from '../content/types';
import { START_FEN, materialSignature, playLine, sideToMove, tryMove } from '../engine/chessUtil';
import type { Exercise, Fact, Orientation } from './types';

const orient = (c: 'w' | 'b'): Orientation => (c === 'w' ? 'white' : 'black');
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, Math.round(x)));
const sideName = (c: 'w' | 'b'): string => (c === 'w' ? 'White' : 'Black');

function sanOf(fen: string, uci: string): string | null {
  return playLine(fen, [uci])?.sans[0] ?? null;
}

/** Book fact for a position: the band's top moves with games and score for the mover. */
export function bookFact(book: Book, band: BookBand, fen: string, epd: string, max = 5): Fact | null {
  const moves = book.movesAt(band, epd).slice(0, max);
  const out: { san: string; games: number; scorePct: number }[] = [];
  for (const m of moves) {
    const san = sanOf(fen, m.uci);
    if (san) out.push({ san, games: m.games, scorePct: Math.round(m.scorePct * 10) / 10 });
  }
  return out.length ? { t: 'book', band, moves: out } : null;
}

export function openingLineDifficulty(ply: number, opponentFreqProduct: number): number {
  const halvings = Math.min(10, Math.max(0, -Math.log2(Math.max(opponentFreqProduct, 1e-6))));
  return clamp(800 + 40 * ply + 60 * halvings, 600, 2000);
}

/** One repertoire node -> "play your move" line exercise. Pass `book` + `band` to attach the book fact. */
export function buildOpeningLine(node: RepertoireNode, color: 'w' | 'b', ctx: { book?: Book; band?: BookBand } = {}): Exercise {
  const memoryKey = `op:${color}:${node.epd}`;
  const facts: Fact[] = [];
  const san = sanOf(node.fen, node.userMove);
  if (san) facts.push({ t: 'solution', san: [san] });
  if (ctx.book && ctx.band) {
    const bf = bookFact(ctx.book, ctx.band, node.fen, node.epd);
    if (bf) facts.push(bf);
  }
  if (node.openingName) facts.push({ t: 'note', text: `Opening: ${node.openingName}` });
  const themes = ['opening-line'];
  if (node.openingName) themes.push(familyOf(node.openingName));
  return {
    id: `opening-line:${color}:${node.epd}`,
    itemId: memoryKey,
    domain: 'openings',
    conceptId: color === 'w' ? 'openings/repertoire/white-lines' : 'openings/repertoire/black-lines',
    format: 'opening-line',
    difficulty: openingLineDifficulty(node.ply, node.opponentFreqProduct),
    difficultySource: 'tier-prior',
    sim: { themes, material: materialSignature(node.fen) },
    phase: 'opening',
    color,
    memoryKey,
    verified: san !== null,
    prompt: node.openingName ? `Your repertoire move as ${sideName(color)} (${node.openingName}).` : `Your repertoire move as ${sideName(color)}.`,
    interaction: { kind: 'line', fen: START_FEN, orientation: orient(color), preMoves: node.line, solution: [node.userMove] },
    facts,
    timeBudgetSec: 20,
  };
}

export interface DeviationPosition {
  /** Position BEFORE the opponent's off-repertoire move (opponent to move). */
  fen: string;
  /** UCI line from the start position leading to `fen`. */
  line: string[];
  /** The move the opponent actually played. */
  opponentMove: string;
  /** What the book has in that position (for the explanation), most played first. */
  bookMoves: { uci: string; games: number; scorePct: number }[];
  band?: BookBand;
}

/**
 * The opponent left the repertoire: find a good reply. `acceptable` is supplied by the caller (engine best
 * within a margin and/or top book moves); `engineFact` is attached when given. Returns null when the opponent
 * move is illegal or no acceptable move is legal.
 */
export function buildDeviation(position: DeviationPosition, acceptable: string[], engineFact?: Extract<Fact, { t: 'engine' }>): Exercise | null {
  const before = playLine(position.fen, [position.opponentMove]);
  if (!before) return null;
  const after = before.chess.fen();
  const legal = [...new Set(acceptable)].filter((u) => playLine(after, [u]) !== null);
  const first = legal[0];
  if (!first) return null;
  const color = sideToMove(after);
  const oppSan = before.sans[0] as string;
  const facts: Fact[] = [{ t: 'solution', san: legal.map((u) => sanOf(after, u) ?? u) }];
  if (engineFact) facts.push(engineFact);
  const bm: { san: string; games: number; scorePct: number }[] = [];
  for (const m of position.bookMoves.slice(0, 5)) {
    const san = sanOf(position.fen, m.uci);
    if (san) bm.push({ san, games: m.games, scorePct: Math.round(m.scorePct * 10) / 10 });
  }
  if (bm.length) facts.push({ t: 'book', band: position.band ?? 'book', moves: bm });
  const ply = position.line.length + 1;
  const id = `opening-deviation:${after.split(' ').slice(0, 4).join(' ')}`;
  return {
    id,
    itemId: id,
    domain: 'openings',
    conceptId: 'openings/skills/deviation',
    format: 'opening-deviation',
    difficulty: clamp(1300 + 20 * ply, 1300, 1700),
    difficultySource: 'tier-prior',
    sim: { themes: ['opening-deviation'], material: materialSignature(after) },
    phase: 'opening',
    color,
    verified: true,
    prompt: `Your opponent left your repertoire with ${oppSan}. Find a good reply for ${sideName(color)}.`,
    interaction: {
      kind: 'line',
      fen: position.fen,
      orientation: orient(color),
      preMoves: [position.opponentMove],
      solution: [first],
      ...(legal.length > 1 ? { alternatives: { 0: legal.slice(1) } } : {}),
    },
    facts,
    timeBudgetSec: 60,
  };
}

function trapSource(trap: OpeningTrap): Fact {
  return {
    t: 'note',
    text:
      `In the ${trap.band} book ${trap.mistakeSan} is played in ${Math.round(trap.mistakeFreq * 100)}% of games (${trap.mistakeGames}) and scores ` +
      `${trap.mistakeScorePct.toFixed(0)}% for ${sideName(sideToMove(trap.fen))}; the best-scoring popular alternative scores ${trap.bestAltScorePct.toFixed(0)}%.`,
  };
}

function engineFactAfterMistake(trap: OpeningTrap): Fact | null {
  const after = playLine(trap.fen, [trap.mistake]);
  if (!after) return null;
  return { t: 'engine', fen: after.chess.fen(), pvSan: trap.refutationSan, cp: trap.evalAfterCp, mate: null, depth: trap.depth };
}

/**
 * Trap position, user is the side that commonly goes wrong: choose a move. Options are the mistake plus the
 * pipeline's engine-verified safe moves (nothing else is offered). Returns null without a verified safe move.
 */
export function buildTrapAvoid(trap: OpeningTrap): Exercise | null {
  if (!trap.verified || trap.safeMoves.length === 0) return null;
  const color = sideToMove(trap.fen);
  const safe = trap.safeMoves.filter((m) => m.uci !== trap.mistake).slice(0, 3);
  if (safe.length === 0 || !playLine(trap.fen, [trap.mistake])) return null;
  // Deterministic option order: alphabetical by SAN, so the mistake has no fixed slot.
  const options = [{ id: trap.mistake, label: trap.mistakeSan }, ...safe.map((m) => ({ id: m.uci, label: m.san }))].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const facts: Fact[] = [trapSource(trap)];
  const ef = engineFactAfterMistake(trap);
  if (ef) facts.push(ef);
  facts.push({ t: 'solution', san: safe.map((m) => m.san) });
  if (trap.openingName) facts.push({ t: 'note', text: `Opening: ${trap.openingName}` });
  const id = `trap-avoid:${trap.id}`;
  return {
    id,
    itemId: trap.id,
    domain: 'openings',
    conceptId: 'openings/skills/traps',
    format: 'opening-trap',
    difficulty: clamp(1000 + 400 * trap.mistakeFreq, 1000, 1500),
    difficultySource: 'tier-prior',
    sim: { themes: ['opening-trap', 'trap-avoid', ...(trap.openingName ? [familyOf(trap.openingName)] : [])], material: materialSignature(trap.fen) },
    phase: 'opening',
    color,
    verified: true,
    prompt: `${sideName(color)} to move${trap.openingName ? ` (${trap.openingName})` : ''}. One of these popular moves is a mistake - choose a safe move.`,
    interaction: { kind: 'choice', fen: trap.fen, orientation: orient(color), options, correct: safe.map((m) => m.uci), multi: false },
    facts,
    timeBudgetSec: 45,
  };
}

/** Position after the common mistake, user is the punisher: play the engine refutation. */
export function buildTrapPunish(trap: OpeningTrap): Exercise | null {
  if (!trap.verified || trap.refutation.length === 0) return null;
  const chess = new Chess(trap.fen);
  if (!tryMove(chess, trap.mistake)) return null;
  const after = chess.fen();
  // Keep an odd number of plies (ends on the user's move), at most 3 user moves, and only legal moves.
  const solution: string[] = [];
  for (const u of trap.refutation.slice(0, 5)) {
    if (!tryMove(chess, u)) break;
    solution.push(u);
  }
  if (solution.length % 2 === 0) solution.pop();
  if (solution.length === 0) return null;
  const color = sideToMove(after);
  const swing = trap.evalAfterCp - trap.evalBeforeCp;
  const userMoves = (solution.length + 1) / 2;
  const facts: Fact[] = [];
  const ef = engineFactAfterMistake(trap);
  if (ef) facts.push(ef);
  facts.push({ t: 'solution', san: trap.refutationSan.slice(0, solution.length) }, trapSource(trap));
  if (trap.openingName) facts.push({ t: 'note', text: `Opening: ${trap.openingName}` });
  const id = `trap-punish:${trap.id}`;
  return {
    id,
    itemId: trap.id,
    domain: 'openings',
    conceptId: 'openings/skills/traps',
    format: 'opening-trap',
    difficulty: clamp(1200 + 50 * (userMoves - 1) - Math.min(200, Math.max(0, (swing - 150) / 4)), 1000, 1600),
    difficultySource: 'tier-prior',
    sim: { themes: ['opening-trap', 'trap-punish', ...(trap.openingName ? [familyOf(trap.openingName)] : [])], material: materialSignature(after) },
    phase: 'opening',
    color,
    verified: true,
    prompt: `Your opponent just played the common mistake ${trap.mistakeSan}. Punish it.`,
    interaction: { kind: 'line', fen: trap.fen, orientation: orient(color), preMoves: [trap.mistake], solution },
    facts,
    timeBudgetSec: 90,
  };
}

const pct = (x: number): string => `${x.toFixed(0)}%`;

/** Paragraphs for a structure card, generated only from the card's computed facts. */
export function structureCardBody(card: StructureCard): string[] {
  const body: string[] = [];
  const mover = sideToMove(card.fen);
  body.push(`Reached after ${card.ply} plies in ${card.games} book games (${card.name || card.family}, ECO ${card.eco}). ${sideName(mover)} to move.`);
  body.push(`Pawn structure (heuristic label): ${card.structure}. Open files: ${card.openFiles.length ? card.openFiles.join(', ') : 'none'}.`);
  for (const side of ['w', 'b'] as const) {
    const flags = card.flags[side];
    if (flags.length) body.push(`Features favouring ${sideName(side)} (heuristic): ${flags.map((f) => (f.detail ? `${f.name} - ${f.detail}` : f.name)).join('; ')}.`);
  }
  for (const [band, moves] of Object.entries(card.bookContinuations)) {
    if (!moves || moves.length === 0) continue;
    body.push(`Most played at ${band}: ${moves.map((m) => `${m.san} (${m.games} games, ${pct(m.scorePct)} for ${sideName(mover)})`).join(', ')}.`);
  }
  return body;
}

export function buildStructureCard(card: StructureCard): Exercise {
  const facts: Fact[] = [];
  for (const side of ['w', 'b'] as const) for (const f of card.flags[side]) facts.push({ t: 'feature', name: f.name, side, detail: f.detail, heuristic: true });
  for (const [band, moves] of Object.entries(card.bookContinuations)) {
    if (moves && moves.length) facts.push({ t: 'book', band, moves: moves.map((m) => ({ san: m.san, games: m.games, scorePct: m.scorePct })) });
  }
  facts.push({ t: 'source', label: 'Lichess rated games (CC0) and lichess-org/chess-openings (CC0); features computed heuristically' });
  return {
    id: `structure-card:${card.id}`,
    itemId: card.id,
    domain: 'openings',
    conceptId: 'openings/skills/structures',
    format: 'structure-card',
    difficulty: 1000,
    difficultySource: 'tier-prior',
    sim: { themes: ['structure-card', card.family], material: materialSignature(card.fen), structure: card.structure },
    phase: 'opening',
    color: sideToMove(card.fen),
    memoryKey: `card:${card.id}`,
    verified: true,
    prompt: `Typical position: ${card.family}. Study the structure and the most played continuations.`,
    interaction: { kind: 'card', fen: card.fen, orientation: 'white', title: `${card.family} - typical position`, body: structureCardBody(card) },
    facts,
    timeBudgetSec: 60,
  };
}
