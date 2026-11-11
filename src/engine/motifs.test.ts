import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { START_FEN } from './chessUtil';
import { legal } from './features/testUtil';
import {
  DETECTOR_NAMES, classifyMistake, detectBackRank, detectDiscoveredAttack, detectFork, detectHangingPiece,
  detectMateInN, detectMissedStrategic, detectMotifs, detectPin, detectSkewer, hangingPieces, see,
  type MistakeContext,
} from './motifs';

/** Legality-checks the fixture and that every move of `line` is legal from it. */
function fixture(fen: string, line: string[] = []): string {
  const chess = new Chess(legal(fen));
  for (const u of line) expect(chess.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] }), u).toBeTruthy();
  return fen;
}

function ctx(partial: Partial<MistakeContext> & Pick<MistakeContext, 'fen' | 'playedUci' | 'bestUci'>): MistakeContext {
  return {
    bestPv: [partial.bestUci],
    refutationPv: [],
    evalBeforeCp: 0,
    evalAfterCp: -200,
    mateBefore: null,
    mateAfter: null,
    ...partial,
  };
}

describe('see', () => {
  it('counts the exchange on a square for the side to move', () => {
    expect(see(fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1'), 'd5')).toBe(3);
    expect(see(fixture('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1'), 'd5')).toBe(0);
    expect(see(fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1'), 'e8')).toBe(0); // kings are not exchanged
    expect(see(fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1'), 'zz')).toBe(0);
  });
  it('hangingPieces lists capturable pieces, largest gain first', () => {
    expect(hangingPieces(fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1'))).toEqual([{ square: 'd5', gain: 3 }]);
    expect(hangingPieces(fixture('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1'))).toEqual([]);
  });
});

describe('hanging piece', () => {
  it('positive: capturing an undefended knight', () => {
    const fen = fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5']);
    const hit = detectHangingPiece(fen, 'd1d5');
    expect(hit?.theme).toBe('hangingPiece');
    expect(hit?.squares).toEqual(['d5', 'd1']);
    expect(hit?.detail).toContain('undefended');
  });
  it('negative: the knight is defended by a pawn (rook for knight loses material)', () => {
    const fen = fixture('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5']);
    expect(detectHangingPiece(fen, 'd1d5')).toBeNull();
  });
  it('negative: quiet moves and illegal moves', () => {
    expect(detectHangingPiece(fixture(START_FEN, ['e2e4']), 'e2e4')).toBeNull();
    expect(detectHangingPiece(START_FEN, 'e2e5')).toBeNull();
    expect(detectHangingPiece(START_FEN, undefined)).toBeNull();
  });
});

describe('fork', () => {
  it('positive: knight checks the king and attacks the rook', () => {
    const fen = fixture('r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7']);
    const hit = detectFork(fen, 'b5c7');
    expect(hit?.theme).toBe('fork');
    expect(hit?.squares.sort()).toEqual(['a8', 'c7', 'e8']);
  });
  it('negative: the forking square is covered by a bishop', () => {
    const fen = fixture('r2bk3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7']);
    expect(detectFork(fen, 'b5c7')).toBeNull();
  });
  it('negative: only one target', () => {
    const fen = fixture('4k3/8/8/1N6/8/8/8/4K3 w - - 0 1', ['b5c7']);
    expect(detectFork(fen, 'b5c7')).toBeNull();
  });
});

describe('pin', () => {
  it('positive: bishop pins the knight to the king', () => {
    const fen = fixture('r3k3/8/2n5/8/8/8/8/4KB2 w - - 0 1', ['f1b5']);
    const hit = detectPin(fen, 'f1b5');
    expect(hit?.theme).toBe('pin');
    expect(hit?.squares).toEqual(['b5', 'c6', 'e8']);
  });
  it('negative: only a pawn stands behind the knight', () => {
    const fen = fixture('r3k3/3p4/2n5/8/8/8/8/4KB2 w - - 0 1', ['f1b5']);
    expect(detectPin(fen, 'f1b5')).toBeNull();
  });
  it('negative: non-slider moves', () => {
    expect(detectPin(fixture(START_FEN, ['g1f3']), 'g1f3')).toBeNull();
  });
});

describe('skewer', () => {
  it('positive: bishop check skewers the king to the rook', () => {
    const fen = fixture('r7/8/2k5/5B2/8/8/8/4K3 w - - 0 1', ['f5e4']);
    const hit = detectSkewer(fen, 'f5e4');
    expect(hit?.theme).toBe('skewer');
    expect(hit?.squares).toEqual(['e4', 'c6', 'a8']);
    // A king in front is not a pin.
    expect(detectPin(fen, 'f5e4')).toBeNull();
  });
  it('negative: the piece behind is a defended knight worth no more than the bishop', () => {
    const fen = fixture('n6r/8/2k5/5B2/8/8/8/4K3 w - - 0 1', ['f5e4']);
    expect(detectSkewer(fen, 'f5e4')).toBeNull();
  });
});

describe('discovered attack', () => {
  it('positive: knight move uncovers the rook on the queen', () => {
    const fen = fixture('6k1/4q3/8/8/4N3/8/8/4R2K w - - 0 1', ['e4c5']);
    const hit = detectDiscoveredAttack(fen, 'e4c5');
    expect(hit?.theme).toBe('discoveredAttack');
    expect(hit?.squares).toEqual(['c5', 'e1', 'e7']);
  });
  it('negative: only a pawn is uncovered', () => {
    const fen = fixture('6k1/4p3/8/8/4N3/8/8/4R2K w - - 0 1', ['e4c5']);
    expect(detectDiscoveredAttack(fen, 'e4c5')).toBeNull();
  });
});

describe('back rank', () => {
  it('positive: rook mates a king boxed in by its own pawns', () => {
    const fen = fixture('6k1/5ppp/8/8/8/8/8/3R2K1 w - - 0 1', ['d1d8']);
    const hit = detectBackRank(fen, ['d1d8']);
    expect(hit?.theme).toBe('backRankMate');
    expect(hit?.squares).toEqual(['d8', 'g8']);
  });
  it('negative: the king has luft on h7', () => {
    const fen = fixture('6k1/5pp1/7p/8/8/8/8/3R2K1 w - - 0 1', ['d1d8']);
    expect(detectBackRank(fen, ['d1d8'])).toBeNull();
  });
  it('negative: illegal line', () => {
    expect(detectBackRank(START_FEN, ['d1d8'])).toBeNull();
  });
});

describe('mate in N', () => {
  it('positive: missed and allowed mates, capped at mateIn5', () => {
    const r = detectMateInN({ mateBefore: 2, mateAfter: 7, bestPv: ['d1d8'], bestUci: 'd1d8', refutationPv: ['a1a8'] });
    expect(r.map((m) => [m.theme, m.kind])).toEqual([['mateIn2', 'missed'], ['mateIn5', 'allowed']]);
  });
  it('negative: no mate scores', () => {
    expect(detectMateInN({ mateBefore: null, mateAfter: null, bestPv: [], bestUci: 'e2e4', refutationPv: [] })).toEqual([]);
  });
});

describe('missed strategic feature (heuristic)', () => {
  const fen = '4k3/pp3ppp/8/8/4P3/2N5/PPP2PPP/4K3 w - - 0 1';
  it('positive: best move puts the knight on an outpost, the played move does not', () => {
    fixture(fen, ['c3d5']);
    fixture(fen, ['a2a3']);
    const r = detectMissedStrategic(fen, 'c3d5', 'a2a3');
    const outpost = r.find((m) => m.theme === 'outpost');
    expect(outpost).toMatchObject({ conceptId: 'strategy/squares/outpost', kind: 'missed', squares: ['c3', 'd5'] });
    expect(outpost?.detail).toMatch(/^Heuristic/);
  });
  it('negative: identical moves gain nothing over each other', () => {
    expect(detectMissedStrategic(fen, 'c3d5', 'c3d5')).toEqual([]);
  });
  it('detectMotifs runs it only when no tactic fired and cp loss < 300', () => {
    const base = { fen, bestUci: 'c3d5', playedUci: 'a2a3' };
    expect(detectMotifs(ctx({ ...base, evalBeforeCp: 50, evalAfterCp: -150 })).some((m) => m.theme === 'outpost')).toBe(true);
    expect(detectMotifs(ctx({ ...base, evalBeforeCp: 50, evalAfterCp: -350 }))).toEqual([]);
  });
});

describe('detectMotifs / classifyMistake', () => {
  it('missed hanging piece', () => {
    const fen = fixture('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', ['d1d5']);
    fixture(fen, ['e1e2']);
    const r = classifyMistake(ctx({ fen, bestUci: 'd1d5', playedUci: 'e1e2', evalBeforeCp: 300, evalAfterCp: 0 }));
    expect(r.unclassified).toBe(false);
    expect(r.primary).toMatchObject({ theme: 'hangingPiece', kind: 'missed', conceptId: 'tactics/basics/hangingPiece' });
  });

  it('allowed: the played move hangs the queen', () => {
    const fen = fixture('4k3/8/8/8/8/8/8/3QK3 w - - 0 1', ['d1d7', 'e8d7']);
    const r = classifyMistake(ctx({ fen, bestUci: 'd1d2', playedUci: 'd1d7', refutationPv: ['e8d7'], evalBeforeCp: 900, evalAfterCp: -50 }));
    expect(r.primary).toMatchObject({ theme: 'hangingPiece', kind: 'allowed', squares: ['d7', 'e8'] });
  });

  it('allowed back-rank mate ranks first', () => {
    // White's rook leaves the 2nd rank for a7 (from where it cannot reach e1/f1); Black mates on d1.
    const before = fixture('3r2k1/5ppp/8/8/8/8/R4PPP/6K1 w - - 0 1', ['a2a7', 'd8d1']);
    const after = new Chess(before);
    after.move('Ra7');
    after.move('Rd1');
    expect(after.isCheckmate()).toBe(true);
    const r = classifyMistake(ctx({ fen: before, bestUci: 'g2g3', playedUci: 'a2a7', refutationPv: ['d8d1'], mateAfter: 1, evalBeforeCp: 0, evalAfterCp: -10000 }));
    expect(r.primary?.theme).toBe('backRankMate');
    expect(r.primary?.detail).toContain('checkmate');
    expect(r.motifs.map((m) => m.theme)).toContain('mateIn1');
    expect(r.motifs.every((m) => m.kind === 'allowed')).toBe(true);
  });

  it('unclassified when nothing fires', () => {
    fixture(START_FEN, ['g1f3']);
    const r = classifyMistake(ctx({ fen: START_FEN, bestUci: 'g1f3', playedUci: 'b1c3', refutationPv: ['e7e5'], evalBeforeCp: 0, evalAfterCp: -400 }));
    expect(r).toEqual({ motifs: [], primary: null, unclassified: true });
  });

  it('exports the detector list', () => {
    expect(DETECTOR_NAMES).toContain('fork');
    expect(DETECTOR_NAMES.length).toBe(8);
  });
});
