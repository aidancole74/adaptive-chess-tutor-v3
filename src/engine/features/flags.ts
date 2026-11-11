/**
 * Named, comparable feature flags derived from PositionFeatures.
 *
 * CONVENTION: `side` is the side the feature conventionally FAVOURS, not the side that owns the
 * pawns or squares. A structural weakness (isolated, doubled, backward, IQP, hanging pawns, weak
 * squares, bad bishop, exposed king) is therefore listed under the OPPONENT of the side that has
 * it. This is a labelling convention, not an evaluation: an IQP is listed under the opponent even
 * in positions where the IQP side is doing well. The detail string always states the plain fact.
 *
 * At most one flag per (name, side). Rules:
 * - isolated / doubled / backward: the opponent has at least one such pawn (the IQP itself is
 *   reported as `iqp`, not repeated under `isolated`).
 * - passed: the side has a passed pawn.
 * - iqp / hanging-pawns: the opponent has them.
 * - carlsbad: structure label is `carlsbad`; favours the side WITHOUT a c-pawn (the side with the
 *   semi-open c-file and the queenside pawn minority).
 * - maroczy: structure label is `maroczy-white` / `maroczy-black`; favours the side with the c+e pawns.
 * - open-file: the side has a rook on a fully open file.
 * - semi-open-file: the side has a rook on a file that is semi-open for it.
 * - outpost: the side has a knight or bishop standing on one of its outpost squares.
 * - weak-squares: the opponent has at least 2 more weak squares than the side.
 * - king-safety: the opponent's kingDanger is at least 3 higher than the side's.
 * - activity: the side's mobility exceeds the opponent's by at least 6 and by at least 25%.
 * - bishop-pair: the side has the bishop pair and the opponent does not.
 * - good-bad-bishop: the opponent has a bad bishop and the side has none.
 * - space: the side's space count exceeds the opponent's by at least 4.
 * - development: not an endgame, and the side's development count exceeds the opponent's by at least 2.
 */
import type { FeatureFlags, FeatureName, PositionFeatures, Side, SideFeatures } from './types';

export const FEATURE_NAMES: readonly FeatureName[] = [
  'isolated', 'doubled', 'backward', 'passed', 'hanging-pawns', 'iqp', 'carlsbad', 'maroczy',
  'open-file', 'semi-open-file', 'outpost', 'weak-squares', 'king-safety', 'activity',
  'bishop-pair', 'good-bad-bishop', 'space', 'development',
];

/** Feature name -> strategy concept id in src/curriculum/concepts.ts. */
export const FEATURE_TO_CONCEPT: Record<FeatureName, string> = {
  isolated: 'strategy/pawns/isolated',
  doubled: 'strategy/pawns/doubled',
  backward: 'strategy/pawns/backward',
  passed: 'strategy/pawns/passed',
  'hanging-pawns': 'strategy/pawns/hanging-pawns',
  iqp: 'strategy/pawns/iqp',
  carlsbad: 'strategy/pawns/carlsbad',
  maroczy: 'strategy/pawns/maroczy',
  'open-file': 'strategy/files/open-file',
  'semi-open-file': 'strategy/files/semi-open-file',
  outpost: 'strategy/squares/outpost',
  'weak-squares': 'strategy/squares/weak-squares',
  'king-safety': 'strategy/king/king-safety',
  activity: 'strategy/pieces/activity',
  'bishop-pair': 'strategy/pieces/bishop-pair',
  'good-bad-bishop': 'strategy/pieces/good-bad-bishop',
  space: 'strategy/space/space',
  development: 'strategy/development/development',
};

const SIDE_NAME: Record<Side, string> = { w: 'White', b: 'Black' };

function list(squares: string[]): string {
  return squares.join(', ');
}
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

type Flag = { name: FeatureName; side: Side; detail: string };

