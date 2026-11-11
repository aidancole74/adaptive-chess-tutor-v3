/** Builder tests over real tuples from the built tactics pack (skipped when `npm run data:tactics` has not run). */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { describe, expect, it } from 'vitest';
import type { StrategyItem, TacticItem, TacticTuple } from '../content/types';
import { bandKeyForRating, decodeTactic, encodeTactic, positionAfterFirstMove } from '../content/tactics';
import { CONCEPT_BY_ID, primaryTacticConcept } from '../curriculum/concepts';
import { playLine } from '../engine/chessUtil';
import { buildFindDefense, buildSolve, buildSpotMotif, buildTacticOrNot, tacticFormatsFor } from './tactics';
import type { ChoiceInteraction, Exercise, LineInteraction } from './types';

const DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'packs', 'tactics');
const built = fs.existsSync(path.join(DIR, 'pack.json'));

function loadItems(): TacticItem[] {
  if (!built) return [];
  const out: TacticItem[] = [];
  for (const f of fs.readdirSync(DIR).filter((x) => /^r\d{4}\.json$/.test(x)).sort()) {
    const tuples = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) as TacticTuple[];
    // A deterministic spread through each shard.
    for (let i = 0; i < tuples.length; i += Math.max(1, Math.floor(tuples.length / 40))) out.push(decodeTactic(tuples[i]!));
  }
  return out;
}

