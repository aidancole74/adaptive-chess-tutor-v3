/**
 * FSRS-style memory model (FSRS-4.5 formulas with its published default weights, not fitted to this user).
 * Stability S = days until recall probability drops to 90%; difficulty D in 1..10.
 */
import type { MemoryState } from './types';
import { DAY, clamp } from './math';

const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755] as const;
const FACTOR = 19 / 81;
const DECAY = -0.5;

export type Grade = 1 | 2 | 3 | 4; // again, hard, good, easy

/** Probability of recall after `days` with stability `s`. */
export function retrievability(days: number, s: number): number {
  if (days <= 0) return 1;
  return Math.pow(1 + (FACTOR * days) / s, DECAY);
}

/** Interval in days at which recall falls to `retention`. */
export function intervalFor(s: number, retention: number): number {
  return (s / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1);
}

function initDifficulty(g: Grade): number {
  return clamp(W[4] - (g - 3) * W[5], 1, 10);
}

export function recallNow(m: MemoryState, now: number): number {
  return retrievability((now - m.lastReview) / DAY, m.stability);
}

/** Apply a review. `retention` (0.8..0.95) sets the next due date. */
export function review(prev: MemoryState | undefined, conceptId: string, grade: Grade, now: number, retention: number): MemoryState {
  if (!prev || prev.phase === 'new') {
    const stability = W[grade - 1]!;
    return {
      conceptId,
      stability,
      difficulty: initDifficulty(grade),
      lastReview: now,
      due: now + Math.max(grade === 1 ? 0.007 : 0.5, intervalFor(stability, retention)) * DAY,
      reps: 1,
      lapses: grade === 1 ? 1 : 0,
      phase: grade === 1 ? 'learning' : 'review',
    };
  }
  const days = Math.max(0, (now - prev.lastReview) / DAY);
  const r = retrievability(days, prev.stability);
  const d = clamp(W[7] * initDifficulty(3) + (1 - W[7]) * (prev.difficulty - W[6] * (grade - 3)), 1, 10);
  let s: number;
  if (grade === 1) {
    s = Math.min(prev.stability, W[11] * Math.pow(d, -W[12]) * (Math.pow(prev.stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  } else {
    const hard = grade === 2 ? W[15] : 1;
    const easy = grade === 4 ? W[16] : 1;
    s = prev.stability * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(prev.stability, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
  }
  s = clamp(s, 0.01, 36500);
  return {
    conceptId,
    stability: s,
    difficulty: d,
    lastReview: now,
    due: now + Math.max(grade === 1 ? 0.007 : 0.5, intervalFor(s, retention)) * DAY,
    reps: prev.reps + 1,
    lapses: prev.lapses + (grade === 1 ? 1 : 0),
    phase: grade === 1 ? 'learning' : 'review',
  };
}

/** Map an exercise outcome to an FSRS grade. */
export function gradeFor(solved: boolean, hintsUsed: number, timeMs: number, budgetMs: number, confidence?: number): Grade {
  if (!solved) return 1;
  if (hintsUsed > 0 || timeMs > budgetMs * 1.5) return 2;
  if (timeMs < budgetMs * 0.35 && (confidence === undefined || confidence >= 4)) return 4;
  return 3;
}
