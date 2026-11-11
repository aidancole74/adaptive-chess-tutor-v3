/** Builder tests over real items from the built pack (public/packs/endgames); skipped when the pack is absent. */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { EndgameItem, PackInfo } from '../content/types';
import { CONCEPT_BY_ID, TIER_MID } from '../curriculum/concepts';
import { materialSignature, sideToMove } from '../engine/chessUtil';
import { buildEgBestMove, buildEgPlayout, buildEgWinOrDraw } from './endgames';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'packs', 'endgames');

function load(): EndgameItem[] {
  try {
    const pack = JSON.parse(fs.readFileSync(path.join(DIR, 'pack.json'), 'utf8')) as PackInfo;
    return pack.shards.flatMap((s) => JSON.parse(fs.readFileSync(path.join(DIR, s.file), 'utf8')) as EndgameItem[]);
  } catch {
    return [];
  }
}

const items = load();
/** A few items per concept keeps the test fast. */
const sample = [...new Set(items.map((i) => i.concept))].flatMap((c) => items.filter((i) => i.concept === c).slice(0, 4));
const rng = (): number => 0.42;

describe.skipIf(items.length === 0)('endgame builders on the built pack', () => {
  it('pack items are verified, legal and self-consistent', () => {
    for (const it of items) {
      expect(it.verified).toBe(true);
      const c = new Chess(it.fen);
      expect(c.moves().length).toBe(it.moves.length);
      expect(it.best.length).toBeGreaterThan(0);
      expect(it.onlyMove).toBe(it.best.length === 1);
      for (const u of it.best) expect(it.moves.find((m) => m.uci === u)?.category).toBe(it.category);
      expect(CONCEPT_BY_ID.has(it.concept)).toBe(true);
    }
  });

  it('builds eg-best-move with every best move accepted', () => {
    for (const it of sample) {
      const ex = buildEgBestMove(it, rng);
      expect(ex.format).toBe('eg-best-move');
      expect(ex.domain).toBe('endgames');
      expect(ex.conceptId).toBe(it.concept);
      expect(ex.difficulty).toBe(TIER_MID[it.tier]);
      expect(ex.difficultySource).toBe('tier-prior');
      expect(ex.phase).toBe('endgame');
      expect(ex.color).toBe(sideToMove(it.fen));
      expect(ex.sim.material).toBe(materialSignature(it.fen));
      expect(ex.verified).toBe(true);
      expect(ex.prompt).toMatch(it.category === 'win' ? /win/ : /hold the draw/);
      if (ex.interaction.kind !== 'line') throw new Error('expected line');
      expect(ex.interaction.solution).toEqual([it.best[0]]);
      expect([...ex.interaction.solution, ...(ex.interaction.alternatives?.[0] ?? [])].sort()).toEqual([...it.best].sort());
      const tb = ex.facts.find((f) => f.t === 'tablebase');
      expect(tb).toMatchObject({ t: 'tablebase', category: it.category, dtm: it.dtm });
      const memory = CONCEPT_BY_ID.get(it.concept)?.memory === true;
      expect(ex.memoryKey).toBe(memory ? `eg:${it.id}` : undefined);
    }
  });

  it('builds eg-win-or-draw with the tablebase category as the single answer', () => {
    for (const it of sample) {
      const ex = buildEgWinOrDraw(it, rng);
      if (ex.interaction.kind !== 'choice') throw new Error('expected choice');
      expect(ex.interaction.multi).toBe(false);
      expect(ex.interaction.correct).toEqual([it.category]);
      expect(ex.interaction.options.map((o) => o.id)).toEqual(['win', 'draw', 'loss']);
    }
  });

  it('builds play-outs only for play-out items', () => {
    for (const it of sample) {
      const ex = buildEgPlayout(it, rng);
      if (it.playoutTarget === null) {
        expect(ex).toBeNull();
        continue;
      }
      if (!ex || ex.interaction.kind !== 'playout') throw new Error('expected playout');
      expect(ex.interaction.opponent).toBe('tablebase');
      expect(ex.interaction.objective).toEqual({ type: it.category === 'win' ? 'mate-within' : 'draw', moves: it.playoutTarget });
      if (it.category === 'win' && it.dtm !== null) expect(it.playoutTarget).toBeGreaterThanOrEqual(Math.ceil(it.dtm / 2));
    }
  });
});
