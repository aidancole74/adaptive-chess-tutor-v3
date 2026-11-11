/**
 * Curriculum progression over the prerequisite DAG:
 * locked -> lesson -> supported -> unsupported -> check -> mastered, with decay back to `check`.
 */
import type { Candidate, ExerciseResult } from '../exercises/types';
import type { CurriculumStage, CurriculumState, LearnerState } from '../model/types';
import { basicBlunderRate, estimate, mastery } from '../model/learner';
import { CONCEPTS, CONCEPT_BY_ID, tierOfRating, type ConceptDef } from './concepts';

export const MASTERY_UNLOCK = 0.6;
export const SIGMA_UNLOCK = 190;
export const MASTERY_DECAY = 0.42;
export const PLACE_OUT = 0.86;
export const BLUNDER_GATE = 0.15;
export const STAGE_NEED: Record<CurriculumStage, number> = { locked: 0, lesson: 1, supported: 3, unsupported: 4, check: 5, mastered: 0 };
export const CHECK_PASS = 4;

export function stageOf(state: LearnerState, id: string): CurriculumStage {
  return state.curriculum[id]?.stage ?? 'locked';
}

function setStage(state: LearnerState, id: string, stage: CurriculumStage, now: number): void {
  const prev = state.curriculum[id];
  const next: CurriculumState = {
    stage,
    progress: 0,
    attempts: 0,
    unlockedAt: prev?.unlockedAt ?? (stage === 'locked' ? null : now),
    masteredAt: stage === 'mastered' ? now : (prev?.masteredAt ?? null),
  };
  state.curriculum[id] = next;
}

/** Basic-blunder gate for advanced material. Provisional pass for clearly strong, well-estimated players. */
export function gateOpen(state: LearnerState, now: number): { open: boolean; rate: number | null; n: number; provisional: boolean } {
  const b = basicBlunderRate(state);
  if (b.rate !== null) return { open: b.rate <= BLUNDER_GATE, rate: b.rate, n: b.n, provisional: false };
  const g = estimate(state, '', now);
  const provisional = g.theta - g.sigma >= 1400;
  return { open: provisional, rate: null, n: b.n, provisional };
}

export interface UnlockCheck {
  ok: boolean;
  /** Human-readable blockers for the curriculum map. */
  blockers: string[];
}

export function prereqMet(state: LearnerState, id: string, now: number): boolean {
  if (stageOf(state, id) === 'mastered') return true;
  const m = mastery(state, id, now);
  return m.value >= MASTERY_UNLOCK && m.sigma <= SIGMA_UNLOCK && (state.nodes[id]?.n ?? 0) > 0;
}

export function canUnlock(state: LearnerState, def: ConceptDef, now: number): UnlockCheck {
  const blockers: string[] = [];
  for (const p of def.prereqs) {
    if (p.type !== 'requires') continue;
    if (!prereqMet(state, p.id, now)) blockers.push(`Needs ${CONCEPT_BY_ID.get(p.id)?.name ?? p.id}`);
  }
  const learnerTier = tierOfRating(estimate(state, '', now).theta);
  if (def.tier > learnerTier + 1) blockers.push(`Tier ${def.tier} material; your level is tier ${learnerTier}`);
  if (def.gated && !gateOpen(state, now).open) blockers.push('Basic-blunder gate: keep hanging pieces and mate-in-1 misses under 15%');
  return { ok: blockers.length === 0, blockers };
}

/**
 * Re-evaluate the curriculum: place out of clearly mastered basics, unlock up to `maxNew` new concepts
 * (lowest tier first), and demote mastered concepts whose mastery has decayed.
 * Only concepts in `available` (those with content) are unlocked. Returns what changed.
 */
