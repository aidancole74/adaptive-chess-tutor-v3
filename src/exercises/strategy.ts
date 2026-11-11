/**
 * Strategy exercise builders (pure; RNG passed in). Items come from the engine-verified strategy bank.
 * Every evaluation shown comes from the item's Stockfish analysis; every feature description comes from the
 * static feature extractors and is marked heuristic. No chess claims are written here.
 *
 * Concept choice for quiet-best-move: when the best move GAINS a feature flag for the side to move (a delta
 * "<stm>+name"), the exercise is filed under that feature's concept (e.g. a move that occupies an outpost trains
 * strategy/squares/outpost); otherwise strategy/planning/quiet-move. The remaining item concepts are secondary.
 */
import {
  CHOOSE_PLAN_CONCEPT, EVALUATE_TRADE_CONCEPT, QUIET_MOVE_CONCEPT, WHO_IS_BETTER_CONCEPT, WHO_IS_BETTER_MIN_CP,
  conceptOfDelta, conceptsForStrategyItem, whiteCp, whoIsBetter,
} from '../content/strategy';
import type { StrategyItem } from '../content/types';
import { TIER_MID } from '../curriculum/concepts';
import { materialSignature, phaseOf, playLine, sanLine, sideToMove } from '../engine/chessUtil';
import { PLAN_LABELS, extractFeatures, featureFlags, parseFeatureDelta, type PlanLabel } from '../engine/features';
import type { Exercise, ExerciseFormat, Fact, Orientation } from './types';

const orient = (c: 'w' | 'b'): Orientation => (c === 'w' ? 'white' : 'black');
const sideName = (c: 'w' | 'b'): string => (c === 'w' ? 'White' : 'Black');

/** Accepted alternatives for quiet-best-move: other MultiPV first moves within this many cp of best. */
export const ALT_WITHIN_CP = 25;

function shuffle<T>(xs: T[], rng: () => number): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function difficultyOf(item: StrategyItem): number {
  return TIER_MID[Math.max(0, Math.min(TIER_MID.length - 1, item.tier))]!;
}

function planLabel(plan: string): string {
  return PLAN_LABELS[plan as PlanLabel] ?? plan;
}

function pawns(cp: number): string {
  return `${cp >= 0 ? '+' : ''}${(cp / 100).toFixed(2)}`;
}

export function engineFact(item: StrategyItem): Extract<Fact, { t: 'engine' }> {
  return { t: 'engine', fen: item.fen, pvSan: sanLine(item.fen, item.pv), cp: item.bestCp, mate: null, depth: item.depth };
}

export function sourceFact(item: StrategyItem): Extract<Fact, { t: 'source' }> {
  return { t: 'source', label: `Lichess game ${item.sourceGame}, after ply ${item.ply}`, url: `https://lichess.org/${item.sourceGame}` };
}

/** Feature facts (heuristic) for the item's feature deltas, with the extractor's factual detail strings. */
export function deltaFacts(item: StrategyItem): Extract<Fact, { t: 'feature' }>[] {
  if (item.featureDeltas.length === 0) return [];
  const after = playLine(item.fen, [item.best]);
  if (!after) return [];
  const flagsBefore = featureFlags(extractFeatures(item.fen));
  const flagsAfter = featureFlags(extractFeatures(after.chess.fen()));
  const out: Extract<Fact, { t: 'feature' }>[] = [];
  for (const d of item.featureDeltas) {
    const p = parseFeatureDelta(d);
    if (!p) continue;
    const src = p.gained ? flagsAfter : flagsBefore;
    const flag = src.find((f) => f.name === p.name && f.side === p.side);
    const base = flag?.detail ?? `${p.name} (${sideName(p.side)})`;
    out.push({ t: 'feature', name: p.name, side: p.side, detail: p.gained ? `After the move: ${base}` : `No longer true after the move: ${base}`, heuristic: true });
  }
  return out;
}

const HEURISTIC_NOTE: Fact = {
  t: 'note',
  text: 'Feature and plan labels are heuristic descriptions computed from the board; the evaluation comes from Stockfish.',
};

