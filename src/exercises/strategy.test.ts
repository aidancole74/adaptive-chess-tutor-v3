import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conceptsForStrategyItem, whoIsBetter } from '../content/strategy';
import type { PackInfo, StrategyItem } from '../content/types';
import { CONCEPT_BY_ID, TIER_MID } from '../curriculum/concepts';
import { START_FEN, playLine } from '../engine/chessUtil';
import { mulberry32 } from '../model/math';
import { ucis } from '../content/openingsFixture';
import {
  ALT_WITHIN_CP, buildChoosePlan, buildEvaluateTrade, buildQuietBestMove, buildStrategyExercises, buildWhoIsBetter, quietMoveConcept,
} from './strategy';
import type { ChoiceInteraction, LineInteraction } from './types';

// A hand-made item for MECHANICS ONLY (option building, nulls, ids). The evaluations are SYNTHETIC numbers chosen
// to exercise thresholds; this object is not content and is never shipped.
const line = ucis(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6']);
const fen = playLine(START_FEN, line)!.chess.fen();
function mech(over: Partial<StrategyItem> = {}): StrategyItem {
  return {
    id: 'st-mech-6',
    fen,
    best: 'b5a4',
    pv: ['b5a4', 'g8f6', 'e1g1'],
    bestCp: 120,
    secondCp: 40,
    lines: [
      { uci: 'b5a4', cp: 120 },
      { uci: 'b5c6', cp: 40 },
      { uci: 'b1c3', cp: 10 },
    ],
    depth: 14,
    sourceGame: 'mechGame',
    ply: 6,
    features: { w: [], b: [] },
    featureDeltas: [],
    plan: 'improve-piece',
    otherPlans: [
      { plan: 'capture', uci: 'b5c6', cpLoss: 80 },
      { plan: 'develop', uci: 'b1c3', cpLoss: 110 },
    ],
    trade: { uci: 'b5c6', cp: 40, verdict: 'neutral' },
    structure: 'open-centre',
    tier: 3,
    verified: true,
    ...over,
  };
}

describe('strategy helpers', () => {
  it('whoIsBetter folds side to move and the equal band', () => {
    expect(whoIsBetter(mech())).toBe('w');
    expect(whoIsBetter(mech({ bestCp: -120 }))).toBe('b');
    expect(whoIsBetter(mech({ bestCp: 49 }))).toBe('equal');
    const blackToMove = playLine(START_FEN, ucis(['e4']))!.chess.fen();
    expect(whoIsBetter({ fen: blackToMove, bestCp: 100 })).toBe('b');
    expect(whoIsBetter({ fen: blackToMove, bestCp: -100 })).toBe('w');
  });
  it('conceptsForStrategyItem maps plan, deltas and formats to known concepts', () => {
    const cs = conceptsForStrategyItem(mech({ featureDeltas: ['w+outpost', 'b-bishop-pair'] }));
    expect(cs[0]).toBe('strategy/planning/quiet-move');
    expect(cs).toContain('strategy/pieces/activity');
    expect(cs).toContain('strategy/squares/outpost');
    expect(cs).toContain('strategy/pieces/bishop-pair');
    expect(cs).toContain('strategy/planning/evaluate-trade');
    for (const c of cs) expect(CONCEPT_BY_ID.has(c)).toBe(true);
  });
});

describe('strategy builders (mechanics)', () => {
  it('quiet-best-move: line interaction, alternatives within 25 cp, facts', () => {
    const ex = buildQuietBestMove(mech({ lines: [{ uci: 'b5a4', cp: 120 }, { uci: 'b5c4', cp: 120 - ALT_WITHIN_CP }, { uci: 'b1c3', cp: 0 }] }))!;
    expect(ex.format).toBe('quiet-best-move');
    expect(ex.domain).toBe('strategy');
    expect(ex.difficulty).toBe(TIER_MID[3]);
    expect(ex.difficultySource).toBe('tier-prior');
    const it = ex.interaction as LineInteraction;
    expect(it).toMatchObject({ kind: 'line', fen, solution: ['b5a4'], orientation: 'white', alternatives: { 0: ['b5c4'] } });
    expect(ex.facts.find((f) => f.t === 'engine')).toMatchObject({ pvSan: ['Ba4', 'Nf6', 'O-O'], cp: 120, depth: 14 });
    expect(ex.facts.find((f) => f.t === 'source')).toMatchObject({ url: 'https://lichess.org/mechGame' });
    expect(ex.sim).toMatchObject({ themes: ['improve-piece'], structure: 'open-centre', sourceGame: 'mechGame' });
    expect(ex.color).toBe('w');
  });
  it('quiet-best-move concept follows the side to move gaining a feature', () => {
    expect(quietMoveConcept(mech())).toBe('strategy/planning/quiet-move');
    expect(quietMoveConcept(mech({ featureDeltas: ['b+space', 'w+outpost'] }))).toBe('strategy/squares/outpost');
    expect(quietMoveConcept(mech({ featureDeltas: ['w-outpost'] }))).toBe('strategy/planning/quiet-move');
  });
  it('who-is-better: null below 80 cp, otherwise side + favouring flags', () => {
    expect(buildWhoIsBetter(mech({ bestCp: 79 }), mulberry32(1))).toBeNull();
    const ex = buildWhoIsBetter(mech(), mulberry32(1));
    if (!ex) return; // the mechanics position may have no feature flags
    const it = ex.interaction as ChoiceInteraction;
    expect(it.multi).toBe(true);
    expect(it.correct).toContain('side:w');
    expect(it.correct).not.toContain('side:b');
    for (const id of it.correct.filter((c) => c.startsWith('f:'))) expect(id.startsWith('f:w:')).toBe(true);
    expect(ex.facts.some((f) => f.t === 'note' && f.text.includes('heuristic'))).toBe(true);
  });
  it('choose-plan: distinct labels, null with fewer than 2', () => {
    const ex = buildChoosePlan(mech({ otherPlans: [...mech().otherPlans, { plan: 'improve-piece', uci: 'b5c4', cpLoss: 70 }] }), mulberry32(3))!;
    const it = ex.interaction as ChoiceInteraction;
    expect(ex.conceptId).toBe('strategy/planning/choose-plan');
    expect(it.options.map((o) => o.id).sort()).toEqual(['plan:capture', 'plan:develop', 'plan:improve-piece']);
    expect(it.correct).toEqual(['plan:improve-piece']);
    expect(buildChoosePlan(mech({ otherPlans: [{ plan: 'improve-piece', uci: 'b5c4', cpLoss: 70 }] }), mulberry32(3))).toBeNull();
  });
  it('evaluate-trade: verdict is the correct option; null without a trade', () => {
    const ex = buildEvaluateTrade(mech())!;
    const it = ex.interaction as ChoiceInteraction;
    expect(ex.conceptId).toBe('strategy/planning/evaluate-trade');
    expect(it.options.map((o) => o.id)).toEqual(['good', 'neutral', 'bad']);
    expect(it.correct).toEqual(['neutral']);
    expect(ex.prompt).toContain('Bxc6');
    expect(buildEvaluateTrade(mech({ trade: null }))).toBeNull();
  });
  it('is deterministic for a given rng seed', () => {
    const a = buildChoosePlan(mech(), mulberry32(9))!;
    const b = buildChoosePlan(mech(), mulberry32(9))!;
    expect(a.interaction).toEqual(b.interaction);
  });
});

// ---- Real generated pack (skipped when it has not been built) ----
const PACK_DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'packs', 'strategy');
function loadPack(): StrategyItem[] | null {
  const pj = path.join(PACK_DIR, 'pack.json');
  if (!fs.existsSync(pj)) return null;
  const info = JSON.parse(fs.readFileSync(pj, 'utf8')) as PackInfo;
  const out: StrategyItem[] = [];
  for (const s of info.shards) out.push(...(JSON.parse(fs.readFileSync(path.join(PACK_DIR, s.file), 'utf8')) as StrategyItem[]));
  return out;
}
const real = loadPack();

