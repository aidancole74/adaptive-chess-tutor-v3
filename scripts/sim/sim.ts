/**
 * Scheduler simulation. Synthetic learners have a hidden skill per concept, learn from practice with
 * diminishing returns, and forget without practice. Each policy chooses exercises from the same
 * synthetic pool; every policy updates the same learner model so estimation quality is comparable.
 *
 * Learning-model assumptions (deliberately neutral about the target band, so the result is not built in):
 *  - every attempt on a concept raises its hidden skill by GAIN * (1 - (skill - base)/HEADROOM), whatever the outcome;
 *  - skills decay toward the starting level with half-life FORGET_HALF_LIFE_DAYS without practice;
 *  - outcomes are Bernoulli with P = logistic((hidden - difficulty)/SCALE).
 */
import { CONCEPTS, TIER_MID } from '../../src/curriculum/concepts';
import { activeConcepts, advanceStage, refreshCurriculum } from '../../src/curriculum/progress';
import { applyResult, estimate, newLearner, predict } from '../../src/model/learner';
import { DAY, gaussian, mulberry32, pSolve } from '../../src/model/math';
import { brier, ece } from '../../src/model/calibration';
import { DEFAULT_SETTINGS, type Settings } from '../../src/model/settings';
import type { CurriculumStage, LearnerState } from '../../src/model/types';
import type { Candidate } from '../../src/exercises/types';
import { newSession, pickNext } from '../../src/scheduler/scheduler';
import { makeSyntheticPool } from '../../src/scheduler/syntheticPool';

export const GAIN = 9;
export const HEADROOM = 450;
export const FORGET_HALF_LIFE_DAYS = 45;

export type PolicyName = 'adaptive' | 'adaptive-no-curriculum' | 'random' | 'weakest-only' | 'fixed-curriculum';

export interface SimConfig {
  learners: number;
  days: number;
  sessionMinutes: Settings['sessionMinutes'];
  /** Idle days before the final retention test. */
  retentionGapDays: number;
  seed: number;
  concepts: number;
}

interface Hidden {
  base: Record<string, number>;
  skill: Record<string, number>;
  last: Record<string, number>;
}

function makeHidden(ids: string[], rng: () => number): Hidden {
  const global = 1050 + gaussian(rng) * 220;
  const base: Record<string, number> = {};
  const domainOff: Record<string, number> = {};
  for (const id of ids) {
    const d = id.split('/')[0]!;
    domainOff[d] ??= gaussian(rng) * 120;
    base[id] = global + domainOff[d]! + gaussian(rng) * 150;
  }
  return { base, skill: { ...base }, last: {} };
}

function decay(h: Hidden, id: string, now: number): void {
  const last = h.last[id];
  if (last === undefined) return;
  const days = (now - last) / DAY;
  const f = Math.pow(0.5, days / FORGET_HALF_LIFE_DAYS);
  h.skill[id] = h.base[id]! + (h.skill[id]! - h.base[id]!) * f;
  h.last[id] = now;
}

function practise(h: Hidden, id: string, now: number): void {
  decay(h, id, now);
  const s = h.skill[id]!;
  h.skill[id] = s + GAIN * Math.max(0, 1 - (s - h.base[id]!) / HEADROOM);
  h.last[id] = now;
}

function skillAt(h: Hidden, id: string, now: number): number {
  const last = h.last[id];
  if (last === undefined) return h.skill[id]!;
  const f = Math.pow(0.5, (now - last) / DAY / FORGET_HALF_LIFE_DAYS);
  return h.base[id]! + (h.skill[id]! - h.base[id]!) * f;
}

export interface PolicyResult {
  policy: PolicyName;
  rmseEstimate: number;
  rmsePractised: number;
  brier: number;
  ece: number;
  maxStreak: number;
  conceptEntropy: number;
  distinctPerSession: number;
  meanGain: number;
  retention: number;
  meanP: number;
  attempts: number;
}

function entropy(counts: Map<string, number>, k: number): number {
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0 || k <= 1) return 0;
  let e = 0;
  for (const c of counts.values()) {
    const p = c / total;
    e -= p * Math.log(p);
  }
  return e / Math.log(k);
}

