/**
 * Tactics exercise builders: pack item -> Exercise. Pure (no React, no IO); randomness comes from the
 * `rng` argument. Every fact is derived from the Lichess puzzle itself (or, for quiet positions, from
 * the stored engine analysis), never from prose written by hand.
 */
import type { StrategyItem, TacticItem } from '../content/types';
import { positionAfterFirstMove } from '../content/tactics';
import { CONCEPT_BY_ID, TACTIC_THEME_TO_CONCEPT, TIER_MID, conceptName, primaryTacticConcept } from '../curriculum/concepts';
import { materialSignature, phaseOf, playLine, sideToMove } from '../engine/chessUtil';
import type { Exercise, ExerciseFormat, Fact, LineInteraction, Orientation } from './types';

export const DEFENSE_CONCEPT = 'tactics/subtle/defensiveMove';
export const NO_TACTIC_CONCEPT = 'tactics/awareness/noTactic';
/** A quiet position counts as "no winning tactic" only when the engine evaluation is within this bound. */
export const QUIET_MAX_ABS_CP = 150;
/** Recognising a motif / the presence of a tactic is easier than solving the puzzle. */
export const SPOT_MOTIF_OFFSET = 150;
export const TACTIC_OR_NOT_OFFSET = 150;

export type TacticOrNotSource = { kind: 'tactic'; item: TacticItem } | { kind: 'quiet'; item: StrategyItem };

type Phase = Exercise['phase'];

/**
 * Themes whose automatic Lichess tagging is broad enough that an untagged puzzle may still arguably
 * show them. They are never offered as distractors in spot-the-motif.
 */
const FUZZY_DISTRACTORS = new Set([
  'hangingPiece', 'sacrifice', 'exposedKing', 'kingsideAttack', 'queensideAttack', 'advancedPawn', 'defensiveMove', 'quietMove',
  'attackingF2F7', 'promotion',
]);

const colorName = (c: 'w' | 'b'): string => (c === 'w' ? 'White' : 'Black');
const orientationOf = (c: 'w' | 'b'): Orientation => (c === 'w' ? 'white' : 'black');
const puzzleUrl = (id: string): string => `https://lichess.org/training/${id}`;