function sideFlags(f: PositionFeatures, side: Side, out: Flag[]): void {
  const other: Side = side === 'w' ? 'b' : 'w';
  const me: SideFeatures = f[side];
  const opp: SideFeatures = f[other];
  const Me = SIDE_NAME[side];
  const Opp = SIDE_NAME[other];
  const push = (name: FeatureName, detail: string): void => {
    out.push({ name, side, detail });
  };

  const oppIqpSquare = opp.iqp ? opp.isolated.find((s) => s.startsWith('d')) : undefined;
  const oppIsolated = opp.isolated.filter((s) => s !== oppIqpSquare);
  if (oppIsolated.length > 0) {
    push('isolated', `${Opp} has ${plural(oppIsolated.length, 'an isolated pawn', 'isolated pawns')} on ${list(oppIsolated)}`);
  }
  if (opp.doubled.length > 0) push('doubled', `${Opp} has doubled pawns on ${list(opp.doubled)}`);
  if (opp.backward.length > 0) {
    push('backward', `${Opp} has ${plural(opp.backward.length, 'a backward pawn', 'backward pawns')} on ${list(opp.backward)}`);
  }
  if (me.passed.length > 0) {
    push('passed', `${Me} has ${plural(me.passed.length, 'a passed pawn', 'passed pawns')} on ${list(me.passed)}`);
  }
  if (opp.hangingPawns.length > 0) push('hanging-pawns', `${Opp} has hanging pawns on ${list(opp.hangingPawns)}`);
  if (oppIqpSquare) push('iqp', `${Opp} has an isolated queen pawn on ${oppIqpSquare}`);

  if (f.structure === 'carlsbad' && me.semiOpenFiles.includes('c')) {
    push('carlsbad', `Carlsbad structure: ${Me} has the semi-open c-file`);
  }
  if (f.structure === (side === 'w' ? 'maroczy-white' : 'maroczy-black')) {
    push('maroczy', `Maroczy bind: ${Me} has pawns on ${side === 'w' ? 'c4 and e4' : 'c5 and e5'}`);
  }

  const onOpen = me.rooksOnOpenFiles.filter((s) => f.openFiles.includes(s.charAt(0)));
  const onSemi = me.rooksOnOpenFiles.filter((s) => !f.openFiles.includes(s.charAt(0)));
  if (onOpen.length > 0) push('open-file', `${Me} has ${plural(onOpen.length, 'a rook', 'rooks')} on ${list(onOpen)} on an open file`);
  if (onSemi.length > 0) push('semi-open-file', `${Me} has ${plural(onSemi.length, 'a rook', 'rooks')} on ${list(onSemi)} on a semi-open file`);

  const occupied = me.outposts.filter((o) => o.occupied).map((o) => o.square);
  if (occupied.length > 0) push('outpost', `${Me} has a minor piece on ${plural(occupied.length, 'an outpost', 'outposts')}: ${list(occupied)}`);

  if (opp.weakSquares.length - me.weakSquares.length >= 2) {
    push('weak-squares', `${Opp} has ${opp.weakSquares.length} squares its pawns cannot protect (${Me}: ${me.weakSquares.length})`);
  }
  if (opp.kingDanger - me.kingDanger >= 3) {
    push('king-safety', `${Opp}'s king is more exposed (danger ${opp.kingDanger}/10 vs ${me.kingDanger}/10)`);
  }
  if (me.mobility - opp.mobility >= 6 && me.mobility >= 1.25 * opp.mobility) {
    push('activity', `${Me}'s pieces have more squares (${me.mobility} vs ${opp.mobility})`);
  }
  if (me.bishopPair && !opp.bishopPair) push('bishop-pair', `${Me} has the bishop pair`);
  if (opp.badBishops.length > 0 && me.badBishops.length === 0) {
    push('good-bad-bishop', `${Opp}'s bishop on ${list(opp.badBishops)} is hemmed in by its own pawns`);
  }
  if (me.space - opp.space >= 4) push('space', `${Me} controls more squares in the enemy half (${me.space} vs ${opp.space})`);
  if (f.phase !== 'endgame' && me.development - opp.development >= 2) {
    push('development', `${Me} is ahead in development (${me.development} vs ${opp.development})`);
  }
}

export const featureFlags: FeatureFlags = (f) => {
  const out: Flag[] = [];
  sideFlags(f, 'w', out);
  sideFlags(f, 'b', out);
  return out;
};

/** Flag names per favoured side, in FEATURE_NAMES order. */
export function featureNamesBySide(f: PositionFeatures): { w: FeatureName[]; b: FeatureName[] } {
  const flags = featureFlags(f);
  const pick = (side: Side): FeatureName[] => {
    const set = new Set(flags.filter((x) => x.side === side).map((x) => x.name));
    return FEATURE_NAMES.filter((n) => set.has(n));
  };
  return { w: pick('w'), b: pick('b') };
}

/**
 * Flags that appear or disappear between two positions, in the StrategyItem.featureDeltas format:
 * side + sign + name, e.g. "w+outpost" (White gained the outpost flag), "b-bishop-pair".
 * Order: White then Black, gains before losses, FEATURE_NAMES order within each group.
 */
export function featureDeltas(before: PositionFeatures, after: PositionFeatures): string[] {
  const a = featureNamesBySide(before);
  const b = featureNamesBySide(after);
  const out: string[] = [];
  for (const side of ['w', 'b'] as const) {
    for (const n of b[side]) if (!a[side].includes(n)) out.push(`${side}+${n}`);
    for (const n of a[side]) if (!b[side].includes(n)) out.push(`${side}-${n}`);
  }
  return out;
}

/** Parses a delta string produced by featureDeltas; null when it is not one. */
export function parseFeatureDelta(delta: string): { side: Side; gained: boolean; name: FeatureName } | null {
  const side = delta.charAt(0);
  const sign = delta.charAt(1);
  const name = delta.slice(2) as FeatureName;
  if ((side !== 'w' && side !== 'b') || (sign !== '+' && sign !== '-') || !FEATURE_NAMES.includes(name)) return null;
  return { side, gained: sign === '+', name };
}
