import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Chess } from 'chess.js';
import { buildBlunderCheck, buildConvertOrHold, buildSparring, buildTimedDrill } from './process';
import { candidatesDrill, forcedLineDrill, knightPathDrill, squareColorDrill } from './calculation';
import { decodeTactic } from '../tactics';
import type { TacticTuple } from '../types';
import { gradeChoice, gradeSet, isLightSquare, shortestKnightPath } from '../../exercises/grade';
import { mulberry32 } from '../../model/math';
import { START_FEN } from '../../engine/chessUtil';

const shard = path.resolve(import.meta.dirname, '../../../public/packs/tactics/r1400.json');
const have = fs.existsSync(shard);
const items = have ? (JSON.parse(fs.readFileSync(shard, 'utf8')) as TacticTuple[]).slice(0, 400).map(decodeTactic) : [];

describe('defence and conversion', () => {
  it('conversion needs a clear advantage, holding a clearly worse but not lost position', () => {
    expect(buildConvertOrHold({ id: 'a', fen: START_FEN, cp: 300, source: 't' }, 1500)?.format).toBe('convert');
    expect(buildConvertOrHold({ id: 'b', fen: START_FEN, cp: -300, source: 't' }, 1500)?.format).toBe('hold');
    expect(buildConvertOrHold({ id: 'c', fen: START_FEN, cp: 80, source: 't' }, 1500)).toBeNull();
    expect(buildConvertOrHold({ id: 'd', fen: START_FEN, cp: -900, source: 't' }, 1500)).toBeNull();
    const ex = buildConvertOrHold({ id: 'a', fen: START_FEN, cp: 300, source: 't' }, 1500)!;
    expect(ex.interaction.kind === 'playout' && ex.interaction.objective.type === 'convert' && ex.interaction.objective.startCp).toBe(300);
  });
});

describe.skipIf(!have)('process drills from real puzzles', () => {
  it('blunder-check marks the puzzle blunder unsafe and it is legal', () => {
    const it0 = items.find((i) => i.themes.includes('crushing'))!;
    const ex = buildBlunderCheck({ kind: 'blunder', item: it0 })!;
    expect(ex.interaction.kind).toBe('choice');
    if (ex.interaction.kind === 'choice') {
      expect(gradeChoice(ex.interaction, ['unsafe']).solved).toBe(true);
      expect(gradeChoice(ex.interaction, ['safe']).solved).toBe(false);
    }
  });
  it('sparring starts from the position after the opponent move with the solver to move', () => {
    const it0 = items.find((i) => i.themes.includes('crushing'))!;
    const ex = buildSparring(it0, 1400)!;
    const c = new Chess(it0.fen);
    c.move({ from: it0.moves[0]!.slice(0, 2), to: it0.moves[0]!.slice(2, 4), promotion: it0.moves[0]![4] });
    expect(ex.interaction.kind === 'playout' && ex.interaction.fen).toBe(c.fen());
  });
  it('timed drills carry a budget and keep the motif as a secondary concept', () => {
    const ex = buildTimedDrill(items[0]!, 25);
    expect(ex.timeBudgetSec).toBe(25);
    expect(ex.conceptId).toBe('time/process/timed-drill');
    expect(ex.secondaryConcepts?.[0]).toMatch(/^tactics\//);
  });
  it('candidate drills list exactly the checks and captures chess.js generates', () => {
    for (const it0 of items.slice(0, 60)) {
      const ex = candidatesDrill(it0);
      if (!ex || ex.interaction.kind !== 'set') continue;
      const c = new Chess(ex.interaction.fen!);
      const want = c.moves({ verbose: true }).filter((m) => m.san.includes('+') || m.san.includes('#') || m.isCapture());
      expect(ex.interaction.expected.length).toBe(want.length);
      expect(gradeSet(ex.interaction, ex.interaction.expected).solved).toBe(true);
    }
  });
  it('forced-line drills commit to the full line', () => {
    const it0 = items.find((i) => i.moves.length >= 5)!;
    const ex = forcedLineDrill(it0, 'commit')!;
    expect(ex.interaction.kind === 'line' && ex.interaction.commitDepth).toBe(Math.ceil((it0.moves.length - 1) / 2));
    expect(forcedLineDrill(it0, 'blindfold')!.interaction.kind === 'line').toBe(true);
  });
});

describe('visualisation drills', () => {
  it('square colours follow the board (a1 dark, h1 light)', () => {
    expect(isLightSquare('a1')).toBe(false);
    expect(isLightSquare('h1')).toBe(true);
    expect(isLightSquare('d4')).toBe(false);
    const ex = squareColorDrill(mulberry32(3));
    if (ex.interaction.kind === 'choice') for (const id of ex.interaction.correct) expect(isLightSquare(id)).toBe(true);
  });
  it('knight paths are shortest and any equal-length legal path is accepted', () => {
    expect(shortestKnightPath('a1', 'b3')).toEqual(['a1', 'b3']);
    expect(shortestKnightPath('a1', 'h8').length - 1).toBe(6);
    const ex = knightPathDrill(mulberry32(5));
    if (ex.interaction.kind === 'set') {
      expect(gradeSet(ex.interaction, ex.interaction.expected).solved).toBe(true);
      expect(gradeSet(ex.interaction, [ex.interaction.from!, ex.interaction.to!]).solved).toBe(ex.interaction.expected.length === 2);
    }
  });
});
