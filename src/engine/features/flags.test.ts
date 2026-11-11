import { describe, expect, it } from 'vitest';
import { CONCEPT_BY_ID } from '../../curriculum/concepts';
import { START_FEN } from '../chessUtil';
import { extractFeatures } from './extract';
import { FEATURE_NAMES, FEATURE_TO_CONCEPT, featureDeltas, featureFlags, featureNamesBySide, parseFeatureDelta } from './flags';
import { legal, randomPositions } from './testUtil';

const fx = (fen: string) => extractFeatures(legal(fen));

describe('FEATURE_TO_CONCEPT', () => {
  it('maps every feature name to an existing strategy concept', () => {
    for (const n of FEATURE_NAMES) {
      const id = FEATURE_TO_CONCEPT[n];
      expect(CONCEPT_BY_ID.has(id), id).toBe(true);
      expect(id.startsWith('strategy/')).toBe(true);
    }
    expect(Object.keys(FEATURE_TO_CONCEPT).sort()).toEqual([...FEATURE_NAMES].sort());
  });
});

describe('featureFlags', () => {
  it('start position has no flags', () => {
    expect(featureFlags(extractFeatures(START_FEN))).toEqual([]);
  });

  it('a weakness is listed under the side it favours (the opponent)', () => {
    const flags = featureFlags(fx('4k3/pp3ppp/4p3/8/3P4/8/PP3PPP/4K3 w - - 0 1'));
    expect(flags).toContainEqual({ name: 'iqp', side: 'b', detail: 'White has an isolated queen pawn on d4' });
    // The IQP is not repeated as a plain isolated pawn.
    expect(flags.find((f) => f.name === 'isolated')).toBeUndefined();
  });

  it('isolated pawn detail', () => {
    const flags = featureFlags(fx('4k3/8/8/3p4/8/8/PP6/4K3 w - - 0 1'));
    expect(flags).toContainEqual({ name: 'iqp', side: 'w', detail: 'Black has an isolated queen pawn on d5' });
    const g = featureFlags(fx('4k3/8/8/p7/8/8/PP6/4K3 w - - 0 1'));
    expect(g).toContainEqual({ name: 'isolated', side: 'w', detail: 'Black has an isolated pawn on a5' });
  });

  it('outpost, open file and bishop pair', () => {
    const flags = featureFlags(fx('4k3/pp3ppp/8/3N4/4P3/8/PPP2PPP/3RKB1B w - - 0 1'));
    expect(flags).toContainEqual({ name: 'outpost', side: 'w', detail: 'White has a minor piece on an outpost: d5' });
    expect(flags).toContainEqual({ name: 'open-file', side: 'w', detail: 'White has a rook on d1 on an open file' });
    expect(flags.find((f) => f.name === 'bishop-pair')).toBeUndefined(); // both bishops on light squares
    const g = featureFlags(fx('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1'));
    expect(g).toContainEqual({ name: 'bishop-pair', side: 'w', detail: 'White has the bishop pair' });
  });

  it('passed pawn favours its owner', () => {
    const flags = featureFlags(fx('4k3/8/1P6/8/8/8/8/4K3 w - - 0 1'));
    expect(flags).toContainEqual({ name: 'passed', side: 'w', detail: 'White has a passed pawn on b6' });
  });

  it('at most one flag per name and side on random positions', () => {
    for (const { fen } of randomPositions(300, 5)) {
      const flags = featureFlags(extractFeatures(fen));
      const keys = flags.map((f) => f.side + f.name);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});

describe('featureNamesBySide / featureDeltas', () => {
  it('reports gains and losses in the documented format', () => {
    const before = fx('4k3/pp3ppp/8/8/4P3/2N5/PPP2PPP/4K3 w - - 0 1');
    const after = fx('4k3/pp3ppp/8/3N4/4P3/8/PPP2PPP/4K3 b - - 1 1');
    expect(featureNamesBySide(before).w).not.toContain('outpost');
    expect(featureNamesBySide(after).w).toContain('outpost');
    const d = featureDeltas(before, after);
    expect(d).toContain('w+outpost');
    expect(featureDeltas(after, before)).toContain('w-outpost');
    expect(featureDeltas(before, before)).toEqual([]);
  });

  it('bishop pair lost', () => {
    const before = fx('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1');
    const after = fx('4k3/8/8/8/8/8/8/4KB2 b - - 0 1');
    const d = featureDeltas(before, after);
    expect(d).toContain('w-bishop-pair');
    expect(d.every((x) => x.endsWith('bishop-pair') || x === 'w-space')).toBe(true); // the c1 bishop also attacked squares in Black's half
    expect(d.some((x) => x.includes('+'))).toBe(false);
  });

  it('parseFeatureDelta', () => {
    expect(parseFeatureDelta('w+outpost')).toEqual({ side: 'w', gained: true, name: 'outpost' });
    expect(parseFeatureDelta('b-bishop-pair')).toEqual({ side: 'b', gained: false, name: 'bishop-pair' });
    expect(parseFeatureDelta('x+outpost')).toBeNull();
    expect(parseFeatureDelta('w+nonsense')).toBeNull();
  });
});
