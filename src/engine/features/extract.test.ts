import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import { START_FEN } from '../chessUtil';
import { applyUci, attackersOf, parseFen, seeOnBoard, sqIndex, sqName, toFen } from './board';
import { extractFeatures } from './extract';
import { legal, mirrorFen, randomPositions } from './testUtil';
import type { SideFeatures, StructureLabel } from './types';

const fx = (fen: string) => extractFeatures(legal(fen));

describe('board helpers', () => {
  it('round-trips FENs', () => {
    for (const { fen } of randomPositions(200, 7)) expect(toFen(parseFen(fen)).split(' ')[0]).toBe(fen.split(' ')[0]);
    expect(toFen(parseFen(START_FEN))).toBe(START_FEN);
    expect(sqName(sqIndex('e4'))).toBe('e4');
    expect(sqIndex('z9')).toBe(-1);
  });

  it('applyUci matches chess.js placement, turn and castling rights on random legal moves', () => {
    for (const { fen, uci } of randomPositions(1500, 11)) {
      const chess = new Chess(fen);
      chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      const mine = applyUci(parseFen(fen), uci);
      expect(mine).not.toBeNull();
      const a = toFen(mine!).split(' ');
      const b = chess.fen().split(' ');
      expect([a[0], a[1], a[2], a[4], a[5]]).toEqual([b[0], b[1], b[2], b[4], b[5]]);
    }
  });

  it('applyUci rejects moving a piece that is not the mover\'s', () => {
    expect(applyUci(parseFen(START_FEN), 'e7e5')).toBeNull();
    expect(applyUci(parseFen(START_FEN), 'e4e5')).toBeNull();
  });

  it('attackersOf agrees with chess.js attackers()', () => {
    for (const { fen } of randomPositions(150, 3)) {
      const chess = new Chess(fen);
      const b = parseFen(fen);
      for (let s = 0; s < 64; s += 3) {
        const name = sqName(s);
        expect(attackersOf(b.sq, s, 1).map(sqName).sort()).toEqual([...chess.attackers(name as never, 'w')].sort());
        expect(attackersOf(b.sq, s, -1).map(sqName).sort()).toEqual([...chess.attackers(name as never, 'b')].sort());
      }
    }
  });

  it('static exchange evaluation', () => {
    const see = (fen: string, square: string) => seeOnBoard(parseFen(legal(fen)).sq, sqIndex(square), 1);
    expect(see('4k3/8/8/3p4/4P3/8/8/4K3 w - - 0 1', 'd5')).toBe(1); // undefended pawn
    expect(see('4k3/8/4p3/3p4/4P3/8/8/4K3 w - - 0 1', 'd5')).toBe(0); // pawn trade
    expect(see('4k3/8/8/3n4/8/8/8/3RK3 w - - 0 1', 'd5')).toBe(3); // undefended knight
    expect(see('4k3/8/4p3/3n4/8/8/8/3RK3 w - - 0 1', 'd5')).toBe(0); // rook for defended knight loses
    expect(see('3rk3/8/8/3p4/8/8/3R4/3RK3 w - - 0 1', 'd5')).toBe(1); // x-ray: wins the pawn, Black should not recapture
    expect(see('4k3/8/8/8/8/8/8/3RK3 w - - 0 1', 'd5')).toBe(0); // empty square
  });
});

