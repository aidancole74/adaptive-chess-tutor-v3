import { describe, expect, it } from 'vitest';
import { Book, OpeningNames, START_EPD } from './openings';
import { nameTuple, realPackFile, syntheticShard, ucis } from './openingsFixture';
import { buildRepertoireTree, defaultMove, findBookExit, listOpeningsForColor, suggestDefaults, withLine } from './repertoire';
import { BOOK_BANDS, type BookShard, type OpeningNameTuple } from './types';
import { epdOf, playLine, START_FEN } from '../engine/chessUtil';

// Synthetic statistics only (exercise the mechanics, not real chess data).
const shard = syntheticShard('1600-1999', [
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'], result: '1-0', count: 50 },
  { sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4'], result: '0-1', count: 40 },
  { sans: ['e4', 'c5', 'Nf3', 'd6'], result: '1/2', count: 40 },
  { sans: ['e4', 'c5', 'Nc3'], result: '0-1', count: 2 },
  { sans: ['d4', 'd5', 'c4'], result: '0-1', count: 60 },
  { sans: ['Nf3', 'Nc6', 'e4', 'e5', 'Bb5'], result: '1-0', count: 3 },
  { sans: ['e4', 'a6'], result: '1-0', count: 1 },
]);
const book = new Book([shard]);
const names = new OpeningNames([
  nameTuple('C20', "King's Pawn Game", ['e4']),
  nameTuple('C60', 'Ruy Lopez', ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']),
  nameTuple('B20', 'Sicilian Defense', ['e4', 'c5']),
  nameTuple('D00', "Queen's Pawn Game", ['d4']),
  nameTuple('D06', "Queen's Gambit", ['d4', 'd5', 'c4']),
]);
const band = '1600-1999' as const;

describe('defaultMove', () => {
  it('picks the best-scoring popular move', () => {
    // e4 (133 games) scores better for White than d4 (60 games, all losses) -> e4
    expect(defaultMove(book, band, START_EPD)?.uci).toBe('e2e4');
    const afterNc6 = epdOf(playLine(START_FEN, ucis(['e4', 'e5', 'Nf3', 'Nc6']))!.chess.fen());
    expect(defaultMove(book, band, afterNc6)?.uci).toBe('f1b5');
  });
  it('returns null outside the book', () => {
    expect(defaultMove(book, '2000+', START_EPD)).toBeNull();
  });
});

describe('buildRepertoireTree', () => {
  it('branches on opponent moves above the threshold and follows choices', () => {
    const tree = buildRepertoireTree(book, band, { color: 'w', choices: {} }, { names });
    const keys = tree.map((n) => n.line.length);
    expect(tree[0]?.epd).toBe(START_EPD);
    expect(tree[0]?.userMove).toBe('e2e4');
    expect(keys.every((p) => p % 2 === 0)).toBe(true);
    // replies to e4: e5 (93) and c5 (42) are above 5%; a6 (1 game) is not.
    const ply2 = tree.filter((n) => n.ply === 2);
    expect(ply2.length).toBe(2);
    expect(tree.every((n) => n.memoryKey === `op:w:${n.epd}`)).toBe(true);
    const ruy = tree.find((n) => n.userMove === 'f1b5');
    expect(ruy?.openingName).toBe('Ruy Lopez');
    expect(ruy?.opponentFreqProduct).toBeGreaterThan(0.5);
  });
  it('uses the repertoire choice when given', () => {
    const rep = withLine({ color: 'w', choices: {} }, ucis(['d4']));
    const tree = buildRepertoireTree(book, band, rep);
    expect(tree[0]?.userMove).toBe('d2d4');
    expect(tree[0]?.chosen).toBe(true);
  });
  it('merges transpositions by EPD and respects maxNodes', () => {
    const tree = buildRepertoireTree(book, band, { color: 'b', choices: {} });
    expect(new Set(tree.map((n) => n.epd)).size).toBe(tree.length);
    expect(buildRepertoireTree(book, band, { color: 'w', choices: {} }, { maxNodes: 2 }).length).toBe(2);
  });
});

describe('findBookExit', () => {
  it('detects an opponent leaving the book', () => {
    const exit = findBookExit(ucis(['e4', 'e5', 'Nf3', 'f6']), book, band, undefined, 'w');
    expect(exit).toMatchObject({ ply: 3, by: 'opponent', played: 'f7f6', known: false });
    expect(exit?.expected).toEqual(['b8c6']);
  });
  it('detects the user deviating from the repertoire with a known move', () => {
    const rep = suggestDefaults(book, names, band, 'w');
    const exit = findBookExit(ucis(['e4', 'e5', 'Nf3', 'Nc6', 'Bc4']), book, band, rep);
    expect(exit).toMatchObject({ ply: 4, by: 'user', played: 'f1c4', known: true, expected: ['f1b5'] });
  });
  it('returns null while still in book', () => {
    expect(findBookExit(ucis(['e4', 'e5']), book, band, undefined, 'w')).toBeNull();
  });
});

describe('suggestDefaults / listOpeningsForColor', () => {
  it('names the main line from data', () => {
    const rep = suggestDefaults(book, names, band, 'w');
    expect(rep.choices[START_EPD]).toBe('e2e4');
    expect(rep.name).toBe('Ruy Lopez');
  });
  it('lists families whose entry line ends with the colour', () => {
    const w = listOpeningsForColor(names, book, band, 'w');
    // by games: e4 135, then c4 60 / d4 60 (tie -> alphabetical), then Bb5 50
    expect(w.map((o) => o.family)).toEqual(["King's Pawn Game", "Queen's Gambit", "Queen's Pawn Game", 'Ruy Lopez']);
    expect(w[0]?.family).toBe("King's Pawn Game");
    const b = listOpeningsForColor(names, book, band, 'b');
    expect(b.map((o) => o.family)).toEqual(['Sicilian Defense']);
    expect(b[0]?.games).toBe(42);
  });
});

describe('real pack repertoire', () => {
  const tuples = realPackFile<OpeningNameTuple[]>('names.json');
  const shards = BOOK_BANDS.map((x) => realPackFile<BookShard>(`book-${x}.json`)).filter((s): s is BookShard => s !== null);
  it.skipIf(!tuples || shards.length !== 4)('builds legal trees in every band', () => {
    const realBook = new Book(shards);
    const realNames = new OpeningNames(tuples!);
    for (const b of BOOK_BANDS) {
      for (const color of ['w', 'b'] as const) {
        const rep = suggestDefaults(realBook, realNames, b, color, { maxNodes: 60 });
        const tree = buildRepertoireTree(realBook, b, rep, { maxNodes: 60, names: realNames });
        expect(tree.length).toBeGreaterThan(5);
        for (const n of tree) expect(playLine(START_FEN, [...n.line, n.userMove])).not.toBeNull();
      }
      expect(listOpeningsForColor(realNames, realBook, b, 'b').length).toBeGreaterThan(3);
    }
  });
});