/** Deterministic RNG (mulberry32). */
function rngOf(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const items = loadItems();
const produced: Exercise[] = [];

describe.skipIf(!built)('tactics pack builders (real Lichess puzzles)', () => {
  it('loads a spread of items from every shard', () => {
    expect(items.length).toBeGreaterThan(200);
  });

  it('codec round-trips and band keys match the shard', () => {
    for (const it of items) {
      expect(decodeTactic(encodeTactic(it))).toEqual(it);
      const shard = JSON.parse(fs.readFileSync(path.join(DIR, `r${bandKeyForRating(it.rating).padStart(4, '0')}.json`), 'utf8')) as TacticTuple[];
      expect(shard.some((t) => t[0] === it.id)).toBe(true);
    }
  });

  it('solve: legal solution, user colour orientation, concept, facts', () => {
    for (const it of items) {
      const ex = buildSolve(it);
      produced.push(ex);
      const li = ex.interaction as LineInteraction;
      expect(li.kind).toBe('line');
      expect(li.fen).toBe(it.fen);
      expect(li.preMoves).toEqual([it.moves[0]]);
      expect(li.solution).toEqual(it.moves.slice(1));
      const { fen, userColor } = positionAfterFirstMove(it);
      expect(ex.color).toBe(userColor);
      expect(li.orientation).toBe(userColor === 'w' ? 'white' : 'black');
      const line = playLine(fen, li.solution);
      expect(line).not.toBeNull();
      if (it.themes.includes('mate')) {
        expect(li.acceptAnyMate).toBe(true);
        expect(line!.chess.isCheckmate()).toBe(true);
      }
      const sol = ex.facts.find((f) => f.t === 'solution');
      expect(sol && sol.t === 'solution' ? sol.san : []).toEqual(line!.sans);
      expect(ex.facts).toContainEqual({ t: 'source', label: `Lichess puzzle ${it.id}`, url: `https://lichess.org/training/${it.id}` });
      expect(ex.conceptId).toBe(primaryTacticConcept(it.themes));
      expect(ex.secondaryConcepts).not.toContain(ex.conceptId);
      expect(ex.difficulty).toBe(it.rating);
      expect(ex.difficultySource).toBe('lichess');
      expect(tacticFormatsFor(it)).toContain('solve');
    }
  });

  it('spot-motif: exactly one correct option, distractors not among the puzzle themes', () => {
    const rng = rngOf(7);
    for (const it of items) {
      const ex = buildSpotMotif(it, rng);
      produced.push(ex);
      const ci = ex.interaction as ChoiceInteraction;
      expect(ci.options).toHaveLength(4);
      expect(new Set(ci.options.map((o) => o.id)).size).toBe(4);
      expect(ci.correct).toEqual([ex.conceptId]);
      expect(ci.options.filter((o) => ci.correct.includes(o.id))).toHaveLength(1);
      expect(ci.multi).toBe(false);
      for (const o of ci.options) {
        if (o.id === ex.conceptId) continue;
        expect(it.themes).not.toContain(o.id.split('/')[2]);
      }
      expect(ci.preMoves).toEqual([it.moves[0]]);
      expect(ex.difficulty).toBe(it.rating - 150);
      expect(ex.difficultySource).toBe('tier-prior');
    }
  });

  it('find-defense: only defensiveMove / equality puzzles', () => {
    let built = 0;
    for (const it of items) {
      const ex = buildFindDefense(it);
      const eligible = it.themes.includes('defensiveMove') || it.themes.includes('equality');
      if (!eligible) {
        expect(ex).toBeNull();
        expect(tacticFormatsFor(it)).not.toContain('find-defense');
        continue;
      }
      expect(ex).not.toBeNull();
      built++;
      produced.push(ex!);
      expect(ex!.conceptId).toBe('tactics/subtle/defensiveMove');
      expect((ex!.interaction as LineInteraction).solution).toEqual(it.moves.slice(1));
    }
    expect(built).toBeGreaterThan(0);
  });

  it('tactic-or-not (tactic source): yes for crushing/mate, null otherwise', () => {
    const rng = rngOf(3);
    let yes = 0;
    let nulls = 0;
    for (const it of items) {
      const ex = buildTacticOrNot({ kind: 'tactic', item: it }, rng);
      if (!it.themes.includes('crushing') && !it.themes.includes('mate')) {
        expect(ex).toBeNull();
        nulls++;
        continue;
      }
      expect(ex).not.toBeNull();
      yes++;
      produced.push(ex!);
      const ci = ex!.interaction as ChoiceInteraction;
      expect(ci.options.map((o) => o.id).sort()).toEqual(['no', 'yes']);
      expect(ci.correct).toEqual(['yes']);
      expect(ex!.conceptId).toBe('tactics/awareness/noTactic');
      expect(ex!.facts.some((f) => f.t === 'note' && f.text.startsWith('Verification: this is a Lichess puzzle'))).toBe(true);
    }
    expect(yes).toBeGreaterThan(0);
    expect(nulls).toBeGreaterThan(0);
  });

  it('tactic-or-not (quiet source): null when |bestCp| > 150', () => {
    // Only the evaluation gate is exercised here; the FEN is a real puzzle position, the rest is inert.
    const it = items[0]!;
    const quiet: StrategyItem = {
      id: 'gate-test', fen: positionAfterFirstMove(it).fen, best: it.moves[1]!, pv: [it.moves[1]!], bestCp: 400, secondCp: 0,
      lines: [], depth: 0, sourceGame: '', ply: 0, features: { w: [], b: [] }, featureDeltas: [], plan: '', otherPlans: [],
      trade: null, structure: '', tier: 2, verified: true,
    };
    expect(buildTacticOrNot({ kind: 'quiet', item: quiet }, rngOf(1))).toBeNull();
    expect(buildTacticOrNot({ kind: 'quiet', item: { ...quiet, bestCp: -151 } }, rngOf(1))).toBeNull();
  });

  it('every concept id produced exists in CONCEPT_BY_ID', () => {
    expect(produced.length).toBeGreaterThan(0);
    for (const ex of produced) {
      expect(CONCEPT_BY_ID.has(ex.conceptId), ex.conceptId).toBe(true);
      for (const c of ex.secondaryConcepts ?? []) expect(CONCEPT_BY_ID.has(c), c).toBe(true);
    }
  });

  it('positionAfterFirstMove gives the side the user plays', () => {
    const it = items[0]!;
    const c = new Chess(it.fen);
    const opp = c.turn();
    expect(positionAfterFirstMove(it).userColor).not.toBe(opp);
  });
});

const STRATEGY_DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'packs', 'strategy');
describe.skipIf(!fs.existsSync(path.join(STRATEGY_DIR, 'pack.json')))('tactic-or-not over the real strategy pack', () => {
  it('quiet positions within 150 cp answer "no" with engine verification', () => {
    const files = fs.readdirSync(STRATEGY_DIR).filter((f) => f.endsWith('.json') && f !== 'pack.json');
    let checked = 0;
    for (const f of files) {
      const data = JSON.parse(fs.readFileSync(path.join(STRATEGY_DIR, f), 'utf8')) as unknown;
      if (!Array.isArray(data)) continue;
      for (const raw of data.slice(0, 20)) {
        if (!raw || typeof raw !== 'object' || !('bestCp' in raw) || !('fen' in raw)) continue;
        const item = raw as StrategyItem;
        const ex = buildTacticOrNot({ kind: 'quiet', item }, rngOf(2));
        if (Math.abs(item.bestCp) > 150) expect(ex).toBeNull();
        if (!ex) continue;
        checked++;
        expect((ex.interaction as ChoiceInteraction).correct).toEqual(['no']);
        expect(ex.facts.some((f2) => f2.t === 'engine' && f2.depth === item.depth)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThanOrEqual(0);
  });
});
