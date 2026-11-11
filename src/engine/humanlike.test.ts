import { describe, expect, it } from 'vitest';
import { moveProbabilities, pickHumanMove, temperature } from './humanlike';
import { mulberry32 } from '../model/math';
import type { EngineLine } from './stockfish';

const lines: EngineLine[] = [
  { multipv: 1, depth: 10, cp: 50, mate: null, pv: ['e2e4'] },
  { multipv: 2, depth: 10, cp: 20, mate: null, pv: ['d2d4'] },
  { multipv: 3, depth: 10, cp: -150, mate: null, pv: ['g2g4'] },
];

describe('human-likeness softmax', () => {
  it('temperature falls with rating', () => {
    expect(temperature(800)).toBeGreaterThan(temperature(1600));
    expect(temperature(1600)).toBeGreaterThan(temperature(2400));
  });
  it('stronger simulated players concentrate on the best move', () => {
    const weak = moveProbabilities(lines, 800);
    const strong = moveProbabilities(lines, 2400);
    expect(strong[0]!.p).toBeGreaterThan(weak[0]!.p);
    expect(weak[2]!.p).toBeGreaterThan(strong[2]!.p);
    expect(weak.reduce((a, b) => a + b.p, 0)).toBeCloseTo(1, 9);
  });
  it('sampling is deterministic under a seeded RNG and returns a listed move', () => {
    const a = pickHumanMove(lines, 1200, mulberry32(4));
    expect(['e2e4', 'd2d4', 'g2g4']).toContain(a);
    expect(pickHumanMove(lines, 1200, mulberry32(4))).toBe(a);
  });
});