describe('pawn structure', () => {
  it('start position has no weaknesses and is symmetrical', () => {
    const f = fx(START_FEN);
    for (const s of [f.w, f.b]) {
      expect(s.isolated).toEqual([]);
      expect(s.doubled).toEqual([]);
      expect(s.backward).toEqual([]);
      expect(s.passed).toEqual([]);
      expect(s.hangingPawns).toEqual([]);
      expect(s.iqp).toBe(false);
      expect(s.semiOpenFiles).toEqual([]);
      expect(s.material).toBe(39);
      expect(s.mobility).toBe(4); // two knights with two squares each
      expect(s.castled).toBe(false);
      expect(s.kingShieldPawns).toBe(3);
      expect(s.kingDanger).toBe(0);
      expect(s.development).toBe(0);
      expect(s.space).toBe(0);
      expect(s.bishopPair).toBe(true);
      expect(s.rooksOnOpenFiles).toEqual([]);
    }
    expect(f.openFiles).toEqual([]);
    expect(f.structure).toBe('symmetrical');
    expect(f.phase).toBe('opening');
    expect(f.materialSignature).toBe('KQRRBBNNPPPPPPPPkqrrbbnnpppppppp');
  });

  it('isolated, doubled and passed pawns', () => {
    const f = fx('4k3/8/8/8/8/2P5/P1P5/4K3 w - - 0 1');
    expect(f.w.isolated.sort()).toEqual(['a2', 'c2', 'c3']); // no white pawn on the b- or d-file
    expect(f.w.doubled.sort()).toEqual(['c2', 'c3']);
    expect(f.w.passed.sort()).toEqual(['a2', 'c3']); // c2 has its own pawn in front of it
    expect(f.openFiles).toEqual(['b', 'd', 'e', 'f', 'g', 'h']);
    expect(f.b.semiOpenFiles).toEqual(['a', 'c']);
    expect(f.w.semiOpenFiles).toEqual([]);
  });

  it('a pawn is not passed when an enemy pawn is ahead on an adjacent file', () => {
    const f = fx('4k3/8/p7/1P6/8/8/8/4K3 w - - 0 1');
    expect(f.w.passed).toEqual([]);
    expect(f.b.passed).toEqual([]);
    const g = fx('4k3/8/1P6/p7/8/8/8/4K3 w - - 0 1'); // pawns have passed each other
    expect(g.w.passed).toEqual(['b6']);
    expect(g.b.passed).toEqual(['a5']);
  });

  it('backward pawn', () => {
    const f = fx('4k3/8/8/2p1p3/2P5/3P4/8/4K3 w - - 0 1');
    expect(f.w.backward).toEqual(['d3']); // neighbour c4 is ahead, d4 is hit by c5/e5
    expect(f.w.isolated).toEqual([]);
    expect(f.b.backward).toEqual([]);
    expect(f.b.isolated.sort()).toEqual(['c5', 'e5']);
    // With the neighbour level with it the pawn is not backward.
    expect(fx('4k3/8/8/2p1p3/8/2PP4/8/4K3 w - - 0 1').w.backward).toEqual([]);
    // Stop square not attacked by a pawn: not backward.
    expect(fx('4k3/8/8/8/2P5/3P4/8/4K3 w - - 0 1').w.backward).toEqual([]);
  });

  it('isolated queen pawn', () => {
    const f = fx('4k3/pp3ppp/4p3/8/3P4/8/PP3PPP/4K3 w - - 0 1');
    expect(f.w.iqp).toBe(true);
    expect(f.b.iqp).toBe(false);
    expect(f.w.isolated).toEqual(['d4']);
    expect(f.structure).toBe('iqp-white');
    expect(f.openFiles).toEqual(['c']);
    expect(f.w.semiOpenFiles).toEqual(['e']);
    expect(f.b.semiOpenFiles).toEqual(['d']);
  });

  it('hanging pawns', () => {
    const f = fx('4k3/pp3ppp/4p3/8/2PP4/8/P4PPP/4K3 w - - 0 1');
    expect(f.w.hangingPawns).toEqual(['c4', 'd4']);
    expect(f.b.hangingPawns).toEqual([]);
    expect(f.w.iqp).toBe(false);
    expect(f.structure).toBe('hanging-pawns-white');
    // A friendly b-pawn next to them: no longer hanging pawns.
    expect(fx('4k3/pp3ppp/4p3/8/2PP4/8/PP3PPP/4K3 w - - 0 1').w.hangingPawns).toEqual([]);
    // An enemy pawn on the d-file: the file is not semi-open.
    expect(fx('4k3/pp1p1ppp/4p3/8/2PP4/8/P4PPP/4K3 w - - 0 1').w.hangingPawns).toEqual([]);
  });
});