/** Concept ids of all mapped themes of a puzzle, in theme order, without duplicates. */
function mappedConcepts(themes: string[]): string[] {
  const out: string[] = [];
  for (const th of themes) {
    const id = TACTIC_THEME_TO_CONCEPT.get(th);
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

function phaseFromThemes(themes: string[], fen: string): Phase {
  if (themes.includes('opening')) return 'opening';
  if (themes.includes('middlegame')) return 'middlegame';
  if (themes.includes('endgame')) return 'endgame';
  return phaseOf(fen);
}

interface Prepared {
  item: TacticItem;
  /** Position after the opponent's first move (what the user sees and solves). */
  fen: string;
  color: 'w' | 'b';
  preMove: string;
  solution: string[];
  solutionSan: string[];
  primary: string | null;
  concepts: string[];
  phase: Phase;
  material: string;
}

/** Replays the puzzle with chess.js; null when the item is not a legal, complete puzzle line. */
function prepare(item: TacticItem): Prepared | null {
  const preMove = item.moves[0];
  const solution = item.moves.slice(1);
  if (!preMove || solution.length === 0) return null;
  let pos: { fen: string; userColor: 'w' | 'b' };
  try {
    pos = positionAfterFirstMove(item);
  } catch {
    return null;
  }
  const line = playLine(pos.fen, solution);
  if (!line) return null;
  return {
    item,
    fen: pos.fen,
    color: pos.userColor,
    preMove,
    solution,
    solutionSan: line.sans,
    primary: primaryTacticConcept(item.themes),
    concepts: mappedConcepts(item.themes),
    phase: phaseFromThemes(item.themes, pos.fen),
    material: materialSignature(pos.fen),
  };
}

function lineInteraction(p: Prepared): LineInteraction {
  return {
    kind: 'line',
    fen: p.item.fen,
    orientation: orientationOf(p.color),
    preMoves: [p.preMove],
    solution: p.solution,
    acceptAnyMate: p.item.themes.includes('mate'),
  };
}

function motifFacts(concepts: string[]): Fact[] {
  return concepts.map((id) => ({ t: 'motif', name: conceptName(id) }));
}

function sourceFact(item: TacticItem): Fact {
  return { t: 'source', label: `Lichess puzzle ${item.id}`, url: puzzleUrl(item.id) };
}

function timeBudget(solution: string[]): number {
  return 20 + 20 * Math.ceil(solution.length / 2);
}

function shuffle<T>(xs: readonly T[], rng: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const t = a[i] as T;
    a[i] = a[j] as T;
    a[j] = t;
  }
  return a;
}

function requirePrepared(item: TacticItem): Prepared & { primary: string } {
  const p = prepare(item);
  if (!p) throw new Error(`tactic ${item.id}: not a legal puzzle line`);
  if (!p.primary) throw new Error(`tactic ${item.id}: no theme maps to a concept`);
  return p as Prepared & { primary: string };
}

/**
 * Solve the puzzle: the opponent's move is animated, then the user plays the solution.
 * Throws for items without a mapped concept or with an illegal line; pack items never are
 * (use `tacticFormatsFor` to check arbitrary items first).
 */
export function buildSolve(item: TacticItem): Exercise {
  const p = requirePrepared(item);
  return {
    id: `solve:${item.id}`,
    itemId: item.id,
    domain: 'tactics',
    conceptId: p.primary,
    secondaryConcepts: p.concepts.filter((c) => c !== p.primary),
    format: 'solve',
    difficulty: item.rating,
    difficultySource: 'lichess',
    sim: { themes: [...item.themes], material: p.material },
    phase: p.phase,
    color: p.color,
    verified: true,
    prompt: `${colorName(p.color)} to move. Find the best move.`,
    interaction: lineInteraction(p),
    facts: [{ t: 'solution', san: p.solutionSan }, ...motifFacts(p.concepts), sourceFact(item)],
    timeBudgetSec: timeBudget(p.solution),
  };
}

/**
 * Name the motif: one correct option (the puzzle's primary concept) and three distractors taken from
 * tactics concepts that are not among the puzzle's themes. Throws like `buildSolve`.
 */
export function buildSpotMotif(item: TacticItem, rng: () => number): Exercise {
  const p = requirePrepared(item);
  const own = new Set(p.concepts);
  const pool: string[] = [];
  const fallback: string[] = [];
  for (const [theme, id] of TACTIC_THEME_TO_CONCEPT) {
    if (own.has(id)) continue;
    (FUZZY_DISTRACTORS.has(theme) ? fallback : pool).push(id);
  }
  const distractors = [...shuffle(pool, rng), ...shuffle(fallback, rng)].slice(0, 3);
  const options = shuffle([p.primary, ...distractors], rng).map((id) => ({ id, label: conceptName(id) }));
  return {
    id: `spot-motif:${item.id}`,
    itemId: item.id,
    domain: 'tactics',
    conceptId: p.primary,
    secondaryConcepts: p.concepts.filter((c) => c !== p.primary),
    format: 'spot-motif',
    difficulty: item.rating - SPOT_MOTIF_OFFSET,
    difficultySource: 'tier-prior',
    sim: { themes: [...item.themes], material: p.material },
    phase: p.phase,
    color: p.color,
    verified: true,
    prompt: 'Which motif decides this position?',
    interaction: {
      kind: 'choice',
      fen: item.fen,
      orientation: orientationOf(p.color),
      preMoves: [p.preMove],
      options,
      correct: [p.primary],
      multi: false,
    },
    facts: [
      { t: 'motif', name: conceptName(p.primary) },
      { t: 'solution', san: p.solutionSan },
      { t: 'note', text: 'The motif label is the Lichess theme tag of this puzzle.' },
      sourceFact(item),
    ],
    timeBudgetSec: 30,
  };
}

/** Find the defence: only for puzzles themed `defensiveMove` or `equality`; null otherwise. */
export function buildFindDefense(item: TacticItem): Exercise | null {
  const defensive = item.themes.includes('defensiveMove');
  const equality = item.themes.includes('equality');
  if (!defensive && !equality) return null;
  const p = prepare(item);
  if (!p) return null;
  const goal = equality ? 'Find the move that holds the balance.' : 'Find the precise defensive move.';
  return {
    id: `find-defense:${item.id}`,
    itemId: item.id,
    domain: 'tactics',
    conceptId: DEFENSE_CONCEPT,
    secondaryConcepts: p.concepts.filter((c) => c !== DEFENSE_CONCEPT),
    format: 'find-defense',
    difficulty: item.rating,
    difficultySource: 'lichess',
    sim: { themes: [...item.themes], material: p.material },
    phase: p.phase,
    color: p.color,
    verified: true,
    prompt: `${colorName(p.color)} to move. ${goal}`,
    interaction: lineInteraction(p),
    facts: [
      { t: 'solution', san: p.solutionSan },
      ...motifFacts(p.concepts),
      {
        t: 'note',
        text: equality
          ? 'Lichess tags this puzzle "equality": the solution reaches a balanced position from a worse one.'
          : 'Lichess tags this puzzle "defensiveMove": a precise move is needed to avoid losing material or the advantage.',
      },
      sourceFact(item),
    ],
    timeBudgetSec: timeBudget(p.solution),
  };
}

const YES_NO = [
  { id: 'yes', label: 'Yes' },
  { id: 'no', label: 'No' },
];
const TACTIC_OR_NOT_PROMPT = 'Is there a winning tactic for the side to move?';

function formatCp(cp: number): string {
  return `${cp >= 0 ? '+' : '-'}${(Math.abs(cp) / 100).toFixed(2)}`;
}

/**
 * "Is there a winning tactic?" Tactic sources: puzzles themed `crushing` or `mate` (answer yes).
 * Quiet sources: verified strategy positions whose engine evaluation is within +-150 cp and whose
 * best move is neither a capture nor a check (answer no). Anything else returns null.
 * `_rng` is accepted for a uniform builder signature; the yes/no order is fixed.
 */
export function buildTacticOrNot(source: TacticOrNotSource, _rng: () => number): Exercise | null {
  if (source.kind === 'tactic') {
    const item = source.item;
    const mate = item.themes.includes('mate');
    if (!mate && !item.themes.includes('crushing')) return null;
    const p = prepare(item);
    if (!p) return null;
    return {
      id: `tactic-or-not:${item.id}`,
      itemId: item.id,
      domain: 'tactics',
      conceptId: NO_TACTIC_CONCEPT,
      secondaryConcepts: p.concepts,
      format: 'tactic-or-not',
      difficulty: item.rating - TACTIC_OR_NOT_OFFSET,
      difficultySource: 'tier-prior',
      sim: { themes: [...item.themes], material: p.material },
      phase: p.phase,
      color: p.color,
      verified: true,
      prompt: TACTIC_OR_NOT_PROMPT,
      interaction: {
        kind: 'choice',
        fen: item.fen,
        orientation: orientationOf(p.color),
        preMoves: [p.preMove],
        options: YES_NO,
        correct: ['yes'],
        multi: false,
      },
      facts: [
        {
          t: 'note',
          text: `Verification: this is a Lichess puzzle tagged "${mate ? 'mate' : 'crushing'}"; its solution ${mate ? 'forces checkmate' : 'reaches a decisive advantage (Lichess "crushing" tag)'}.`,
        },
        { t: 'solution', san: p.solutionSan },
        ...motifFacts(p.concepts),
        sourceFact(item),
      ],
      timeBudgetSec: 30,
    };
  }

  const item = source.item;
  if (!item.verified || !Number.isFinite(item.bestCp) || Math.abs(item.bestCp) > QUIET_MAX_ABS_CP) return null;
  const pv = item.pv.length ? item.pv : [item.best];
  if (pv[0] !== item.best) return null;
  const line = playLine(item.fen, pv);
  const bestSan = line?.sans[0];
  if (!line || !bestSan || /[x+#]/.test(bestSan)) return null;
  const color = sideToMove(item.fen);
  const tier = Math.min(TIER_MID.length - 1, Math.max(0, Math.round(item.tier)));
  return {
    id: `tactic-or-not:${item.id}`,
    itemId: item.id,
    domain: 'tactics',
    conceptId: NO_TACTIC_CONCEPT,
    format: 'tactic-or-not',
    difficulty: TIER_MID[tier] ?? 1250,
    difficultySource: 'tier-prior',
    sim: { themes: ['noTactic'], material: materialSignature(item.fen), structure: item.structure, sourceGame: item.sourceGame },
    phase: phaseOf(item.fen),
    color,
    verified: true,
    prompt: TACTIC_OR_NOT_PROMPT,
    interaction: { kind: 'choice', fen: item.fen, orientation: orientationOf(color), options: YES_NO, correct: ['no'], multi: false },
    facts: [
      {
        t: 'note',
        text: `Verification: Stockfish at depth ${item.depth} evaluates the position at ${formatCp(item.bestCp)} for the side to move, and its best move ${bestSan} is neither a capture nor a check.`,
      },
      { t: 'engine', fen: item.fen, pvSan: line.sans, cp: item.bestCp, mate: null, depth: item.depth },
      { t: 'source', label: `Lichess game ${item.sourceGame}`, url: `https://lichess.org/${item.sourceGame}` },
    ],
    timeBudgetSec: 30,
  };
}

/** Formats that can be built from a tactics item (empty when the item is not a legal puzzle line). */
export function tacticFormatsFor(item: TacticItem): ExerciseFormat[] {
  const p = prepare(item);
  if (!p) return [];
  const out: ExerciseFormat[] = [];
  if (p.primary && CONCEPT_BY_ID.has(p.primary)) out.push('solve', 'spot-motif');
  if (item.themes.includes('defensiveMove') || item.themes.includes('equality')) out.push('find-defense');
  if (item.themes.includes('mate') || item.themes.includes('crushing')) out.push('tactic-or-not');
  return out;
}
