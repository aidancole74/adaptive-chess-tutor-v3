/** Strategy bank helpers (pure). Items come from scripts/strategy/build.ts (Stockfish MultiPV over real games). */
import { FEATURE_TO_CONCEPT, parseFeatureDelta } from '../engine/features';
import { sideToMove } from '../engine/chessUtil';
import type { StrategyItem } from './types';

export const QUIET_MOVE_CONCEPT = 'strategy/planning/quiet-move';
export const CHOOSE_PLAN_CONCEPT = 'strategy/planning/choose-plan';
export const EVALUATE_TRADE_CONCEPT = 'strategy/planning/evaluate-trade';
export const WHO_IS_BETTER_CONCEPT = 'strategy/planning/who-is-better';

/** |bestCp| at or above which a who-is-better exercise is built. */
export const WHO_IS_BETTER_MIN_CP = 80;
/** |bestCp| below which whoIsBetter() reports 'equal'. */
export const EQUAL_CP = 50;

/**
 * Plan label -> strategy concept. Labels without a matching concept (pawn-break, prophylaxis, capture) map to
 * nothing; trade-offer maps to evaluating trades. The mapping is curriculum design, not a chess claim.
 */
export const PLAN_TO_CONCEPT: Readonly<Record<string, string>> = {
  'rook-to-open-file': 'strategy/files/open-file',
  'piece-to-outpost': 'strategy/squares/outpost',
  'improve-piece': 'strategy/pieces/activity',
  centralize: 'strategy/pieces/activity',
  'king-safety': 'strategy/king/king-safety',
  'attack-king': 'strategy/king/king-safety',
  develop: 'strategy/development/development',
  'gain-space': 'strategy/space/space',
  'create-passed-pawn': 'strategy/pawns/passed',
  'trade-offer': EVALUATE_TRADE_CONCEPT,
};

/** Concept of a feature delta string ("w+outpost" -> strategy/squares/outpost), or null. */
export function conceptOfDelta(delta: string): string | null {
  const d = parseFeatureDelta(delta);
  return d ? FEATURE_TO_CONCEPT[d.name] : null;
}

/**
 * Concepts an item exercises: quiet-move, the plan's concept, the concepts of every feature delta, and the
 * format concepts the item supports (choose-plan when there are >= 2 distinct plan labels, evaluate-trade when a
 * trade was evaluated, who-is-better when the engine shows a clear edge). Deduplicated, quiet-move first.
 */
export function conceptsForStrategyItem(item: StrategyItem): string[] {
  const out = new Set<string>([QUIET_MOVE_CONCEPT]);
  const pc = PLAN_TO_CONCEPT[item.plan];
  if (pc) out.add(pc);
  for (const d of item.featureDeltas) {
    const c = conceptOfDelta(d);
    if (c) out.add(c);
  }
  if (new Set([item.plan, ...item.otherPlans.map((p) => p.plan)]).size >= 2) out.add(CHOOSE_PLAN_CONCEPT);
  if (item.trade) out.add(EVALUATE_TRADE_CONCEPT);
  if (Math.abs(item.bestCp) >= WHO_IS_BETTER_MIN_CP) out.add(WHO_IS_BETTER_CONCEPT);
  return [...out];
}

/** Which side the engine prefers ('equal' when |bestCp| < 50). bestCp is from the side to move's point of view. */
export function whoIsBetter(item: Pick<StrategyItem, 'fen' | 'bestCp'>): 'w' | 'b' | 'equal' {
  if (Math.abs(item.bestCp) < EQUAL_CP) return 'equal';
  const stm = sideToMove(item.fen);
  const stmBetter = item.bestCp > 0;
  return stmBetter ? stm : stm === 'w' ? 'b' : 'w';
}

/** Evaluation from White's point of view (centipawns). */
export function whiteCp(item: Pick<StrategyItem, 'fen' | 'bestCp'>): number {
  return sideToMove(item.fen) === 'w' ? item.bestCp : -item.bestCp;
}
