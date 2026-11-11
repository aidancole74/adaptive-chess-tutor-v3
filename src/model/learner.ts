/**
 * Hierarchical learner model: global > domain > skill > concept, plus context offsets
 * (phase, colour, time control). Pure functions over LearnerState; `now` is always passed in.
 */
import type { Candidate, ErrorCause, ExerciseResult } from '../exercises/types';
import { CONCEPT_BY_ID, TIER_MID } from '../curriculum/concepts';
import type { AttemptRecord, LearnerState, NodeState } from './types';
import { HISTORY_CAP } from './types';
import { DAY, SIGMA_INIT, TAU, clamp, gaussian, glickoUpdate, inflateSigma, pSolve, pool } from './math';
import { gradeFor, recallNow, review } from './fsrs';

export const CTX_SIGMA = 120;
const CTX_CLAMP = 250;

export function newLearner(now: number, rating = 1200, sigma = SIGMA_INIT): LearnerState {
  return {
    version: 1,
    createdAt: now,
    nodes: { global: { theta: rating, sigma, lastSeen: null, n: 0, solved: 0 } },
    memory: {},
    itemOffsets: {},
    history: [],
    causes: {},
    curriculum: {},
    seeded: false,
  };
}

/** Seed the overall rating (placement test or imported games). Keeps existing evidence if it is stronger. */
export function seedRating(state: LearnerState, rating: number, sigma: number, now: number): void {
  const g = state.nodes.global!;
  if (!state.seeded || sigma < g.sigma) {
    g.theta = rating;
    g.sigma = sigma;
    g.lastSeen = now;
  }
  state.seeded = true;
}

/** ["global", domain, "domain/skill", conceptId] */
export function chainOf(conceptId: string): string[] {
  const parts = conceptId.split('/');
  const chain = ['global'];
  if (parts[0]) chain.push(parts[0]);
  if (parts[1]) chain.push(`${parts[0]}/${parts[1]}`);
  if (parts[2]) chain.push(conceptId);
  return chain;
}

/** Rating points lost per doubling of (1 + days/30) without review. An assumption, tested in `npm run sim`. */
export const FORGET_POINTS = 55;
export function forgetDrift(days: number): number {
  return days <= 0 ? 0 : FORGET_POINTS * Math.log2(1 + days / 30);
}

const LEVEL_TAU =[0, TAU.domain, TAU.skill, TAU.concept];

export interface Estimate {
  theta: number;
  sigma: number;
  /** Share of the estimate that comes from the node's own evidence (0 = fully pooled from parents). */
  ownWeight: number;
  n: number;
}

/** Pooled estimate for any node id in a concept chain, with time-based uncertainty growth applied. */
export function estimate(state: LearnerState, conceptId: string, now: number): Estimate {
  const chain = chainOf(conceptId);
  const g = state.nodes.global!;
  let theta = g.theta;
  let sigma = inflateSigma(g.sigma, g.lastSeen === null ? 0 : (now - g.lastSeen) / DAY);
  let ownWeight = 1;
  let n = g.n;
  for (let i = 1; i < chain.length; i++) {
    const node = state.nodes[chain[i]!];
    const tau = LEVEL_TAU[i]!;
    if (!node || node.n === 0) {
      sigma = Math.sqrt(sigma * sigma + tau * tau);
      ownWeight = 0;
      n = 0;
      continue;
    }
    const own = inflateSigma(node.sigma, node.lastSeen === null ? 0 : (now - node.lastSeen) / DAY);
    const p = pool(node.theta, own, theta, sigma, tau);
    theta = p.theta;
    sigma = p.sigma;
    ownWeight = p.weightOwn;
    n = node.n;
    // Forgetting: a practised concept drifts down while it is not reviewed (leaf level only).
    if (i === 3 && node.lastSeen !== null) theta -= forgetDrift((now - node.lastSeen) / DAY);
  }
  return { theta, sigma, ownWeight, n };
}

export interface PredictContext {
  phase?: string;
  color?: string;
  tc?: string;
}

function ctxIds(c: PredictContext): string[] {
  const ids: string[] = [];
  if (c.phase) ids.push(`ctx:phase:${c.phase}`);
  if (c.color) ids.push(`ctx:color:${c.color}`);
  if (c.tc) ids.push(`ctx:tc:${c.tc}`);
  return ids;
}