describe('structure labels', () => {
  const cases: [string, StructureLabel][] = [
    ['4k3/pp3ppp/2p5/3p4/3P4/4P3/PP3PPP/4K3 w - - 0 1', 'carlsbad'],
    ['4k3/pp2pp1p/3p2p1/8/2P1P3/8/PP3PPP/4K3 w - - 0 1', 'maroczy-white'],
    ['4k3/pp3ppp/4p3/8/3P4/8/PP3PPP/4K3 w - - 0 1', 'iqp-white'],
    ['4k3/pp3ppp/4p3/8/2PP4/8/P4PPP/4K3 w - - 0 1', 'hanging-pawns-white'],
    ['4k3/8/4p3/3pP3/3P4/8/8/4K3 w - - 0 1', 'closed-centre'],
    ['4k3/ppp2ppp/8/8/8/8/PPP2PPP/4K3 w - - 0 1', 'open-centre'],
    ['4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1', 'symmetrical'],
    ['4k3/8/3p4/8/4P3/8/8/4K3 w - - 0 1', 'other'],
  ];
  const flip: Partial<Record<StructureLabel, StructureLabel>> = {
    'maroczy-white': 'maroczy-black', 'iqp-white': 'iqp-black', 'hanging-pawns-white': 'hanging-pawns-black',
  };
  it.each(cases)('%s -> %s (and its colour-reversed mirror)', (fen, label) => {
    expect(fx(fen).structure).toBe(label);
    expect(fx(mirrorFen(fen)).structure).toBe(flip[label] ?? label);
  });
});

