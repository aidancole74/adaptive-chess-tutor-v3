import { describe, expect, it } from 'vitest';
import { DAY, SIGMA_INIT, glickoUpdate, inflateSigma, mulberry32, pSolve, pool } from './math';
import { applyResult, basicBlunderRate, estimate, mastery, newLearner, predict, seedRating, weakness } from './learner';
import { intervalFor, retrievability, review } from './fsrs';
import { brier, confidenceModel, ece, reliabilityBins } from './calibration';
import { syntheticCandidate } from '../scheduler/syntheticPool';
import type { ExerciseResult } from '../exercises/types';

const res = (solved: boolean, extra: Partial<ExerciseResult> = {}): ExerciseResult => ({ exerciseId: 'x', score: solved ? 1 : 0, solved, hintsUsed: 0, timeMs: 10_000, ...extra });
const FORK = 'tactics/double-attack/fork';
const PIN = 'tactics/double-attack/pin';
const T0 = 1_700_000_000_000;

describe('math', () => {
  it('logistic link is 50% at equal rating and ~76% at +200', () => {
    expect(pSolve(1500, 1500)).toBeCloseTo(0.5, 6);
    expect(pSolve(1700, 1500)).toBeCloseTo(0.76, 2);
  });
  it('glicko update moves toward the outcome and shrinks sigma', () => {
    const up = glickoUpdate(1500, 200, 1500, 1500, 1);
    const down = glickoUpdate(1500, 200, 1500, 1500, 0);
    expect(up.theta).toBeGreaterThan(1500);
    expect(down.theta).toBeLessThan(1500);
    expect(up.sigma).toBeLessThan(200);
    // surprising results move more than expected ones
    const surprise = glickoUpdate(1500, 200, 1500, 1900, 1).theta - 1500;
    const expected = glickoUpdate(1500, 200, 1500, 1100, 1).theta - 1500;
    expect(surprise).toBeGreaterThan(expected);
  });
  it('sigma grows with time and is capped at the prior', () => {
    expect(inflateSigma(60, 30)).toBeGreaterThan(60);
    expect(inflateSigma(60, 1e6)).toBe(SIGMA_INIT);
  });
  it('pooling shrinks uncertain nodes toward the parent', () => {
    const sparse = pool(1000, 330, 1500, 80, 130);
    const dense = pool(1000, 60, 1500, 80, 130);
    expect(sparse.theta).toBeGreaterThan(dense.theta);
    expect(sparse.weightOwn).toBeLessThan(0.3);
    expect(dense.weightOwn).toBeGreaterThan(0.8);
  });
});