export function contextOffset(state: LearnerState, c: PredictContext): number {
  let off = 0;
  for (const id of ctxIds(c)) off += state.nodes[id]?.theta ?? 0;
  return clamp(off, -CTX_CLAMP, CTX_CLAMP);
}

type CandLike = Pick<Candidate, 'conceptId' | 'difficulty' | 'format' | 'difficultySource' | 'phase' | 'color'>;

function offsetKey(c: Pick<Candidate, 'format' | 'conceptId'>): string {
  return `${c.format}|${c.conceptId}`;
}

/** Item difficulty: Lichess rating as-is; generated content = tier prior + offset learned from outcomes. */
export function effectiveDifficulty(state: LearnerState, c: CandLike): number {
  if (c.difficultySource === 'lichess') return c.difficulty;
  return c.difficulty + (state.itemOffsets[offsetKey(c)]?.offset ?? 0);
}

/** Predicted probability that the learner solves the candidate now. */
export function predict(state: LearnerState, c: CandLike, now: number, tc?: string): number {
  const est = estimate(state, c.conceptId, now);
  const theta = est.theta + contextOffset(state, { phase: c.phase, color: c.color, tc });
  return pSolve(theta, effectiveDifficulty(state, c));
}

function touch(state: LearnerState, id: string, init: () => NodeState): NodeState {
  let n = state.nodes[id];
  if (!n) {
    n = init();
    state.nodes[id] = n;
  }
  return n;
}

export interface ApplyOptions {
  retention: number;
  tc?: string;
  slot?: string;
  sessionId?: string;
  /** Skip rating updates (lesson cards and other non-diagnostic exercises). */
  ratingNeutral?: boolean;
}

/**
 * Update the model from one result. Mutates `state`. Returns the pre-attempt prediction.
 * Every node on the chain gets a Glicko-style update against its own pooled expectation.
 */
export function applyResult(state: LearnerState, c: Candidate, r: ExerciseResult, now: number, opts: ApplyOptions): { p: number } {
  const p = predict(state, c, now, opts.tc);
  const d = effectiveDifficulty(state, c);
  const y = clamp(r.score, 0, 1);
  const itemRd = c.difficultySource === 'lichess' ? 60 : 110;

  if (!opts.ratingNeutral) {
    const chain = chainOf(c.conceptId);
    const ctxOff = contextOffset(state, { phase: c.phase, color: c.color, tc: opts.tc });
    // Top-down pooled estimates BEFORE any update, so each level is updated against the same evidence.
    const pooled = chain.map((id) => estimate(state, id === 'global' ? '' : id, now));
    chain.forEach((id, i) => {
      const parentTheta = i === 0 ? state.nodes.global!.theta : pooled[i - 1]!.theta;
      const node = touch(state, id, () => ({ theta: parentTheta, sigma: SIGMA_INIT, lastSeen: null, n: 0, solved: 0 }));
      const sig = inflateSigma(node.sigma, node.lastSeen === null ? 0 : (now - node.lastSeen) / DAY);
      const u = glickoUpdate(node.theta, sig, pooled[i]!.theta + ctxOff, d, y, itemRd);
      node.theta = u.theta;
      node.sigma = u.sigma;
      node.lastSeen = now;
      node.n += 1;
      node.solved += y;
    });
    for (const id of ctxIds({ phase: c.phase, color: c.color, tc: opts.tc })) {
      const node = touch(state, id, () => ({ theta: 0, sigma: CTX_SIGMA, lastSeen: null, n: 0, solved: 0 }));
      const u = glickoUpdate(node.theta, node.sigma, pooled[pooled.length - 1]!.theta + ctxOff, d, y, itemRd);
      node.theta = clamp(u.theta, -CTX_CLAMP, CTX_CLAMP);
      node.sigma = u.sigma;
      node.lastSeen = now;
      node.n += 1;
      node.solved += y;
    }
    if (c.difficultySource !== 'lichess') {
      // Tier prior updated from outcomes: more failures than predicted => the content is harder than its prior.
      const key = offsetKey(c);
      const o = state.itemOffsets[key] ?? { offset: 0, n: 0 };
      const rate = 40 / (1 + o.n / 8);
      o.offset = clamp(o.offset - rate * (y - p), -400, 400);
      o.n += 1;
      state.itemOffsets[key] = o;
    }
  }

  if (c.memoryKey) {
    const budget = 30_000;
    const grade = gradeFor(r.solved, r.hintsUsed, r.timeMs, budget, r.confidence);
    state.memory[c.memoryKey] = review(state.memory[c.memoryKey], c.conceptId, grade, now, opts.retention);
  }

  if (!r.solved && r.cause) recordCause(state, c.conceptId, r.cause);

  const rec: AttemptRecord = {
    t: now,
    exerciseId: c.id,
    itemId: c.itemId,
    domain: c.domain,
    conceptId: c.conceptId,
    format: c.format,
    difficulty: d,
    p,
    score: y,
    solved: r.solved,
    timeMs: r.timeMs,
    hintsUsed: r.hintsUsed,
    confidence: r.confidence,
    cause: r.cause,
    sim: c.sim,
    slot: opts.slot,
    sessionId: opts.sessionId,
  };
  state.history.push(rec);
  if (state.history.length > HISTORY_CAP) state.history.splice(0, state.history.length - HISTORY_CAP);
  return { p };
}

