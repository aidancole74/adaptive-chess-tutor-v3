import { describe, expect, it } from 'vitest';
import { Book, type OpeningTrap, type StructureCard } from '../content/openings';
import { realPackFile, syntheticShard, ucis } from '../content/openingsFixture';
import { buildRepertoireTree } from '../content/repertoire';
import { epdOf, playLine, START_FEN } from '../engine/chessUtil';
import { buildDeviation, buildOpeningLine, buildStructureCard, buildTrapAvoid, buildTrapPunish, openingLineDifficulty } from './openings';

// Synthetic statistics only.
const shard = syntheticShard('1200-1599', [
  { sans: ['e4', 'e5', 'Nf3', 'Nc6'], result: '1-0', count: 30 },
  { sans: ['e4', 'c5', 'Nf3'], result: '0-1', count: 20 },
]);
const book = new Book([shard]);

describe('buildOpeningLine', () => {
  const tree = buildRepertoireTree(book, '1200-1599', { color: 'w', choices: {} });
  it('creates a line exercise from the start position', () => {
    const node = tree.find((n) => n.ply === 2);
    expect(node).toBeDefined();
    const ex = buildOpeningLine(node!, 'w', { book, band: '1200-1599' });
    expect(ex.format).toBe('opening-line');
    expect(ex.conceptId).toBe('openings/repertoire/white-lines');
    expect(ex.memoryKey).toBe(`op:w:${node!.epd}`);
    expect(ex.difficultySource).toBe('tier-prior');
    expect(ex.interaction).toMatchObject({ kind: 'line', fen: START_FEN, preMoves: node!.line, solution: [node!.userMove] });
    expect(ex.facts.some((f) => f.t === 'book')).toBe(true);
    expect(ex.verified).toBe(true);
  });
  it('difficulty grows with depth and rarity', () => {
    expect(openingLineDifficulty(10, 0.5)).toBeGreaterThan(openingLineDifficulty(2, 0.5));
    expect(openingLineDifficulty(4, 0.05)).toBeGreaterThan(openingLineDifficulty(4, 0.8));
  });
});

describe('buildDeviation', () => {
  const line = ucis(['e4', 'e5', 'Nf3']);
  const fen = playLine(START_FEN, line)!.chess.fen();
  it('accepts caller-supplied answers and drops illegal ones', () => {
    const ex = buildDeviation({ fen, line, opponentMove: ucis(['e4', 'e5', 'Nf3', 'f6'])[3]!, bookMoves: [{ uci: 'b8c6', games: 30, scorePct: 40 }] }, ['f3e5', 'a1a8', 'b1c3']);
    expect(ex?.format).toBe('opening-deviation');
    expect(ex?.conceptId).toBe('openings/skills/deviation');
    expect(ex?.interaction).toMatchObject({ kind: 'line', fen, solution: ['f3e5'], alternatives: { 0: ['b1c3'] } });
  });
  it('returns null when nothing acceptable is legal', () => {
    expect(buildDeviation({ fen, line, opponentMove: 'f7f6', bookMoves: [] }, ['a1a8'])).toBeNull();
  });
});

// A hand-made trap object for MECHANICS ONLY (illegal-move filtering, option building). Not content.
const mechFen = playLine(START_FEN, ucis(['e4', 'e5']))!.chess.fen();
const mechTrap: OpeningTrap = {
  id: 'trap-test',
  epd: epdOf(mechFen),
  fen: mechFen,
  line: ucis(['e4', 'e5']),
  mistake: 'd1h5',
  mistakeFreq: 0.1,
  band: '1200-1599',
  refutation: ['b8c6', 'f1c4', 'g7g6'],
  evalBeforeCp: 0,
  evalAfterCp: 200,
  depth: 16,
  openingName: '',
  verified: true,
  mistakeSan: 'Qh5',
  mistakeGames: 200,
  mistakeScorePct: 40,
  bestAltUci: 'g1f3',
  bestAltScorePct: 55,
  refutationSan: ['Nc6', 'Bc4', 'g6'],
  safeMoves: [{ uci: 'g1f3', san: 'Nf3', cp: 30, games: 500, scorePct: 55 }],
};

describe('trap builders', () => {
  it('avoid: mistake is wrong, verified safe moves are right', () => {
    const ex = buildTrapAvoid(mechTrap)!;
    expect(ex.conceptId).toBe('openings/skills/traps');
    expect(ex.interaction.kind).toBe('choice');
    if (ex.interaction.kind !== 'choice') return;
    expect(ex.interaction.options.map((o) => o.id).sort()).toEqual(['d1h5', 'g1f3']);
    expect(ex.interaction.correct).toEqual(['g1f3']);
  });
  it('punish: starts after the mistake and plays the refutation (odd length)', () => {
    const ex = buildTrapPunish(mechTrap)!;
    expect(ex.interaction).toMatchObject({ kind: 'line', preMoves: ['d1h5'], solution: ['b8c6', 'f1c4', 'g7g6'] });
    expect(ex.color).toBe('b');
  });
  it('rejects unverified traps', () => {
    expect(buildTrapAvoid({ ...mechTrap, verified: false })).toBeNull();
    expect(buildTrapPunish({ ...mechTrap, verified: false })).toBeNull();
  });
});

describe('real pack exercises', () => {
  const traps = realPackFile<OpeningTrap[]>('traps.json');
  const cards = realPackFile<StructureCard[]>('cards.json');
  it.skipIf(!traps || traps.length === 0)('every shipped trap builds both exercises', () => {
    for (const t of traps!) {
      expect(t.verified).toBe(true);
      const p = buildTrapPunish(t);
      expect(p).not.toBeNull();
      const a = buildTrapAvoid(t);
      if (a && a.interaction.kind === 'choice') {
        for (const o of a.interaction.options) expect(playLine(t.fen, [o.id])).not.toBeNull();
        expect(a.interaction.correct).not.toContain(t.mistake);
      }
    }
  });
  it.skipIf(!cards || cards.length === 0)('structure cards render from computed facts', () => {
    for (const c of cards!) {
      const ex = buildStructureCard(c);
      expect(ex.memoryKey).toBe(`card:${c.id}`);
      expect(ex.conceptId).toBe('openings/skills/structures');
      expect(ex.interaction.kind).toBe('card');
      expect(playLine(START_FEN, c.line)?.chess.fen()).toBe(c.fen);
    }
  });
});