describe('files, squares and pieces', () => {
  it('rooks on open files', () => {
    const f = fx('4k3/pp4pp/8/8/8/8/PP4PP/3RK2R w - - 0 1');
    expect(f.openFiles).toEqual(['c', 'd', 'e', 'f']);
    expect(f.w.rooksOnOpenFiles).toEqual(['d1']);
  });

  it('rook on a semi-open file', () => {
    const f = fx('4k3/pp1p2pp/8/8/8/8/PP4PP/3RK3 w - - 0 1');
    expect(f.w.semiOpenFiles).toEqual(['d']);
    expect(f.w.rooksOnOpenFiles).toEqual(['d1']);
    expect(f.openFiles).not.toContain('d');
  });

  it('outpost: protected by a pawn and not attackable by enemy pawns', () => {
    const f = fx('4k3/pp3ppp/8/3N4/4P3/8/PPP2PPP/4K3 w - - 0 1');
    expect(f.w.outposts).toContainEqual({ square: 'd5', occupied: true });
    // f5 is also protected by e4, but the g7 pawn could still advance to g6 and attack it.
    expect(f.w.outposts.map((o) => o.square)).not.toContain('f5');
  });

  it('outpost disappears when an enemy pawn can attack the square', () => {
    const f = fx('4k3/ppp2ppp/8/3N4/4P3/8/PPP2PPP/4K3 w - - 0 1');
    expect(f.w.outposts.map((o) => o.square)).not.toContain('d5'); // c7-c6 would attack d5
  });

  it('weak squares', () => {
    const f = fx('4k3/8/8/8/8/6P1/5P1P/6K1 w - - 0 1');
    expect(f.w.weakSquares).toContain('f3'); // no e-pawn, g-pawn is level with the square
    expect(f.w.weakSquares).toContain('h3');
    expect(f.w.weakSquares).not.toContain('g3'); // own pawn stands there
    expect(f.w.weakSquares).not.toContain('g4'); // f2/h2 are behind it
    expect(f.w.weakSquares).not.toContain('e3'); // f2 can protect it
  });

  it('castled flag, king shield and king danger', () => {
    const f = fx('r4rk1/ppp2ppp/8/8/8/8/PPP2PPP/2KR3R w - - 0 1');
    expect(f.w.castled).toBe(true);
    expect(f.b.castled).toBe(true);
    expect(f.w.kingShieldPawns).toBe(2);
    expect(f.b.kingShieldPawns).toBe(3);
    expect(f.w.kingDanger).toBe(1); // (1 hole + 1 bare file + 0 attackers) halved: no enemy queen
    expect(f.b.kingDanger).toBe(0);
    const g = fx('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    expect(g.w.castled).toBe(false);
    // King on g1 with its rook still on h1 has not castled.
    expect(fx('4k3/8/8/8/8/8/5PPP/6KR w - - 0 1').w.castled).toBe(false);
  });

  it('king danger rises with missing shield and attackers, and is 0 without enemy pieces', () => {
    const f = fx('6k1/8/8/8/8/6q1/8/6K1 w - - 0 1');
    expect(f.w.kingDanger).toBe(8); // 3 holes + 3 bare files + queen (2)
    expect(f.b.kingDanger).toBe(0);
  });

  it('bishop pair, good and bad bishops', () => {
    expect(fx('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1').w.bishopPair).toBe(true);
    expect(fx('4k3/8/8/8/8/8/8/2B1K3 w - - 0 1').w.bishopPair).toBe(false);
    const bad = fx('4k3/8/8/8/3P4/4P3/1P6/2B1K3 w - - 0 1'); // b2, e3, d4 and the bishop are all on dark squares
    expect(bad.w.badBishops).toEqual(['c1']);
    expect(bad.w.goodBishops).toEqual([]);
    const good = fx('4k3/8/8/8/3P4/4P3/1P6/4KB2 w - - 0 1'); // light-squared bishop, same pawns
    expect(good.w.goodBishops).toEqual(['f1']);
    expect(good.w.badBishops).toEqual([]);
  });

  it('mobility, space and development after 1.e4', () => {
    const chess = new Chess();
    chess.move('e4');
    const f = extractFeatures(chess.fen());
    expect(f.w.mobility).toBe(14); // Nb1 2, Ng1 3, Bf1 5, Qd1 4
    expect(f.w.space).toBe(5); // d5, f5 (pawn), b5, a6 (bishop), h5 (queen)
    expect(f.b.space).toBe(0);
    const g = fx('r1bqkbnr/pppppppp/2n5/8/8/5N2/PPPPPPPP/RNBQKB1R w KQkq - 2 2');
    expect(g.w.development).toBe(1);
    expect(g.b.development).toBe(1);
    // Castled + connected rooks + four minors out.
    expect(fx('4k3/8/8/8/8/2NBBN2/PPP2PPP/R4RK1 w - - 0 1').w.development).toBe(6);
  });
});

describe('invariants on random positions', () => {
  const numeric: (keyof SideFeatures)[] = ['kingDanger', 'kingShieldPawns', 'mobility', 'space', 'development', 'material'];
  const lists: (keyof SideFeatures)[] = ['isolated', 'doubled', 'backward', 'passed', 'hangingPawns', 'semiOpenFiles', 'outposts', 'weakSquares', 'badBishops', 'goodBishops', 'rooksOnOpenFiles'];
  it('colour-reversed mirror swaps the two sides exactly; ranges hold; deterministic', () => {
    for (const { fen } of randomPositions(400, 42)) {
      const f = extractFeatures(fen);
      const m = extractFeatures(mirrorFen(fen));
      expect(extractFeatures(fen)).toEqual(f);
      for (const k of numeric) {
        expect(m.b[k]).toBe(f.w[k]);
        expect(m.w[k]).toBe(f.b[k]);
      }
      for (const k of lists) expect((m.b[k] as unknown[]).length).toBe((f.w[k] as unknown[]).length);
      expect(m.b.castled).toBe(f.w.castled);
      expect(m.b.iqp).toBe(f.w.iqp);
      expect(m.b.bishopPair).toBe(f.w.bishopPair);
      expect(m.openFiles).toEqual(f.openFiles);
      for (const s of [f.w, f.b]) {
        expect(s.kingDanger).toBeGreaterThanOrEqual(0);
        expect(s.kingDanger).toBeLessThanOrEqual(10);
        expect(s.kingShieldPawns).toBeLessThanOrEqual(3);
        // Definitions are mutually exclusive where they must be.
        for (const p of s.backward) expect(s.isolated).not.toContain(p);
        for (const p of s.backward) expect(s.passed).not.toContain(p);
      }
      // A file cannot be both open and semi-open.
      for (const file of f.openFiles) {
        expect(f.w.semiOpenFiles).not.toContain(file);
        expect(f.b.semiOpenFiles).not.toContain(file);
      }
    }
  });
});