export function recordCause(state: LearnerState, conceptId: string, cause: ErrorCause): void {
  for (const key of ['*', conceptId]) {
    const m = (state.causes[key] ??= {});
    m[cause] = (m[cause] ?? 0) + 1;
  }
}

/** Tag the cause of the most recent failed attempt on an exercise (user tagging after the fact). */
export function tagLastCause(state: LearnerState, exerciseId: string, cause: ErrorCause): void {
  for (let i = state.history.length - 1; i >= 0; i--) {
    const h = state.history[i]!;
    if (h.exerciseId === exerciseId) {
      if (!h.cause && !h.solved) {
        h.cause = cause;
        recordCause(state, h.conceptId, cause);
      }
      return;
    }
  }
}

export interface Weakness {
  /** Rating points below the learner's overall level (positive = weak). */
  gap: number;
  sigma: number;
  /** Observed solve rate and opportunities (never raw error counts). */
  rate: number | null;
  n: number;
}

export function weakness(state: LearnerState, conceptId: string, now: number): Weakness {
  const g = estimate(state, '', now);
  const e = estimate(state, conceptId, now);
  const node = state.nodes[conceptId];
  return { gap: g.theta - e.theta, sigma: e.sigma, rate: node && node.n > 0 ? node.solved / node.n : null, n: node?.n ?? 0 };
}

/** Thompson sample of the gap: draws the concept ability from its posterior. */
export function sampleGap(state: LearnerState, conceptId: string, now: number, rng: () => number): number {
  const g = estimate(state, '', now);
  const e = estimate(state, conceptId, now);
  return g.theta - (e.theta + e.sigma * gaussian(rng));
}

/**
 * Mastery in 0..1: probability of solving tier-typical material for the concept, using a conservative
 * ability (theta - sigma). Decays without review because sigma grows and the estimate shrinks to its parent.
 */
export function mastery(state: LearnerState, conceptId: string, now: number): { value: number; sigma: number; theta: number } {
  const def = CONCEPT_BY_ID.get(conceptId);
  const e = estimate(state, conceptId, now);
  const d = TIER_MID[def?.tier ?? 2]!;
  return { value: pSolve(e.theta - e.sigma, d), sigma: e.sigma, theta: e.theta };
}

/** Recall probability for a memory item, or null when never reviewed. */
export function memoryRecall(state: LearnerState, key: string, now: number): number | null {
  const m = state.memory[key];
  return m ? recallNow(m, now) : null;
}

/** Share of recent basic-concept attempts (hanging pieces, mate in 1) that failed. Null until enough opportunities. */
export function basicBlunderRate(state: LearnerState, window = 30, minN = 8): { rate: number | null; n: number } {
  const basics = state.history.filter((h) => CONCEPT_BY_ID.get(h.conceptId)?.basic).slice(-window);
  if (basics.length < minN) return { rate: null, n: basics.length };
  return { rate: basics.filter((h) => !h.solved).length / basics.length, n: basics.length };
}