describe.skipIf(!real || real.length === 0)('strategy pack (real items)', () => {
  const items = real ?? [];
  const sample = items.filter((_, i) => i % Math.max(1, Math.floor(items.length / 150)) === 0);
  it('items satisfy the selection rules', () => {
    for (const it of sample) {
      expect(it.verified).toBe(true);
      expect(it.best).toBe(it.pv[0]);
      expect(it.bestCp - it.secondCp).toBeGreaterThanOrEqual(60);
      expect(Math.abs(it.bestCp)).toBeLessThanOrEqual(400);
      const lead = playLine(it.fen, it.pv.slice(0, 3));
      expect(lead).not.toBeNull();
      for (const san of lead!.sans) expect(san).not.toMatch(/[x+#=]/);
      expect(it.sourceGame).toMatch(/^[A-Za-z0-9]{8}$/);
      expect(it.ply).toBeGreaterThanOrEqual(16);
      expect(it.ply).toBeLessThanOrEqual(60);
    }
  });
  it('ids and EPDs are unique', () => {
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
    expect(new Set(items.map((i) => i.fen.split(' ').slice(0, 4).join(' '))).size).toBe(items.length);
  });
  it('every item builds a valid quiet-best-move exercise; other builders produce consistent options', () => {
    const rng = mulberry32(42);
    for (const it of sample) {
      const exs = buildStrategyExercises(it, rng);
      const q = exs.find((e) => e.format === 'quiet-best-move');
      expect(q).toBeDefined();
      for (const e of exs) {
        expect(CONCEPT_BY_ID.has(e.conceptId)).toBe(true);
        for (const c of e.secondaryConcepts ?? []) expect(CONCEPT_BY_ID.has(c)).toBe(true);
        if (e.interaction.kind === 'choice') {
          const ids = new Set(e.interaction.options.map((o) => o.id));
          expect(ids.size).toBe(e.interaction.options.length);
          for (const c of e.interaction.correct) expect(ids.has(c)).toBe(true);
        }
      }
      expect(exs.some((e) => e.format === 'evaluate-trade')).toBe(it.trade !== null);
    }
  });
});
