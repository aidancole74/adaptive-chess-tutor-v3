import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { START_FEN } from '../chessUtil';
import { PLAN_LABELS, classifyPlan, type PlanLabel } from './plans';
import { legal, randomPositions } from './testUtil';

/** Asserts the move is legal in the fixture, then classifies it. */
function plan(fen: string, uci: string): { plan: PlanLabel; detail: string } {
  const chess = new Chess(legal(fen));
  expect(chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })).toBeTruthy();
  return classifyPlan(fen, uci);
}

describe('classifyPlan', () => {
  it('castling is king safety', () => {
    expect(plan('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1', 'e1g1')).toEqual({ plan: 'king-safety', detail: 'Castles kingside' });
  });

  it('captures are labelled capture', () => {
    expect(plan('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'e4d5').plan).toBe('capture');
  });

  it('development from the back rank', () => {
    expect(plan(START_FEN, 'g1f3')).toEqual({ plan: 'develop', detail: 'Develops the knight to f3' });
  });

  it('pawn break: the pushed pawn attacks an enemy pawn', () => {
    expect(plan('4k3/8/8/3p4/8/8/2P5/4K3 w - - 0 1', 'c2c4').plan).toBe('pawn-break');
  });

  it('gain space: pawn to the 4th rank attacking nothing', () => {
    expect(plan(START_FEN, 'e2e4').plan).toBe('gain-space');
  });

  it('create passed pawn', () => {
    // b5 is blocked from passing by the a6 pawn; b5xa6 is a capture, so use a push past the guard.
    const r = plan('4k3/8/8/p7/1P6/8/8/4K3 w - - 0 1', 'b4b5');
    expect(r.plan).toBe('create-passed-pawn');
    expect(r.detail).toBe('The pawn on b5 becomes a passed pawn');
  });

  it('luft for a castled king boxed in by its own pawns', () => {
    expect(plan('4k3/8/8/8/8/8/5PPP/6K1 w - - 0 1', 'h2h3').plan).toBe('king-safety');
  });

  it('piece to outpost', () => {
    expect(plan('4k3/pp3ppp/8/8/4P3/2N5/PPP2PPP/4K3 w - - 0 1', 'c3d5').plan).toBe('piece-to-outpost');
  });

  it('rook to open file', () => {
    expect(plan('4k3/pp4pp/8/8/8/8/PP4PP/R3K3 w Q - 0 1', 'a1d1')).toEqual({ plan: 'rook-to-open-file', detail: 'Rook moves to the open d-file' });
  });

  it('king centralisation in the endgame', () => {
    expect(plan('4k3/8/8/8/8/8/8/K7 w - - 0 1', 'a1b2').plan).toBe('centralize');
  });

  it('every label has a human-readable name and random moves never throw', () => {
    for (const { fen, uci } of randomPositions(500, 9)) {
      const r = classifyPlan(fen, uci);
      expect(PLAN_LABELS[r.plan]).toBeTruthy();
      expect(r.detail.length).toBeGreaterThan(0);
    }
  });
});