export function refreshCurriculum(
  state: LearnerState,
  now: number,
  available: ReadonlySet<string>,
  maxNew: number,
): { unlocked: string[]; placedOut: string[]; decayed: string[] } {
  const unlocked: string[] = [];
  const placedOut: string[] = [];
  const decayed: string[] = [];
  const g = estimate(state, '', now);
  const learnerTier = tierOfRating(g.theta);

  for (const def of CONCEPTS) {
    const st = stageOf(state, def.id);
    if (st === 'mastered') {
      if (mastery(state, def.id, now).value < MASTERY_DECAY) {
        setStage(state, def.id, 'check', now);
        decayed.push(def.id);
      }
    }
  }
  // Place out: well below the learner's tier with a confident overall estimate, prerequisites placed too.
  if (state.seeded) {
    for (const def of CONCEPTS) {
      if (stageOf(state, def.id) !== 'locked' || !available.has(def.id)) continue;
      if (def.tier > learnerTier - 1 || g.sigma > 220) continue;
      if (mastery(state, def.id, now).value < PLACE_OUT) continue;
      if (!def.prereqs.every((p) => p.type !== 'requires' || stageOf(state, p.id) === 'mastered' || !available.has(p.id))) continue;
      setStage(state, def.id, 'mastered', now);
      placedOut.push(def.id);
    }
  }
  const inProgress = CONCEPTS.filter((d) => ['lesson', 'supported', 'unsupported'].includes(stageOf(state, d.id))).length;
  const anyActive = CONCEPTS.some((d) => stageOf(state, d.id) !== 'locked');
  // Always keep something to do: with nothing active, open the roots regardless of the per-session limit.
  let budget = anyActive ? Math.max(0, maxNew - Math.max(0, inProgress - 6)) : Math.max(4, maxNew);
  const order = [...CONCEPTS].sort((a, b) => a.tier - b.tier);
  for (const def of order) {
    if (budget <= 0) break;
    if (stageOf(state, def.id) !== 'locked' || !available.has(def.id)) continue;
    // Prerequisites without content cannot block.
    const blockers = canUnlockWith(state, def, now, available);
    if (!blockers.ok) continue;
    setStage(state, def.id, 'lesson', now);
    unlocked.push(def.id);
    budget--;
  }
  return { unlocked, placedOut, decayed };
}

function canUnlockWith(state: LearnerState, def: ConceptDef, now: number, available: ReadonlySet<string>): UnlockCheck {
  const filtered: ConceptDef = { ...def, prereqs: def.prereqs.filter((p) => available.has(p.id)) };
  return canUnlock(state, filtered, now);
}

/** Advance the stage machine after an attempt on a concept. Mutates state. Returns the new stage if it changed. */
export function advanceStage(state: LearnerState, c: Pick<Candidate, 'conceptId' | 'format'>, r: Pick<ExerciseResult, 'solved' | 'hintsUsed'>, now: number): CurriculumStage | null {
  const cur = state.curriculum[c.conceptId];
  if (!cur || cur.stage === 'locked' || cur.stage === 'mastered') return null;
  if (cur.stage === 'lesson') {
    if (c.format !== 'lesson') return null;
    setStage(state, c.conceptId, 'supported', now);
    return 'supported';
  }
  if (c.format === 'lesson') return null;
  cur.attempts++;
  if (cur.stage === 'supported') {
    if (r.solved) cur.progress++;
    if (cur.progress >= STAGE_NEED.supported) {
      setStage(state, c.conceptId, 'unsupported', now);
      return 'unsupported';
    }
    return null;
  }
  if (cur.stage === 'unsupported') {
    if (r.solved && r.hintsUsed === 0) cur.progress++;
    if (cur.progress >= STAGE_NEED.unsupported) {
      setStage(state, c.conceptId, 'check', now);
      return 'check';
    }
    return null;
  }
  // mastery check: STAGE_NEED.check attempts without hints, CHECK_PASS must succeed
  if (r.solved && r.hintsUsed === 0) cur.progress++;
  if (cur.attempts >= STAGE_NEED.check) {
    const next: CurriculumStage = cur.progress >= CHECK_PASS ? 'mastered' : 'unsupported';
    setStage(state, c.conceptId, next, now);
    return next;
  }
  if (cur.progress >= CHECK_PASS) {
    setStage(state, c.conceptId, 'mastered', now);
    return 'mastered';
  }
  return null;
}

/** Concepts the scheduler may draw from. */
export function activeConcepts(state: LearnerState): Map<string, CurriculumStage> {
  const m = new Map<string, CurriculumStage>();
  for (const [id, c] of Object.entries(state.curriculum)) if (c.stage !== 'locked') m.set(id, c.stage);
  return m;
}

/** Validate the DAG: every prerequisite exists, no cycles, prerequisites never sit in a higher tier band by more than one. */
export function validateDag(): string[] {
  const errors: string[] = [];
  const seen = new Map<string, number>();
  const visit = (id: string, stack: string[]): void => {
    if (seen.get(id) === 2) return;
    if (seen.get(id) === 1) {
      errors.push(`cycle: ${[...stack, id].join(' -> ')}`);
      return;
    }
    seen.set(id, 1);
    const def = CONCEPT_BY_ID.get(id);
    if (!def) {
      errors.push(`unknown concept ${id} (from ${stack[stack.length - 1] ?? 'root'})`);
      return;
    }
    for (const p of def.prereqs) {
      const pd = CONCEPT_BY_ID.get(p.id);
      if (pd && p.type === 'requires' && pd.tier > def.tier) errors.push(`${def.id} (tier ${def.tier}) requires higher-tier ${pd.id} (tier ${pd.tier})`);
      visit(p.id, [...stack, id]);
    }
    seen.set(id, 2);
  };
  for (const d of CONCEPTS) visit(d.id, []);
  return errors;
}
