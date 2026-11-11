import { describe, expect, it } from 'vitest';
import { Book, OpeningNames, START_EPD, bandForRating, familyOf, scorePct } from './openings';
import { nameTuple, realPackFile, syntheticShard, ucis } from './openingsFixture';
import { BOOK_BANDS, type BookShard, type OpeningNameTuple } from './types';
import { epdOf, playLine, START_FEN } from '../engine/chessUtil';

// Synthetic statistics: invented counts that only exercise the lookup mechanics.
const shard = syntheticShard('1200-1599', [
  { sans: ['e4', 'e5', 'Nf3'], result: '1-0', count: 6 },
  { sans: ['e4', 'e5', 'Nf3'], result: '0-1', count: 2 },
  { sans: ['d4', 'd5'], result: '1/2', count: 4 },
  { sans: ['e4', 'c5'], result: '0-1', count: 3 },
]);

describe('bandForRating', () => {
  it('maps ratings onto BOOK_BANDS', () => {
    expect(bandForRating(800)).toBe('0-1199');
    expect(bandForRating(1199)).toBe('0-1199');
    expect(bandForRating(1200)).toBe('1200-1599');
    expect(bandForRating(1999)).toBe('1600-1999');
    expect(bandForRating(2400)).toBe('2000+');
  });
});

describe('Book', () => {
  const book = new Book([shard]);
  it('sorts moves by games and scores from the mover view', () => {
    const moves = book.movesAt('1200-1599', START_EPD);
    expect(moves.map((m) => m.uci)).toEqual(['e2e4', 'd2d4']);
    const e4 = moves[0];
    expect(e4?.games).toBe(11);
    // white wins 6 of 11 (e4 lines) -> 54.5%
    expect(e4?.scorePct).toBeCloseTo((6 / 11) * 100, 5);
    expect(e4?.freq).toBeCloseTo(11 / 15, 5);
    const afterE4 = epdOf(playLine(START_FEN, ['e2e4'])!.chess.fen());
    const replies = book.movesAt('1200-1599', afterE4);
    expect(replies[0]?.uci).toBe('e7e5');
    // black to move: e5 scored 2 wins of 8 for Black -> 25%
    expect(replies[0]?.scorePct).toBeCloseTo(25, 5);
    expect(replies[1]?.scorePct).toBeCloseTo(100, 5);
  });
  it('returns empty for unknown positions and bands', () => {
    expect(book.movesAt('2000+', START_EPD)).toEqual([]);
    expect(book.movesAt('1200-1599', 'x')).toEqual([]);
    expect(book.positionGames('1200-1599', START_EPD)).toBe(15);
  });
  it('scorePct handles draws', () => {
    expect(scorePct([4, 0, 4, 0], 'w')).toBe(50);
    expect(scorePct([0, 0, 0, 0], 'b')).toBe(0);
  });
});

describe('OpeningNames', () => {
  const names = new OpeningNames([
    nameTuple('C20', "King's Pawn Game", ['e4', 'e5']),
    nameTuple('C40', "King's Knight Opening", ['e4', 'e5', 'Nf3']),
    nameTuple('C44', "King's Knight Opening: Normal Variation", ['e4', 'e5', 'Nf3', 'Nc6']),
    nameTuple('A00', 'Test Family: Long', ['Nf3', 'Nc6', 'e4', 'e5']),
  ]);
  it('finds the longest named prefix', () => {
    expect(names.nameForLine(ucis(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5']))?.name).toBe("King's Knight Opening: Normal Variation");
    expect(names.nameForLine(ucis(['e4', 'e5', 'Bc4']))?.name).toBe("King's Pawn Game");
    expect(names.nameForLine(ucis(['d4']))).toBeNull();
  });
  it('recognises transpositions by EPD', () => {
    const hit = names.nameForLine(ucis(['Nf3', 'Nc6', 'e4', 'e5']));
    // Nf3 Nc6 e4 e5 reaches the same position as 1.e4 e5 2.Nf3 Nc6; the shorter named line wins for the EPD.
    expect(hit?.name).toBe("King's Knight Opening: Normal Variation");
    expect(hit?.ply).toBe(4);
  });
  it('families and eco ranges', () => {
    expect(familyOf('Sicilian Defense: Najdorf Variation')).toBe('Sicilian Defense');
    expect(names.ecoRange("King's Knight Opening")).toBe('C40-C44');
    expect(names.nameForEpd(nameTuple('C20', 'x', ['e4', 'e5'])[3])?.eco).toBe('C20');
  });
});

describe('real openings pack', () => {
  const tuples = realPackFile<OpeningNameTuple[]>('names.json');
  const shards = BOOK_BANDS.map((b) => realPackFile<BookShard>(`book-${b}.json`)).filter((s): s is BookShard => s !== null);
  it.skipIf(!tuples)('names replay to their EPD', () => {
    const names = new OpeningNames(tuples!);
    expect(names.size).toBeGreaterThan(3000);
    for (const n of names.all.slice(0, 200)) {
      const r = playLine(START_FEN, n.line);
      expect(r).not.toBeNull();
      expect(epdOf(r!.chess.fen())).toBe(n.epd);
    }
  });
  it.skipIf(shards.length !== 4)('every band has the start position with legal moves', () => {
    const book = new Book(shards);
    for (const band of BOOK_BANDS) {
      const moves = book.movesAt(band, START_EPD);
      expect(moves.length).toBeGreaterThan(5);
      for (const m of moves) expect(playLine(START_FEN, [m.uci])).not.toBeNull();
      expect(book.games(band)).toBeGreaterThan(1000);
    }
  });
});
