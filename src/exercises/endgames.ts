/**
 * Endgame exercise builders: EndgameItem -> Exercise. Pure (no React, no IO). Every fact comes from
 * the tablebase result stored in the item at build time (scripts/endgames/build.ts).
 * The builders are deterministic; the `rng` argument exists for a uniform builder signature.
 */
import type { EndgameItem, TbCategory } from '../content/types';
import { CONCEPT_BY_ID, TIER_MID } from '../curriculum/concepts';
import { materialSignature, sideToMove } from '../engine/chessUtil';
import type { ChoiceInteraction, Exercise, ExerciseFormat, Fact, LineInteraction, Orientation, PlayoutInteraction } from './types';

const colorName = (c: 'w' | 'b'): string => (c === 'w' ? 'White' : 'Black');
const orientationOf = (c: 'w' | 'b'): Orientation => (c === 'w' ? 'white' : 'black');

export const WIN_OR_DRAW_OPTIONS: { id: TbCategory; label: string }[] = [
  { id: 'win', label: 'Side to move wins' },
  { id: 'draw', label: 'Draw' },
  { id: 'loss', label: 'Side to move loses' },
];

function difficultyOf(item: EndgameItem): number {
  const t = Math.max(0, Math.min(TIER_MID.length - 1, Math.round(item.tier)));
  return TIER_MID[t] ?? TIER_MID[0] ?? 650;
}

export function bestSan(item: EndgameItem): string[] {
  return item.best.map((u) => item.moves.find((m) => m.uci === u)?.san ?? u);
}

export function tablebaseFact(item: EndgameItem): Fact {
  return { t: 'tablebase', fen: item.fen, category: item.category, dtm: item.dtm, bestSan: bestSan(item) };
}

const SOURCE_FACT: Fact = { t: 'source', label: 'Lichess tablebase', url: 'https://tablebase.lichess.ovh' };

function base(item: EndgameItem, format: ExerciseFormat): Omit<Exercise, 'prompt' | 'interaction' | 'facts' | 'timeBudgetSec'> {
  const color = sideToMove(item.fen);
  const memory = CONCEPT_BY_ID.get(item.concept)?.memory === true;
  return {
    id: `${format}:${item.id}`,
    itemId: item.id,
    domain: 'endgames',
    conceptId: item.concept,
    format,
    difficulty: difficultyOf(item),
    difficultySource: 'tier-prior',
    sim: { themes: [item.concept], material: materialSignature(item.fen) },
    phase: 'endgame',
    color,
    ...(memory ? { memoryKey: `eg:${item.id}` } : {}),
    verified: item.verified,
  };
}

function goalText(category: TbCategory): string {
  return category === 'win' ? 'win' : category === 'draw' ? 'hold the draw' : 'resist as long as possible';
}

/** Find a move that keeps the tablebase result. Every move in item.best is accepted. */
export function buildEgBestMove(item: EndgameItem, _rng?: () => number): Exercise {
  const color = sideToMove(item.fen);
  const [first, ...rest] = item.best;
  const interaction: LineInteraction = {
    kind: 'line',
    fen: item.fen,
    orientation: orientationOf(color),
    preMoves: [],
    solution: first ? [first] : [],
    ...(rest.length ? { alternatives: { 0: rest } } : {}),
    acceptAnyMate: item.category === 'win',
  };
  const only = item.onlyMove ? ' There is exactly one move that does it.' : '';
  return {
    ...base(item, 'eg-best-move'),
    prompt: `${colorName(color)} to move and ${goalText(item.category)}. Find a move that keeps the result.${only}`,
    interaction,
    facts: [tablebaseFact(item), SOURCE_FACT],
    timeBudgetSec: item.onlyMove ? 90 : 60,
  };
}

/** Judge the position: win, draw or loss for the side to move. */
export function buildEgWinOrDraw(item: EndgameItem, _rng?: () => number): Exercise {
  const color = sideToMove(item.fen);
  const interaction: ChoiceInteraction = {
    kind: 'choice',
    fen: item.fen,
    orientation: orientationOf(color),
    options: WIN_OR_DRAW_OPTIONS.map((o) => ({ ...o })),
    correct: [item.category],
    multi: false,
  };
  return {
    ...base(item, 'eg-win-or-draw'),
    prompt: `${colorName(color)} to move. With best play, what is the result for ${colorName(color)}?`,
    interaction,
    facts: [tablebaseFact(item), SOURCE_FACT],
    timeBudgetSec: 45,
  };
}

/** Play the position out against the tablebase. Null when the item is not a play-out item. */
export function buildEgPlayout(item: EndgameItem, _rng?: () => number): Exercise | null {
  if (item.playoutTarget === null || item.category === 'loss') return null;
  const color = sideToMove(item.fen);
  const moves = item.playoutTarget;
  const interaction: PlayoutInteraction = {
    kind: 'playout',
    fen: item.fen,
    orientation: orientationOf(color),
    opponent: 'tablebase',
    objective: item.category === 'win' ? { type: 'mate-within', moves } : { type: 'draw', moves },
  };
  const prompt =
    item.category === 'win'
      ? `${colorName(color)} to move: deliver mate within ${moves} moves against perfect defence.`
      : `${colorName(color)} to move: hold the draw for ${moves} moves against the tablebase.`;
  return {
    ...base(item, 'eg-playout'),
    prompt,
    interaction,
    facts: [tablebaseFact(item), SOURCE_FACT],
    timeBudgetSec: 30 + 15 * moves,
  };
}
