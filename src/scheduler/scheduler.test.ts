import { describe, expect, it } from 'vitest';
import { CONCEPTS } from '../curriculum/concepts';
import { activeConcepts, advanceStage, refreshCurriculum, stageOf, validateDag } from '../curriculum/progress';
import { applyResult, newLearner, seedRating } from '../model/learner';
import { DAY, mulberry32, pSolve } from '../model/math';
import { DEFAULT_SETTINGS, PRESETS, applyPreset, sanitizeSettings, type Settings } from '../model/settings';
import type { CurriculumStage, LearnerState } from '../model/types';
import { auditSession, bandFor, dueMemoryKeys, mixCounts, newSession, pickNext, planSlots, similarity, slotCount, type SchedPick, type SessionState } from './scheduler';
import { makeSyntheticPool } from './syntheticPool';

const T0 = 1_700_000_000_000;
const pool = makeSyntheticPool();
const allIds = new Set(pool.concepts());

function everythingActive(stage: CurriculumStage = 'unsupported'): Map<string, CurriculumStage> {
  return new Map(CONCEPTS.map((c) => [c.id, stage]));
}

/** Runs one session against a simulated learner of fixed hidden ability. */
function runSession(
  state: LearnerState,
  settings: Settings,
  seed: number,
  opts: { now?: number; hidden?: (conceptId: string) => number; active?: Map<string, CurriculumStage>; dynamic?: boolean } = {},
): { session: SessionState; picks: SchedPick[] } {
  const rng = mulberry32(seed);
  let now = opts.now ?? T0;
  const session = newSession(settings, now, rng);
  const picks: SchedPick[] = [];
  for (let i = 0; i < session.slots.length; i++) {
    const active = opts.dynamic ? activeConcepts(state) : (opts.active ?? everythingActive());
    const pick = pickNext({ state, settings, now, rng, pool, session, active });
    if (!pick) break;
    picks.push(pick);
    const hidden = opts.hidden?.(pick.cand.conceptId) ?? 1500;
    const solved = pick.cand.format === 'lesson' ? true : rng() < pSolve(hidden, pick.cand.difficulty);
    applyResult(state, pick.cand, { exerciseId: pick.cand.id, score: solved ? 1 : 0, solved, hintsUsed: 0, timeMs: 20_000 }, now, {
      retention: settings.retention,
      ratingNeutral: pick.cand.format === 'lesson',
    });
    if (opts.dynamic) advanceStage(state, pick.cand, { solved, hintsUsed: 0 }, now);
    session.done.push({ cand: pick.cand, solved });
    now += 60_000;
  }
  return { session, picks };
}

function trained(rating = 1500): LearnerState {
  const s = newLearner(T0, rating, 90);
  seedRating(s, rating, 90, T0);
  return s;
}

describe('session template', () => {
  it('slot count follows session length', () => {
    expect([5, 10, 20, 40].map(slotCount)).toEqual([5, 9, 16, 30]);
  });
  it('template is warm-up, core, challenge, cool-down', () => {
    const kinds = planSlots(DEFAULT_SETTINGS, mulberry32(1)).map((s) => s.kind);
    expect(kinds[0]).toBe('warmup');
    expect(kinds[kinds.length - 1]).toBe('cooldown');
    expect(kinds.indexOf('challenge')).toBeGreaterThan(kinds.lastIndexOf('core'));
  });
  it('default mix is 55 / 25 / 20', () => {
    expect(mixCounts(20, DEFAULT_SETTINGS)).toEqual({ weakness: 11, review: 5, explore: 4 });
    const slots = planSlots({ ...DEFAULT_SETTINGS, sessionMinutes: 40 }, mulberry32(3));
    const n = (c: string): number => slots.filter((s) => s.category === c).length;
    expect(n('weakness')).toBeGreaterThan(n('review'));
    expect(n('review')).toBeGreaterThanOrEqual(n('explore'));
  });
  it('warm-up and cool-down bands are easier, challenge is harder', () => {
    const core = bandFor({ kind: 'core', category: 'weakness' }, DEFAULT_SETTINGS);
    expect(bandFor({ kind: 'warmup', category: 'review' }, DEFAULT_SETTINGS)[0]).toBeGreaterThan(core[1]);
    expect(bandFor({ kind: 'challenge', category: 'weakness' }, DEFAULT_SETTINGS)[1]).toBeLessThan(core[1]);
  });
});

