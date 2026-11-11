/** Rating-scale maths: logistic link, Glicko-style update, uncertainty growth, precision-weighted pooling. */

/** 400 / ln(10): logistic scale of the Elo / Glicko / Lichess puzzle rating scale. */
export const SCALE = 400 / Math.LN10;
const Q = Math.LN10 / 400;

export const SIGMA_INIT = 350;
export const SIGMA_MIN = 45;
/** Rating-scale uncertainty growth per sqrt(day) without practice. */
export const SIGMA_GROWTH = 14;
/** Between-level spread: how far a child may plausibly sit from its parent (partial-pooling prior sd). */
export const TAU: Record<'domain' | 'skill' | 'concept', number> = { domain: 220, skill: 160, concept: 130 };
export const DAY = 86_400_000;

export function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** P(solve) = logistic((theta - difficulty) / SCALE). */
export function pSolve(theta: number, difficulty: number): number {
  return logistic((theta - difficulty) / SCALE);
}

/** Difficulty at which a learner of ability theta succeeds with probability p. */
export function difficultyForP(theta: number, p: number): number {
  return theta - SCALE * Math.log(p / (1 - p));
}

/** Uncertainty after `days` without observation (Glicko RD growth), capped at the prior. */
export function inflateSigma(sigma: number, days: number, growth = SIGMA_GROWTH): number {
  if (days <= 0) return sigma;
  return Math.min(SIGMA_INIT, Math.sqrt(sigma * sigma + growth * growth * days));
}

/**
 * One Glicko-style online update of (theta, sigma) from an outcome y in [0,1] against an item of the
 * given difficulty. `predTheta` is the ability used for the expectation (the pooled estimate), and
 * `itemRd` discounts noisy item ratings.
 */
export function glickoUpdate(
  theta: number,
  sigma: number,
  predTheta: number,
  difficulty: number,
  y: number,
  itemRd = 60,
): { theta: number; sigma: number; expected: number } {
  const g = 1 / Math.sqrt(1 + (3 * Q * Q * itemRd * itemRd) / (Math.PI * Math.PI));
  const expected = 1 / (1 + Math.pow(10, (-g * (predTheta - difficulty)) / 400));
  const dInv = Q * Q * g * g * expected * (1 - expected);
  const newVar = 1 / (1 / (sigma * sigma) + dInv);
  const newTheta = theta + Q * newVar * g * (y - expected);
  return { theta: newTheta, sigma: Math.max(SIGMA_MIN, Math.sqrt(newVar)), expected };
}

/**
 * Partial pooling: combine a node's own estimate with its parent's pooled estimate.
 * The parent acts as a prior N(parentTheta, parentSigma^2 + tau^2); sparse (high-sigma) nodes shrink to it.
 */
export function pool(
  theta: number,
  sigma: number,
  parentTheta: number,
  parentSigma: number,
  tau: number,
): { theta: number; sigma: number; weightOwn: number } {
  const pOwn = 1 / (sigma * sigma);
  const pPar = 1 / (parentSigma * parentSigma + tau * tau);
  const total = pOwn + pPar;
  return { theta: (theta * pOwn + parentTheta * pPar) / total, sigma: Math.sqrt(1 / total), weightOwn: pOwn / total };
}

/** Standard normal sample (Box-Muller) from a uniform RNG. */
export function gaussian(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Deterministic RNG (mulberry32) for tests, the simulator and reproducible sessions. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