function base(item: StrategyItem, format: ExerciseFormat, conceptId: string): Omit<Exercise, 'prompt' | 'interaction' | 'facts'> {
  const secondary = conceptsForStrategyItem(item).filter((c) => c !== conceptId);
  return {
    id: `${format}:${item.id}`,
    itemId: item.id,
    domain: 'strategy',
    conceptId,
    secondaryConcepts: secondary.length ? secondary : undefined,
    format,
    difficulty: difficultyOf(item),
    difficultySource: 'tier-prior',
    sim: { themes: [item.plan, ...item.featureDeltas], material: materialSignature(item.fen), structure: item.structure, sourceGame: item.sourceGame },
    phase: phaseOf(item.fen),
    color: sideToMove(item.fen),
    verified: item.verified,
  };
}

/** Concept for quiet-best-move: first feature the side to move gains with the best move, else quiet-move. */
export function quietMoveConcept(item: StrategyItem): string {
  const stm = sideToMove(item.fen);
  for (const d of item.featureDeltas) {
    const p = parseFeatureDelta(d);
    if (p && p.gained && p.side === stm) {
      const c = conceptOfDelta(d);
      if (c) return c;
    }
  }
  return QUIET_MOVE_CONCEPT;
}

/** Find the engine's clearly best quiet move. */
export function buildQuietBestMove(item: StrategyItem): Exercise | null {
  if (!playLine(item.fen, [item.best])) return null;
  const stm = sideToMove(item.fen);
  const alts = item.lines.filter((l) => l.uci !== item.best && item.bestCp - l.cp <= ALT_WITHIN_CP && playLine(item.fen, [l.uci])).map((l) => l.uci);
  const bestSan = sanLine(item.fen, [item.best]);
  const facts: Fact[] = [{ t: 'solution', san: bestSan }, engineFact(item), ...deltaFacts(item), HEURISTIC_NOTE, sourceFact(item)];
  return {
    ...base(item, 'quiet-best-move', quietMoveConcept(item)),
    prompt: `${sideName(stm)} to move. No tactics here: find the best quiet move.`,
    interaction: {
      kind: 'line',
      fen: item.fen,
      orientation: orient(stm),
      preMoves: [],
      solution: [item.best],
      ...(alts.length ? { alternatives: { 0: alts } } : {}),
    },
    facts,
    timeBudgetSec: 90,
  };
}

/**
 * Who is better and why: one multi-select ChoiceInteraction. Options are "White is better" / "Black is better"
 * plus every feature flag present in the position (the extractor's factual detail). Correct = the side the engine
 * prefers plus the flags conventionally favouring that side. Null when |bestCp| < 80 or there are no flags.
 */
export function buildWhoIsBetter(item: StrategyItem, rng: () => number): Exercise | null {
  if (Math.abs(item.bestCp) < WHO_IS_BETTER_MIN_CP) return null;
  const better = whoIsBetter(item);
  if (better === 'equal') return null;
  const flags = featureFlags(extractFeatures(item.fen));
  if (flags.length === 0) return null;
  const featureOptions = shuffle(
    flags.map((f) => ({ id: `f:${f.side}:${f.name}`, label: f.detail, side: f.side })),
    rng,
  );
  const options = [
    { id: 'side:w', label: 'White is better' },
    { id: 'side:b', label: 'Black is better' },
    ...featureOptions.map(({ id, label }) => ({ id, label })),
  ];
  const correct = [`side:${better}`, ...featureOptions.filter((o) => o.side === better).map((o) => o.id)];
  const stm = sideToMove(item.fen);
  const facts: Fact[] = [
    engineFact(item),
    { t: 'note', text: `Stockfish (depth ${item.depth}) evaluates the position at ${pawns(whiteCp(item))} from White's point of view.` },
    {
      t: 'note',
      text: 'Which features "favour" a side is a heuristic convention (for example, an isolated pawn is listed as favouring its opponent); the engine evaluation does not say which features caused it.',
    },
    ...flags.map((f): Fact => ({ t: 'feature', name: f.name, side: f.side, detail: f.detail, heuristic: true })),
    sourceFact(item),
  ];
  return {
    ...base(item, 'who-is-better', WHO_IS_BETTER_CONCEPT),
    prompt: `${sideName(stm)} to move. Who is better? Select the side, then every feature that (heuristically) favours that side.`,
    interaction: { kind: 'choice', fen: item.fen, orientation: orient(stm), options, correct, multi: true },
    facts,
    timeBudgetSec: 75,
  };
}