describe('hard constraints', () => {
  it('hold across many sessions: <=2 of a concept in any 5, >=4 concepts, >=2 formats, no repeated item', () => {
    for (let seed = 1; seed <= 25; seed++) {
      const state = trained(1100 + seed * 30);
      const { session } = runSession(state, { ...DEFAULT_SETTINGS, sessionMinutes: seed % 2 ? 10 : 20 }, seed);
      const a = auditSession(session.done);
      expect(session.done.length).toBe(session.slots.length);
      expect(a.maxInWindow).toBeLessThanOrEqual(2);
      expect(a.distinctConcepts).toBeGreaterThanOrEqual(4);
      expect(a.formats).toBeGreaterThanOrEqual(2);
      expect(new Set(session.done.map((d) => d.cand.itemId)).size).toBe(session.done.length);
    }
  });
  it('constraints survive an extreme weakness that the scores would otherwise hammer', () => {
    const state = trained(1500);
    const weak = 'tactics/double-attack/fork';
    for (let i = 0; i < 30; i++) {
      applyResult(state, pool.sample(weak, 1400, 40, mulberry32(i))[i]!, { exerciseId: 'x', score: 0, solved: false, hintsUsed: 0, timeMs: 1 }, T0 - DAY * 40 + i, { retention: 0.9 });
    }
    const { session } = runSession(state, { ...DEFAULT_SETTINGS, mixWeakness: 100, mixReview: 0, mixExplore: 0, varietyStrength: 0 }, 5);
    expect(auditSession(session.done).maxInWindow).toBeLessThanOrEqual(2);
    expect(session.done.filter((d) => d.cand.conceptId === weak).length).toBeGreaterThanOrEqual(2);
  });
  it('relaxes and says so when the pool is too small', () => {
    const tiny = makeSyntheticPool({ concepts: ['tactics/double-attack/fork'], formats: ['solve'] });
    const state = trained();
    const rng = mulberry32(2);
    const session = newSession({ ...DEFAULT_SETTINGS, sessionMinutes: 5 }, T0, rng);
    const active = new Map<string, CurriculumStage>([['tactics/double-attack/fork', 'unsupported']]);
    let relaxed = false;
    for (let i = 0; i < session.slots.length; i++) {
      const pick = pickNext({ state, settings: DEFAULT_SETTINGS, now: T0, rng, pool: tiny, session, active })!;
      expect(pick).not.toBeNull();
      relaxed ||= pick.relaxed;
      if (pick.relaxed) expect(pick.why).toContain('relaxed');
      session.done.push({ cand: pick.cand, solved: true });
    }
    expect(relaxed).toBe(true);
  });
});

describe('every pick is explained', () => {
  it('why-lines mention the concept and predicted success', () => {
    const { picks } = runSession(trained(), DEFAULT_SETTINGS, 11);
    for (const p of picks) {
      expect(p.why).toMatch(/Predicted success \d+%/);
      expect(p.why.length).toBeGreaterThan(30);
    }
  });
  it('a known weakness is named as such with opportunities, not raw error counts', () => {
    const state = trained(1500);
    const weak = 'tactics/double-attack/fork';
    for (let i = 0; i < 20; i++) applyResult(state, pool.all.filter((c) => c.conceptId === weak)[i]!, { exerciseId: 'x', score: 0, solved: false, hintsUsed: 0, timeMs: 1 }, T0 - DAY * 40, { retention: 0.9 });
    let found = '';
    for (let seed = 1; seed < 8 && !found; seed++) {
      const { picks } = runSession(structuredClone(state), DEFAULT_SETTINGS, seed);
      found = picks.find((p) => p.cand.conceptId === weak && p.why.startsWith('Weakness'))?.why ?? '';
    }
    expect(found).toMatch(/points below your overall level \(\d+% solved over \d+ tries\)/);
  });
});

