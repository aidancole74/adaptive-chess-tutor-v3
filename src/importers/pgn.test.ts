import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { START_FEN } from '../engine/chessUtil';
import { parseClock, parseEval, parsePgn, parseTimeControl, tokenizePgn } from './pgn';

// Fixtures: real Lichess games (lichess.org open database / public game export, CC0).
const FIX = path.join(import.meta.dirname, 'fixtures');
const clocked = fs.readFileSync(path.join(FIX, 'lichess-clocked.pgn'), 'utf8');
const withEvals = fs.readFileSync(path.join(FIX, 'lichess-eval.pgn'), 'utf8');

describe('parsePgn on real Lichess exports', () => {
  const { games, errors } = parsePgn(clocked, { username: 'KAVITHAN20' });

  it('reads every game, skipping the % escape line', () => {
    expect(errors).toEqual([]);
    expect(games.map((g) => g.id)).toEqual(['lichess:Q8ku5wgM', 'lichess:vuOeeysw', 'lichess:ipK0j6p5', 'lichess:DTql5nYK']);
  });

  it('parses headers, players, ratings, time control and opening', () => {
    const g = games[0]!;
    expect(g.white).toBe('aila');
    expect(g.black).toBe('GEIMIDEISH');
    expect(g.whiteElo).toBe(1825);
    expect(g.blackElo).toBe(1790);
    expect(g.result).toBe('1/2-1/2');
    expect(g.timeControl).toEqual({ base: 300, inc: 0 });
    expect(g.speed).toBe('blitz');
    expect(g.opening).toEqual({ eco: 'A46', name: 'Indian Defense: Wade-Tartakower Defense' });
    expect(g.playedAt).toBe(Date.UTC(2026, 9, 1, 0, 0, 25));
    expect(g.startFen).toBe(START_FEN);
    expect(g.url).toBe('https://lichess.org/Q8ku5wgM');
  });

  it('replays all moves with SAN, UCI, FEN before and clocks', () => {
    const g = games[0]!;
    expect(g.moves).toHaveLength(120);
    expect(g.moves[0]).toMatchObject({ san: 'd4', uci: 'd2d4', fenBefore: START_FEN, clockMs: 300_000, embeddedEval: null });
    expect(g.moves[3]).toMatchObject({ san: 'd6', clockMs: 298_000 });
    expect(g.moves[114]).toMatchObject({ san: 'd8=Q', uci: 'd7d8q' });
    expect(g.moves[119]).toMatchObject({ san: 'Kxe6', clockMs: 80_000 });
    expect(games[1]!.moves).toHaveLength(89);
    expect(games[2]!.moves).toHaveLength(63);
  });

  it('sets the user colour from a case-insensitive username match', () => {
    expect(games[1]!.userColor).toBe('w');
    expect(games[0]!.userColor).toBeNull();
    expect(parsePgn(clocked, { username: 'franky5019' }).games[1]!.userColor).toBe('b');
  });
});

describe('embedded Lichess evals', () => {
  const { games, errors } = parsePgn(withEvals, { username: 'drnykterstein' });
  it('reads [%eval] (white POV, pawns -> cp) next to [%clk]', () => {
    expect(errors).toEqual([]);
    const g = games[0]!;
    expect(g.id).toBe('lichess:J3C5rR4Z');
    expect(g.userColor).toBe('b');
    expect(g.timeControl).toEqual({ base: 180, inc: 0 });
    expect(g.moves).toHaveLength(36);
    expect(g.moves[0]!.embeddedEval).toEqual({ cp: 18, mate: null });
    expect(g.moves[34]).toMatchObject({ san: 'Bf4', embeddedEval: { cp: -643, mate: null }, clockMs: 152_000 });
  });
});

describe('robustness', () => {
  // Opening moves of the real game Q8ku5wgM, decorated with every PGN feature the parser must skip.
  const decorated = `[Event "Test"]
[White "a"]
[Black "b"]
[Result "*"]

1.d4 $1 {comment} Nf6!? ( 1... d5 2. c4 ( 2. Nf3 ) ) 2. Nf3 ; rest of line
d6 3. e3?! g6 *

[Event "Second"]
[White "c"]
[Black "d"]
[SetUp "1"]
[FEN "rnbqkb1r/ppp1pppp/3p1n2/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3"]
[Result "1-0"]

3. e3 g6 1-0
`;
  it('skips NAGs, glyphs, variations and comments, and honours FEN headers', () => {
    const { games, errors } = parsePgn(decorated);
    expect(errors).toEqual([]);
    expect(games).toHaveLength(2);
    expect(games[0]!.moves.map((m) => m.san)).toEqual(['d4', 'Nf6', 'Nf3', 'd6', 'e3', 'g6']);
    expect(games[0]!.id).toMatch(/^pgn:/);
    expect(games[1]!.startFen).toBe('rnbqkb1r/ppp1pppp/3p1n2/8/3P4/5N2/PPP1PPPP/RNBQKB1R w KQkq - 0 3');
    expect(games[1]!.moves.map((m) => m.uci)).toEqual(['e2e3', 'g7g6']);
    expect(games[1]!.result).toBe('1-0');
  });

  it('reports an illegal move per game and keeps the other games', () => {
    const bad = `[White "x"]\n[Black "y"]\n\n1. d4 Nf6 2. Nf5 *\n\n${clocked.split('\n\n[Event')[0]}`;
    const { games, errors } = parsePgn(bad);
    expect(games).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain('Nf5');
    expect(errors[0]!.label).toBe('x vs y');
  });

  it('rejects other variants', () => {
    const { games, errors } = parsePgn('[Variant "Atomic"]\n\n1. e4 *');
    expect(games).toHaveLength(0);
    expect(errors[0]!.message).toMatch(/Atomic/);
  });

  it('splits headerless consecutive games at results', () => {
    expect(tokenizePgn('1. d4 Nf6 1-0 1. e4 0-1').map((g) => g.sans)).toEqual([['d4', 'Nf6'], ['e4']]);
  });
});

describe('comment and header helpers', () => {
  it('parses clocks with and without tenths', () => {
    expect(parseClock('[%clk 0:04:59.9]')).toBe(299_900);
    expect(parseClock('[%eval 0.2] [%clk 1:00:00]')).toBe(3_600_000);
    expect(parseClock('no clock')).toBeNull();
  });
  it('parses evals, mates and depth suffixes', () => {
    expect(parseEval('[%eval -6.43]')).toEqual({ cp: -643, mate: null });
    expect(parseEval('[%eval #-3]')).toEqual({ cp: null, mate: -3 });
    expect(parseEval('[%eval 0.25,22]')).toEqual({ cp: 25, mate: null });
  });
  it('parses time controls', () => {
    expect(parseTimeControl('180+2')).toEqual({ base: 180, inc: 2 });
    expect(parseTimeControl('600')).toEqual({ base: 600, inc: 0 });
    expect(parseTimeControl('1/86400')).toBeNull();
    expect(parseTimeControl('-')).toBeNull();
  });
});