export function runPolicy(policy: PolicyName, cfg: SimConfig): PolicyResult {
  const ids = pickConcepts(cfg.concepts);
  const pool = makeSyntheticPool({ concepts: ids, perConcept: 80, formats: ['solve', 'spot-motif', 'eg-best-move'] });
  const byConcept = new Map<string, Candidate[]>();
  for (const c of pool.all) (byConcept.get(c.conceptId) ?? byConcept.set(c.conceptId, []).get(c.conceptId)!).push(c);
  const settings: Settings = { ...DEFAULT_SETTINGS, sessionMinutes: cfg.sessionMinutes };
  const all = new Set(ids);

  let sqErr = 0;
  let nErr = 0;
  let sqErrP = 0;
  let nErrP = 0;
  const rows: { p: number; solved: boolean }[] = [];
  let maxStreak = 0;
  let distinctSum = 0;
  let sessions = 0;
  let gainSum = 0;
  let retSum = 0;
  let retN = 0;
  let pSum = 0;
  const counts = new Map<string, number>();

  for (let L = 0; L < cfg.learners; L++) {
    const rng = mulberry32(cfg.seed * 1000 + L);
    const hidden = makeHidden(ids, mulberry32(cfg.seed * 7777 + L)); // same learners for every policy
    const t0 = 1_700_000_000_000;
    const state: LearnerState = newLearner(t0, 1200, 350);
    let fixedIndex = 0;
    let fixedCount = 0;
    for (let day = 0; day < cfg.days; day++) {
      let now = t0 + day * DAY;
      const session = newSession(settings, now, rng);
      if (policy === 'adaptive') refreshCurriculum(state, now, all, settings.newConceptRate);
      const active: Map<string, CurriculumStage> =
        policy === 'adaptive' ? activeConcepts(state) : new Map(ids.map((id) => [id, 'unsupported' as CurriculumStage]));
      let streak = 0;
      let prev = '';
      for (let i = 0; i < session.slots.length; i++) {
        let cand: Candidate | null;
        if (policy === 'adaptive' || policy === 'adaptive-no-curriculum') {
          cand = pickNext({ state, settings, now, rng, pool, session, active })?.cand ?? null;
        } else if (policy === 'random') {
          const id = ids[Math.floor(rng() * ids.length)]!;
          const list = byConcept.get(id)!;
          cand = list[Math.floor(rng() * list.length)]!;
        } else if (policy === 'weakest-only') {
          // Always the concept with the lowest estimate, item at the estimate (50% predicted).
          let best = ids[0]!;
          let lo = Infinity;
          for (const id of ids) {
            const e = estimate(state, id, now).theta;
            if (e < lo) {
              lo = e;
              best = id;
            }
          }
          const list = byConcept.get(best)!;
          cand = list.reduce((a, b) => (Math.abs(b.difficulty - lo) < Math.abs(a.difficulty - lo) ? b : a));
        } else {
          // Fixed curriculum: concepts in tier order, 12 attempts each, items at the concept's tier midpoint and rising.
          const id = ids[fixedIndex % ids.length]!;
          const list = byConcept.get(id)!;
          cand = list[Math.min(list.length - 1, Math.floor((fixedCount / 12) * list.length * 0.6 + list.length * 0.2))]!;
          fixedCount++;
          if (fixedCount >= 12) {
            fixedCount = 0;
            fixedIndex++;
          }
        }
        if (!cand) break;
        if (cand.format === 'lesson') {
          applyResult(state, cand, { exerciseId: cand.id, score: 1, solved: true, hintsUsed: 0, timeMs: 30_000 }, now, { retention: settings.retention, ratingNeutral: true });
          advanceStage(state, cand, { solved: true, hintsUsed: 0 }, now);
          session.done.push({ cand, solved: true });
          now += 60_000;
          continue;
        }
        decay(hidden, cand.conceptId, now);
        const truth = pSolve(skillAt(hidden, cand.conceptId, now), cand.difficulty);
        const solved = rng() < truth;
        const { p } = applyResult(state, cand, { exerciseId: cand.id, score: solved ? 1 : 0, solved, hintsUsed: 0, timeMs: 30_000 }, now, { retention: settings.retention });
        if (policy === 'adaptive') advanceStage(state, cand, { solved, hintsUsed: 0 }, now);
        practise(hidden, cand.conceptId, now);
        rows.push({ p, solved });
        pSum += truth;
        session.done.push({ cand, solved });
        counts.set(cand.conceptId, (counts.get(cand.conceptId) ?? 0) + 1);
        streak = cand.conceptId === prev ? streak + 1 : 1;
        prev = cand.conceptId;
        maxStreak = Math.max(maxStreak, streak);
        now += 60_000;
      }
      distinctSum += new Set(session.done.map((d) => d.cand.conceptId)).size;
      sessions++;
    }
    const end = t0 + cfg.days * DAY;
    const test = end + cfg.retentionGapDays * DAY;
    for (const id of ids) {
      const err = estimate(state, id, end).theta - skillAt(hidden, id, end);
      sqErr += err * err;
      nErr++;
      if ((state.nodes[id]?.n ?? 0) > 0) {
        sqErrP += err * err;
        nErrP++;
      }
      gainSum += skillAt(hidden, id, end) - hidden.base[id]!;
      const tier = CONCEPTS.find((c) => c.id === id)?.tier ?? 2;
      retSum += pSolve(skillAt(hidden, id, test), TIER_MID[tier]!);
      retN++;
    }
    void predict;
  }
  return {
    policy,
    rmseEstimate: Math.sqrt(sqErr / nErr),
    rmsePractised: nErrP ? Math.sqrt(sqErrP / nErrP) : NaN,
    brier: brier(rows) ?? NaN,
    ece: ece(rows) ?? NaN,
    maxStreak,
    conceptEntropy: entropy(counts, ids.length),
    distinctPerSession: distinctSum / sessions,
    meanGain: gainSum / retN,
    retention: retSum / retN,
    meanP: pSum / Math.max(1, rows.length),
    attempts: rows.length,
  };
}

/** A deterministic multi-domain subset of concepts, ordered by tier (for the fixed curriculum). */
export function pickConcepts(n: number): string[] {
  const byDomain = new Map<string, string[]>();
  for (const c of [...CONCEPTS].sort((a, b) => a.tier - b.tier)) (byDomain.get(c.domain) ?? byDomain.set(c.domain, []).get(c.domain)!).push(c.id);
  const out: string[] = [];
  for (let round = 0; out.length < n; round++) {
    let added = false;
    for (const list of byDomain.values()) {
      const id = list[round];
      if (id && out.length < n) {
        out.push(id);
        added = true;
      }
    }
    if (!added) break;
  }
  return out.sort((a, b) => (CONCEPTS.find((c) => c.id === a)!.tier - CONCEPTS.find((c) => c.id === b)!.tier));
}
