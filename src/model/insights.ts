/** Derived views of the learner model for the dashboard (pure). */
import { CONCEPTS, type ConceptDef } from '../curriculum/concepts';
import { DOMAINS, type Domain } from '../content/types';
import { ERROR_CAUSES, type ErrorCause } from '../exercises/types';
import { estimate, mastery } from './learner';
import { DAY } from './math';
import type { LearnerState } from './types';

export interface HeatCell {
  def: ConceptDef;
  theta: number;
  sigma: number;
  mastery: number;
  n: number;
  rate: number | null;
}

export function heatmap(state: LearnerState, now: number): Map<Domain, HeatCell[]> {
  const out = new Map<Domain, HeatCell[]>(DOMAINS.map((d) => [d, []]));
  for (const def of CONCEPTS) {
    const e = estimate(state, def.id, now);
    const node = state.nodes[def.id];
    out.get(def.domain)!.push({ def, theta: e.theta, sigma: e.sigma, mastery: mastery(state, def.id, now).value, n: node?.n ?? 0, rate: node && node.n ? node.solved / node.n : null });
  }
  return out;
}

/** Weekly global rating trend from the attempt history (replays nothing: uses the per-attempt predictions). */
export function trend(state: LearnerState, now: number, weeks = 8): { week: number; attempts: number; solveRate: number | null; meanDifficulty: number | null }[] {
  const rows: { week: number; attempts: number; solveRate: number | null; meanDifficulty: number | null }[] = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const lo = now - (w + 1) * 7 * DAY;
    const hi = now - w * 7 * DAY;
    const hs = state.history.filter((h) => h.t >= lo && h.t < hi && h.format !== 'lesson');
    rows.push({
      week: -w,
      attempts: hs.length,
      solveRate: hs.length ? hs.filter((h) => h.solved).length / hs.length : null,
      meanDifficulty: hs.length ? hs.reduce((a, h) => a + h.difficulty, 0) / hs.length : null,
    });
  }
  return rows;
}

export function causeBreakdown(state: LearnerState): { cause: ErrorCause; n: number }[] {
  const m = state.causes['*'] ?? {};
  return ERROR_CAUSES.map((c) => ({ cause: c, n: m[c] ?? 0 }));
}

export interface Forecast {
  current: number;
  sigma: number;
  /** Estimated weekly gain from the last 4 weeks of practice, with an honest range. */
  weeklyGain: { mean: number; lo: number; hi: number } | null;
  /** Projected rating at the goal date (80% range), or null when there is not enough data. */
  projected: { mean: number; lo: number; hi: number } | null;
  weeksToGoal: number | null;
  note: string;
}

/**
 * Goal forecast. Uses the change in difficulty-adjusted performance across recent weeks; the range
 * combines model uncertainty and week-to-week variability. Says so plainly when data is insufficient.
 */
export function forecast(state: LearnerState, now: number, goalRating: number | null, goalDate: string | null): Forecast {
  const g = estimate(state, '', now);
  // Weekly performance rating: mean difficulty + 400*log10(score/(1-score)) clipped.
  const perf: number[] = [];
  for (let w = 5; w >= 0; w--) {
    const hs = state.history.filter((h) => h.t >= now - (w + 1) * 7 * DAY && h.t < now - w * 7 * DAY && h.format !== 'lesson');
    if (hs.length < 15) continue;
    const s = Math.min(0.95, Math.max(0.05, hs.reduce((a, h) => a + h.score, 0) / hs.length));
    perf.push(hs.reduce((a, h) => a + h.difficulty, 0) / hs.length + 400 * Math.log10(s / (1 - s)));
  }
  let weeklyGain: Forecast['weeklyGain'] = null;
  if (perf.length >= 3) {
    const n = perf.length;
    const xs = perf.map((_, i) => i);
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = perf.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let i = 0; i < n; i++) {
      sxy += (xs[i]! - mx) * (perf[i]! - my);
      sxx += (xs[i]! - mx) ** 2;
    }
    const slope = sxy / sxx;
    let sse = 0;
    for (let i = 0; i < n; i++) sse += (perf[i]! - (my + slope * (xs[i]! - mx))) ** 2;
    const se = Math.sqrt(sse / Math.max(1, n - 2) / sxx);
    weeklyGain = { mean: slope, lo: slope - 1.28 * se, hi: slope + 1.28 * se };
  }
  let projected: Forecast['projected'] = null;
  let weeksToGoal: number | null = null;
  let note: string;
  const weeks = goalDate ? (Date.parse(goalDate) - now) / (7 * DAY) : null;
  if (!weeklyGain) note = 'Not enough history yet for a forecast: it needs at least three weeks with 15 or more exercises each.';
  else {
    if (weeks !== null && Number.isFinite(weeks) && weeks > 0) {
      const spread = Math.sqrt(g.sigma ** 2 + ((weeklyGain.hi - weeklyGain.lo) / 2.56) ** 2 * weeks * weeks);
      const mean = g.theta + weeklyGain.mean * weeks;
      projected = { mean, lo: mean - 1.28 * spread, hi: mean + 1.28 * spread };
    }
    if (goalRating && weeklyGain.mean > 0) weeksToGoal = Math.max(0, (goalRating - g.theta) / weeklyGain.mean);
    note = 'Puzzle-rating forecast from your recent trend. Trends in training are noisy and rarely linear; treat the range, not the midpoint, as the answer.';
  }
  return { current: g.theta, sigma: g.sigma, weeklyGain, projected, weeksToGoal, note };
}