describe('settings change scheduler behaviour', () => {
  const meanP = (s: Settings): number => {
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { picks } = runSession(trained(), s, seed);
      for (const p of picks) {
        if (p.slot.kind === 'core') {
          sum += p.p;
          n++;
        }
      }
    }
    return sum / n;
  };
  it('challenge band shifts predicted success of core picks', () => {
    const hard = meanP({ ...DEFAULT_SETTINGS, bandLow: 0.6, bandHigh: 0.65 });
    const easy = meanP({ ...DEFAULT_SETTINGS, bandLow: 0.85, bandHigh: 0.9 });
    expect(easy - hard).toBeGreaterThan(0.12);
    expect(hard).toBeGreaterThan(0.5);
    expect(hard).toBeLessThan(0.75);
  });
  it('session length changes the number of exercises', () => {
    expect(runSession(trained(), { ...DEFAULT_SETTINGS, sessionMinutes: 5 }, 1).session.done.length).toBe(5);
    expect(runSession(trained(), { ...DEFAULT_SETTINGS, sessionMinutes: 40 }, 1).session.done.length).toBe(30);
  });
  it('disabled domains never appear; domain weights shift the share', () => {
    const off = { ...DEFAULT_SETTINGS, domainEnabled: { ...DEFAULT_SETTINGS.domainEnabled, tactics: false } };
    expect(runSession(trained(), off, 4).session.done.some((d) => d.cand.domain === 'tactics')).toBe(false);
    const share = (s: Settings): number => {
      let eg = 0;
      let n = 0;
      for (let seed = 1; seed <= 10; seed++) {
        for (const d of runSession(trained(), s, seed).session.done) {
          n++;
          if (d.cand.domain === 'endgames') eg++;
        }
      }
      return eg / n;
    };
    const low = share({ ...DEFAULT_SETTINGS, domainWeight: { ...DEFAULT_SETTINGS.domainWeight, endgames: 0.05 } });
    const high = share(applyPreset(DEFAULT_SETTINGS, 'endgame-school'));
    expect(high).toBeGreaterThan(low + 0.15);
  });
  it('focus mix changes slot categories', () => {
    const count = (s: Settings, c: string): number => planSlots(s, mulberry32(1)).filter((x) => x.category === c).length;
    const base = { ...DEFAULT_SETTINGS, sessionMinutes: 20 as const };
    expect(count({ ...base, mixWeakness: 10, mixReview: 80, mixExplore: 10 }, 'review')).toBeGreaterThan(count(base, 'review') + 5);
  });
  it('variety strength reduces similarity between consecutive picks', () => {
    const repeats = (s: Settings): number => {
      let r = 0;
      for (let seed = 1; seed <= 15; seed++) {
        const done = runSession(trained(), s, seed).session.done;
        for (let i = 1; i < done.length; i++) r += similarity(done[i]!.cand, done[i - 1]!.cand);
      }
      return r;
    };
    expect(repeats({ ...DEFAULT_SETTINGS, varietyStrength: 2 })).toBeLessThan(repeats({ ...DEFAULT_SETTINGS, varietyStrength: 0 }));
  });
  it('retention target changes how many memory items are due', () => {
    const state = trained();
    const mem = pool.all.filter((c) => c.memoryKey).slice(0, 30);
    for (const c of mem) applyResult(state, c, { exerciseId: c.id, score: 1, solved: true, hintsUsed: 0, timeMs: 15_000 }, T0, { retention: 0.9 });
    const later = T0 + 4 * DAY;
    expect(dueMemoryKeys(state, later, 0.95, 100).length).toBeGreaterThan(dueMemoryKeys(state, later, 0.8, 100).length);
  });
  it('due memory items are scheduled and explained as reviews', () => {
    const state = trained();
    const mem = pool.all.filter((c) => c.memoryKey).slice(0, 12);
    for (const c of mem) applyResult(state, c, { exerciseId: c.id, score: 1, solved: true, hintsUsed: 0, timeMs: 15_000 }, T0, { retention: 0.9 });
    const { picks } = runSession(state, { ...DEFAULT_SETTINGS, mixWeakness: 20, mixReview: 70, mixExplore: 10 }, 3, { now: T0 + 30 * DAY });
    const due = picks.filter((p) => p.why.startsWith('Review due'));
    expect(due.length).toBeGreaterThan(0);
    expect(due[0]!.why).toMatch(/estimated recall \d+%/);
  });
  it('goal rating raises the share of goal-tier concepts', () => {
    const tierShare = (s: Settings): number => {
      let hi = 0;
      let n = 0;
      for (let seed = 1; seed <= 12; seed++) {
        for (const d of runSession(trained(1300), s, seed).session.done) {
          n++;
          if ((CONCEPTS.find((c) => c.id === d.cand.conceptId)?.tier ?? 0) >= 3) hi++;
        }
      }
      return hi / n;
    };
    expect(tierShare({ ...DEFAULT_SETTINGS, goalRating: 1900 })).toBeGreaterThan(tierShare(DEFAULT_SETTINGS));
  });
  it('presets and sanitising', () => {
    expect(applyPreset(DEFAULT_SETTINGS, 'deep-study').sessionMinutes).toBe(40);
    expect(Object.keys(PRESETS).length).toBeGreaterThanOrEqual(4);
    const s = sanitizeSettings({ ...DEFAULT_SETTINGS, bandLow: 0.1, bandHigh: 0.99, retention: 0.5 });
    expect(s.bandLow).toBe(0.6);
    expect(s.bandHigh).toBe(0.9);
    expect(s.retention).toBe(0.8);
  });
});