describe('learner model', () => {
  it('unseen concepts inherit the parent estimate with wider uncertainty', () => {
    const s = newLearner(T0, 1400, 100);
    const e = estimate(s, FORK, T0);
    expect(e.theta).toBe(1400);
    expect(e.sigma).toBeGreaterThan(100);
    expect(e.ownWeight).toBe(0);
  });
  it('failures on one concept open a gap to the overall level and partly inform siblings', () => {
    const s = newLearner(T0, 1500, 120);
    for (let i = 0; i < 12; i++) applyResult(s, syntheticCandidate(FORK, i, 1450, 'solve'), res(false), T0 + i, { retention: 0.9 });
    for (let i = 0; i < 12; i++) applyResult(s, syntheticCandidate('endgames/mating/krk', i, 1450, 'eg-best-move'), res(true), T0 + 100 + i, { retention: 0.9 });
    const w = weakness(s, FORK, T0 + 200);
    expect(w.gap).toBeGreaterThan(50);
    expect(w.n).toBe(12);
    expect(w.rate).toBe(0);
    // sibling under the same skill is pulled down, but less than the observed concept
    const fork = estimate(s, FORK, T0 + 200).theta;
    const pin = estimate(s, PIN, T0 + 200).theta;
    const other = estimate(s, 'endgames/mating/krk', T0 + 200).theta;
    expect(pin).toBeGreaterThan(fork);
    expect(pin).toBeLessThan(other);
  });
  it('estimates converge toward a hidden skill', () => {
    const rng = mulberry32(7);
    const s = newLearner(T0, 1200);
    const hidden = 1650;
    for (let i = 0; i < 150; i++) {
      const d = 1300 + rng() * 700;
      applyResult(s, syntheticCandidate(FORK, i, d, 'solve'), res(rng() < pSolve(hidden, d)), T0 + i * 1000, { retention: 0.9 });
    }
    expect(Math.abs(estimate(s, FORK, T0 + 150_000).theta - hidden)).toBeLessThan(120);
  });
  it('forgetting: uncertainty grows, the estimate shrinks to the parent and mastery decays', () => {
    const s = newLearner(T0, 1200, 80);
    for (let i = 0; i < 25; i++) applyResult(s, syntheticCandidate(FORK, i, 1500, 'solve'), res(true), T0 + i, { retention: 0.9 });
    const fresh = mastery(s, FORK, T0 + 100);
    const stale = mastery(s, FORK, T0 + 200 * DAY);
    expect(stale.sigma).toBeGreaterThan(fresh.sigma);
    expect(stale.value).toBeLessThan(fresh.value);
  });
  it('generated-content difficulty prior is updated from outcomes', () => {
    const s = newLearner(T0, 1500, 60);
    const c = syntheticCandidate('endgames/rook/lucena', 0, 1500, 'eg-best-move');
    const before = predict(s, c, T0);
    for (let i = 0; i < 10; i++) applyResult(s, { ...c, itemId: `i${i}` }, res(false), T0 + i, { retention: 0.9 });
    expect(s.itemOffsets['eg-best-move|endgames/rook/lucena']!.offset).toBeGreaterThan(0);
    expect(predict(s, c, T0 + 20)).toBeLessThan(before);
  });
  it('tracks context offsets, causes and the basic-blunder rate', () => {
    const s = newLearner(T0, 1500, 80);
    const hp = 'tactics/basics/hangingPiece';
    for (let i = 0; i < 10; i++) {
      const c = { ...syntheticCandidate(hp, i, 1500, 'solve'), color: 'b' as const };
      applyResult(s, c, res(i % 2 === 0, { cause: 'vision' }), T0 + i, { retention: 0.9, tc: 'blitz' });
    }
    expect(s.nodes['ctx:color:b']!.n).toBe(10);
    expect(s.nodes['ctx:tc:blitz']).toBeDefined();
    expect(s.causes['*']!.vision).toBe(5);
    expect(basicBlunderRate(s).rate).toBeCloseTo(0.5);
  });
  it('seeding keeps stronger existing evidence', () => {
    const s = newLearner(T0);
    seedRating(s, 1800, 120, T0);
    seedRating(s, 900, 300, T0);
    expect(s.nodes.global!.theta).toBe(1800);
  });
});

describe('FSRS-style memory', () => {
  it('recall is 90% at one stability and intervals lengthen with a lower retention target', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.9, 6);
    expect(intervalFor(10, 0.9)).toBeCloseTo(10, 6);
    expect(intervalFor(10, 0.8)).toBeGreaterThan(intervalFor(10, 0.95));
  });
  it('successful reviews grow stability; a lapse shrinks it', () => {
    let m = review(undefined, 'c', 3, T0, 0.9);
    const s1 = m.stability;
    m = review(m, 'c', 3, m.due, 0.9);
    expect(m.stability).toBeGreaterThan(s1);
    const s2 = m.stability;
    m = review(m, 'c', 1, m.due, 0.9);
    expect(m.stability).toBeLessThan(s2);
    expect(m.lapses).toBe(1);
  });
  it('memory items get a state when an exercise carries a memory key', () => {
    const s = newLearner(T0);
    const c = syntheticCandidate('endgames/rook/lucena', 0, 1500, 'eg-best-move', true);
    applyResult(s, c, res(true), T0, { retention: 0.9 });
    expect(s.memory[c.memoryKey!]!.due).toBeGreaterThan(T0);
  });
});

describe('calibration', () => {
  it('brier, ECE and reliability bins', () => {
    const rows = [
      { p: 0.9, solved: true },
      { p: 0.9, solved: true },
      { p: 0.1, solved: false },
      { p: 0.1, solved: true },
    ];
    expect(brier(rows)).toBeCloseTo((0.01 + 0.01 + 0.01 + 0.81) / 4, 6);
    const bins = reliabilityBins(rows, 10);
    expect(bins[1]!.n).toBe(2);
    expect(bins[1]!.rate).toBe(0.5);
    expect(ece(rows)).toBeCloseTo(0.5 * 0.4 + 0.5 * 0.1, 6);
    expect(brier([])).toBeNull();
  });
  it('confidence model detects overconfidence', () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ p: 0.5, solved: i % 2 === 0, confidence: 5 }));
    const m = confidenceModel(rows);
    expect(m.bias).toBeGreaterThan(0.4);
    expect(m.levels[4]!.calibrated).toBeLessThan(0.7);
    expect(m.levels[0]!.calibrated).toBe(0.2);
  });
});