/** Choose the plan behind the engine's best move among the plan labels of clearly worse alternatives. */
export function buildChoosePlan(item: StrategyItem, rng: () => number): Exercise | null {
  const labels: string[] = [item.plan];
  for (const p of item.otherPlans) {
    if (labels.length >= 4) break;
    if (!labels.includes(p.plan)) labels.push(p.plan);
  }
  if (labels.length < 2) return null;
  const options = shuffle(labels.map((p) => ({ id: `plan:${p}`, label: planLabel(p) })), rng);
  const stm = sideToMove(item.fen);
  const bestSan = sanLine(item.fen, [item.best]);
  const facts: Fact[] = [
    { t: 'solution', san: bestSan },
    engineFact(item),
    {
      t: 'note',
      text: `Plan labels are heuristic descriptions of what each move does on the board. The engine's best move (${bestSan.join('')}) is labelled "${planLabel(item.plan)}".`,
    },
    ...item.otherPlans.slice(0, 3).map((p): Fact => ({
      t: 'note',
      text: `${sanLine(item.fen, [p.uci]).join('') || p.uci} ("${planLabel(p.plan)}") is ${(p.cpLoss / 100).toFixed(2)} pawns worse according to Stockfish.`,
    })),
    ...deltaFacts(item),
    sourceFact(item),
  ];
  return {
    ...base(item, 'choose-plan', CHOOSE_PLAN_CONCEPT),
    prompt: `${sideName(stm)} to move. Which plan does the strongest move follow?`,
    interaction: { kind: 'choice', fen: item.fen, orientation: orient(stm), options, correct: [`plan:${item.plan}`], multi: false },
    facts,
    timeBudgetSec: 60,
  };
}

const VERDICT_LABEL: Record<'good' | 'neutral' | 'bad', string> = {
  good: 'Good trade (about as strong as the best move)',
  neutral: 'Playable but not best',
  bad: 'Bad trade (clearly worse than the best move)',
};

/** Evaluate the equal-material trade available in the position: good / neutral / bad by engine cp loss. */
export function buildEvaluateTrade(item: StrategyItem): Exercise | null {
  const trade = item.trade;
  if (!trade) return null;
  const san = sanLine(item.fen, [trade.uci]);
  if (san.length === 0) return null;
  const stm = sideToMove(item.fen);
  const loss = item.bestCp - trade.cp;
  const options = (['good', 'neutral', 'bad'] as const).map((v) => ({ id: v, label: VERDICT_LABEL[v] }));
  const facts: Fact[] = [
    engineFact(item),
    {
      t: 'note',
      text: `Stockfish (depth ${item.depth}): after ${san[0]} the evaluation is ${pawns(trade.cp)} for ${sideName(stm)}, versus ${pawns(item.bestCp)} after the best move ${sanLine(item.fen, [item.best]).join('')} (a loss of ${(Math.max(0, loss) / 100).toFixed(2)}). Good = within 0.30, playable = within 1.00.`,
    },
    sourceFact(item),
  ];
  return {
    ...base(item, 'evaluate-trade', EVALUATE_TRADE_CONCEPT),
    prompt: `${sideName(stm)} to move. How good is the trade ${san[0]}?`,
    interaction: {
      kind: 'choice',
      fen: item.fen,
      orientation: orient(stm),
      options,
      correct: [trade.verdict],
      multi: false,
      highlight: [trade.uci.slice(0, 2), trade.uci.slice(2, 4)],
    },
    facts,
    timeBudgetSec: 60,
  };
}

/** Every exercise an item supports. */
export function buildStrategyExercises(item: StrategyItem, rng: () => number): Exercise[] {
  return [buildQuietBestMove(item), buildWhoIsBetter(item, rng), buildChoosePlan(item, rng), buildEvaluateTrade(item)].filter(
    (e): e is Exercise => e !== null,
  );
}
