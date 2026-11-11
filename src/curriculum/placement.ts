/**
 * 15-puzzle adaptive placement test: a single-ability Glicko estimate, each next puzzle chosen at the
 * current estimate (maximum information) from a different concept than the last few.
 */
import { glickoUpdate, SIGMA_INIT } from '../model/math';
import { primaryTacticConcept } from './concepts';
import type { TacticItem } from '../content/types';

export const PLACEMENT_ITEMS = 15;

export interface PlacementState {
  theta: number;
  sigma: number;
  asked: { id: string; rating: number; concept: string; solved: boolean }[];
}

export function newPlacement(start = 1200): PlacementState {
  return { theta: start, sigma: SIGMA_INIT, asked: [] };
}

export function placementDone(s: PlacementState): boolean {
  return s.asked.length >= PLACEMENT_ITEMS;
}

/** Next puzzle: nearest rating to the estimate, popular-theme diversity, never repeated. */
export function nextPlacementItem(s: PlacementState, items: TacticItem[], rng: () => number): TacticItem | null {
  const used = new Set(s.asked.map((a) => a.id));
  const recent = new Set(s.asked.slice(-4).map((a) => a.concept));
  // Short, well-rated puzzles only: placement should measure, not exhaust.
  const pool = items.filter((i) => !used.has(i.id) && i.moves.length <= 6 && i.rd <= 80);
  let best: TacticItem | null = null;
  let bestScore = Infinity;
  for (let k = 0; k < 400 && pool.length > 0; k++) {
    const it = pool[Math.floor(rng() * pool.length)]!;
    const concept = primaryTacticConcept(it.themes) ?? '';
    const score = Math.abs(it.rating - s.theta) + (recent.has(concept) ? 250 : 0);
    if (score < bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best;
}

export function recordPlacement(s: PlacementState, item: TacticItem, solved: boolean): PlacementState {
  const u = glickoUpdate(s.theta, s.sigma, s.theta, item.rating, solved ? 1 : 0, item.rd);
  return {
    theta: Math.max(400, Math.min(3000, u.theta)),
    sigma: u.sigma,
    asked: [...s.asked, { id: item.id, rating: item.rating, concept: primaryTacticConcept(item.themes) ?? '', solved }],
  };
}

/** Honest range for the result: ±2 sigma. */
export function placementRange(s: PlacementState): [number, number] {
  return [Math.round(s.theta - 2 * s.sigma), Math.round(s.theta + 2 * s.sigma)];
}