describe('curriculum', () => {
  it('the prerequisite DAG is valid', () => {
    expect(validateDag()).toEqual([]);
  });
  it('a new learner starts with root concepts only; new-concept rate limits later unlocks', () => {
    const s = newLearner(T0, 900, 300);
    const first = refreshCurriculum(s, T0, allIds, 1);
    expect(first.unlocked.length).toBeGreaterThanOrEqual(4);
    for (const id of first.unlocked) expect(CONCEPTS.find((c) => c.id === id)!.prereqs.filter((p) => p.type === 'requires')).toEqual([]);
    expect(stageOf(s, 'tactics/double-attack/fork')).toBe('locked');
    expect(refreshCurriculum(s, T0, allIds, 0).unlocked).toEqual([]);
  });
  it('mastering prerequisites unlocks dependants; stages run lesson -> supported -> unsupported -> check -> mastered', () => {
    const s = newLearner(T0, 1000, 150);
    refreshCurriculum(s, T0, allIds, 1);
    const hp = 'tactics/basics/hangingPiece';
    expect(stageOf(s, hp)).toBe('lesson');
    const ok = { solved: true, hintsUsed: 0 };
    expect(advanceStage(s, { conceptId: hp, format: 'solve' }, ok, T0)).toBeNull();
    expect(advanceStage(s, { conceptId: hp, format: 'lesson' }, ok, T0)).toBe('supported');
    const items = pool.all.filter((c) => c.conceptId === hp && c.difficulty > 900);
    let stage: CurriculumStage | null = 'supported';
    let i = 0;
    while (stageOf(s, hp) !== 'mastered' && i < 30) {
      const c = items[i++]!;
      applyResult(s, c, { exerciseId: c.id, score: 1, solved: true, hintsUsed: 0, timeMs: 9000 }, T0 + i, { retention: 0.9 });
      stage = advanceStage(s, c, ok, T0 + i) ?? stage;
    }
    expect(stage).toBe('mastered');
    expect(i).toBe(3 + 4 + 4);
    const r = refreshCurriculum(s, T0 + 100, allIds, 3);
    expect(r.unlocked).toContain('tactics/double-attack/fork');
  });
  it('hints do not count toward unsupported practice and a failed check sends the learner back', () => {
    const s = newLearner(T0);
    s.curriculum.x = { stage: 'unsupported', progress: 0, attempts: 0, unlockedAt: T0, masteredAt: null };
    for (let i = 0; i < 6; i++) advanceStage(s, { conceptId: 'x', format: 'solve' }, { solved: true, hintsUsed: 1 }, T0);
    expect(stageOf(s, 'x')).toBe('unsupported');
    s.curriculum.x = { stage: 'check', progress: 0, attempts: 0, unlockedAt: T0, masteredAt: null };
    for (let i = 0; i < 5; i++) advanceStage(s, { conceptId: 'x', format: 'solve' }, { solved: i < 2, hintsUsed: 0 }, T0);
    expect(stageOf(s, 'x')).toBe('unsupported');
  });
  it('advanced material is gated on the basic-blunder rate', () => {
    const s = newLearner(T0, 1300, 100);
    const hp = pool.all.filter((c) => c.conceptId === 'tactics/basics/hangingPiece');
    for (let i = 0; i < 12; i++) applyResult(s, hp[i]!, { exerciseId: 'x', score: i % 2, solved: i % 2 === 1, hintsUsed: 0, timeMs: 1 }, T0, { retention: 0.9 });
    for (const c of CONCEPTS) if (c.tier < 3) s.curriculum[c.id] = { stage: 'mastered', progress: 0, attempts: 0, unlockedAt: T0, masteredAt: T0 };
    s.nodes.global!.theta = 1700;
    const r = refreshCurriculum(s, T0 + 1, allIds, 10);
    expect(r.unlocked.filter((id) => CONCEPTS.find((c) => c.id === id)!.gated)).toEqual([]);
  });
  it('mastery decays without review and the concept returns to a check', () => {
    const s = newLearner(T0, 1000, 100);
    const id = 'tactics/double-attack/fork';
    const items = pool.all.filter((c) => c.conceptId === id && c.difficulty > 800 && c.difficulty < 1060);
    for (let i = 0; i < 10; i++) applyResult(s, items[i]!, { exerciseId: 'x', score: 1, solved: true, hintsUsed: 0, timeMs: 1 }, T0, { retention: 0.9 });
    s.curriculum[id] = { stage: 'mastered', progress: 0, attempts: 0, unlockedAt: T0, masteredAt: T0 };
    expect(refreshCurriculum(s, T0 + DAY, allIds, 0).decayed).toEqual([]);
    expect(refreshCurriculum(s, T0 + 400 * DAY, allIds, 0).decayed).toContain(id);
    expect(activeConcepts(s).get(id)).toBe('check');
  });
  it('a seeded strong player places out of basics', () => {
    const s = newLearner(T0);
    seedRating(s, 1900, 110, T0);
    const r = refreshCurriculum(s, T0, allIds, 2);
    expect(r.placedOut).toContain('tactics/basics/hangingPiece');
    expect(stageOf(s, 'tactics/double-attack/fork')).toBe('mastered');
  });
  it('a brand-new learner gets a full first session (lessons fill in while little is unlocked)', () => {
    const s = newLearner(T0, 1200, 350);
    refreshCurriculum(s, T0, allIds, 1);
    const { session, picks } = runSession(s, DEFAULT_SETTINGS, 21, { dynamic: true });
    expect(session.done.length).toBe(session.slots.length);
    expect(picks.some((p) => p.cand.format === 'lesson')).toBe(true);
    expect(picks.some((p) => p.cand.format !== 'lesson')).toBe(true);
  });
  it('a lesson card is scheduled before practice on a new concept', () => {
    const s = trained(1200);
    const active = new Map<string, CurriculumStage>(CONCEPTS.filter((c) => c.tier <= 1).map((c) => [c.id, 'unsupported']));
    active.set('tactics/double-attack/discoveredAttack', 'lesson');
    const { picks } = runSession(s, DEFAULT_SETTINGS, 9, { active });
    const lesson = picks.findIndex((p) => p.cand.format === 'lesson');
    expect(lesson).toBeGreaterThanOrEqual(0);
    expect(picks[lesson]!.why).toContain('New concept');
    expect(picks.slice(0, lesson).some((p) => p.cand.conceptId === 'tactics/double-attack/discoveredAttack')).toBe(false);
  });
});
