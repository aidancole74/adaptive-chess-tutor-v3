/**
 * Adaptive scheduler. Pure: all state, time and randomness are passed in.
 *
 * score = band closeness + category fit (Thompson-sampled weakness / review due / exploration)
 *       + uncertainty bonus + spaced-repetition due bonus + goal weighting + domain weight
 *       - variety * (recency + similarity)
 *
 * Hard constraints: no concept more than twice in the last five; at least four distinct concepts
 * and two formats per session (when the pool allows); sessions follow warm-up / core / challenge / cool-down.
 */
import type { Domain } from '../content/types';
import type { Candidate } from '../exercises/types';
import { CONCEPT_BY_ID, conceptName, tierOfRating } from '../curriculum/concepts';
import type { CurriculumStage, LearnerState } from '../model/types';
import type { Settings } from '../model/settings';
import { estimate, predict, sampleGap, weakness } from '../model/learner';
import { recallNow } from '../model/fsrs';
import { DAY, SIGMA_INIT, clamp, difficultyForP } from '../model/math';

export type SlotKind = 'warmup' | 'core' | 'challenge' | 'cooldown';
export type Category = 'weakness' | 'review' | 'explore';

export interface Slot {
  kind: SlotKind;
  category: Category;
}

export interface DoneItem {
  cand: Candidate;
  solved: boolean;
}

export interface SessionState {
  id: string;
  startedAt: number;
  slots: Slot[];
  done: DoneItem[];
}

/** Content source. Providers return lightweight candidates near a target difficulty. */
export interface Pool {
  concepts(): string[];
  sample(conceptId: string, targetDifficulty: number, k: number, rng: () => number): Candidate[];
  /** Candidate for a memorised item by key, if the pool can rebuild it (due reviews). */
  byMemoryKey?(key: string): Candidate | null;
  /** Lesson card for a concept in the `lesson` stage. */
  lesson?(conceptId: string): Candidate | null;
}

export interface PickContext {
  state: LearnerState;
  settings: Settings;
  now: number;
  rng: () => number;
  pool: Pool;
  session: SessionState;
  /** Concepts the curriculum allows, with their stage. */
  active: ReadonlyMap<string, CurriculumStage>;
}

export interface ScoreParts {
  band: number;
  category: number;
  weakness: number;
  uncertainty: number;
  due: number;
  goal: number;
  domain: number;
  recency: number;
  similarity: number;
}

export interface SchedPick {
  cand: Candidate;
  slot: Slot;
  p: number;
  score: number;
  parts: ScoreParts;
  why: string;
  stage: CurriculumStage;
  /** True when a hard constraint had to be relaxed because the pool was too small. */
  relaxed: boolean;
}

export const WEIGHTS = { band: 1.0, category: 0.8, weakness: 0.3, uncertainty: 0.25, due: 0.7, goal: 0.3, domain: 0.5, recency: 0.5, similarity: 0.6 };

const SLOT_COUNT: Record<number, number> = { 5: 5, 10: 9, 20: 16, 40: 30 };
export const MIN_DISTINCT_CONCEPTS = 4;
export const MIN_FORMATS = 2;

/* ---------- session template ---------- */

export function slotCount(minutes: number): number {
  return SLOT_COUNT[minutes] ?? Math.max(4, Math.round(minutes * 0.8));
}

/** Largest-remainder apportionment of n slots to the focus mix. */
export function mixCounts(n: number, s: Pick3): Record<Category, number> {
  const total = s.mixWeakness + s.mixReview + s.mixExplore || 1;
  const raw: [Category, number][] = [
    ['weakness', (n * s.mixWeakness) / total],
    ['review', (n * s.mixReview) / total],
    ['explore', (n * s.mixExplore) / total],
  ];
  const out: Record<Category, number> = { weakness: 0, review: 0, explore: 0 };
  let used = 0;
  for (const [c, r] of raw) {
    out[c] = Math.floor(r);
    used += out[c];
  }
  const rest = [...raw].sort((a, b) => (b[1] % 1) - (a[1] % 1));
  for (let i = 0; used < n; i++, used++) out[rest[i % 3]![0]]++;
  return out;
}
type Pick3 = { mixWeakness: number; mixReview: number; mixExplore: number };

/** Template: warm-up (easy) -> core -> challenge -> cool-down (success). Categories follow the focus mix. */
export function planSlots(settings: Settings, rng: () => number): Slot[] {
  const n = slotCount(settings.sessionMinutes);
  const warm = Math.max(1, Math.round(n * 0.15));
  const cool = Math.max(1, Math.round(n * 0.1));
  const chal = Math.max(1, Math.round(n * 0.15));
  const core = Math.max(1, n - warm - cool - chal);
  const kinds: SlotKind[] = [
    ...Array<SlotKind>(warm).fill('warmup'),
    ...Array<SlotKind>(core).fill('core'),
    ...Array<SlotKind>(chal).fill('challenge'),
    ...Array<SlotKind>(cool).fill('cooldown'),
  ];
  const counts = mixCounts(kinds.length, settings);
  const take = (prefs: Category[]): Category => {
    for (const c of prefs) {
      if (counts[c] > 0) {
        counts[c]--;
        return c;
      }
    }
    return 'weakness';
  };
  const slots: Slot[] = kinds.map((kind) => ({ kind, category: 'weakness' as Category }));
  // Easy slots prefer review / strengths; the challenge prefers weaknesses.
  for (const s of slots) if (s.kind === 'warmup') s.category = take(['review', 'explore', 'weakness']);
  for (const s of slots) if (s.kind === 'cooldown') s.category = take(['explore', 'review', 'weakness']);
  for (const s of slots) if (s.kind === 'challenge') s.category = take(['weakness', 'explore', 'review']);
  const coreSlots = slots.filter((s) => s.kind === 'core');
  const bag: Category[] = [];
  for (const c of ['weakness', 'review', 'explore'] as Category[]) for (let i = 0; i < counts[c]; i++) bag.push(c);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  coreSlots.forEach((s, i) => (s.category = bag[i] ?? 'weakness'));
  return slots;
}

export function newSession(settings: Settings, now: number, rng: () => number): SessionState {
  return { id: `s${now.toString(36)}${Math.floor(rng() * 1e6).toString(36)}`, startedAt: now, slots: planSlots(settings, rng), done: [] };
}

/** Target success band for a slot. Supported practice is eased; mastery checks use the core band. */
export function bandFor(slot: Slot, settings: Settings, stage: CurriculumStage = 'unsupported'): [number, number] {
  let lo = settings.bandLow;
  let hi = settings.bandHigh;
  if (slot.kind === 'warmup' || slot.kind === 'cooldown') {
    lo = Math.max(lo + 0.1, 0.85);
    hi = Math.max(hi + 0.1, 0.95);
  } else if (slot.kind === 'challenge') {
    lo = Math.max(0.4, lo - 0.18);
    hi = Math.max(0.5, hi - 0.18);
  }
  if (stage === 'supported') {
    lo = Math.min(0.9, lo + 0.06);
    hi = Math.min(0.97, hi + 0.06);
  }
  return [lo, hi];
}

/* ---------- scoring ---------- */

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const x of a) if (sb.has(x)) inter++;
  return inter / (a.length + b.length - inter);
}

/** Similarity of two candidates in 0..1: theme set, material signature, pawn structure, source game. */
export function similarity(a: Candidate, b: Candidate): number {
  let s = 0.45 * jaccard(a.sim.themes, b.sim.themes);
  if (a.sim.material && a.sim.material === b.sim.material) s += 0.2;
  if (a.sim.structure && a.sim.structure !== 'other' && a.sim.structure === b.sim.structure) s += 0.15;
  if (a.sim.sourceGame && a.sim.sourceGame === b.sim.sourceGame) s += 0.5;
  if (a.conceptId === b.conceptId) s += 0.2;
  return Math.min(1, s);
}

function bandCloseness(p: number, band: [number, number]): number {
  if (p >= band[0] && p <= band[1]) return 1;
  const dist = p < band[0] ? band[0] - p : p - band[1];
  return Math.max(-1, 1 - dist / 0.25);
}

function domainWeight(settings: Settings, d: Domain): number {
  const max = Math.max(...Object.values(settings.domainWeight), 0.01);
  return clamp(settings.domainWeight[d] / max, 0.02, 1);
}

interface ConceptScore {
  id: string;
  stage: CurriculumStage;
  category: number;
  weakness: number;
  uncertainty: number;
  goal: number;
  domain: number;
  total: number;
}

function conceptScore(ctx: PickContext, id: string, stage: CurriculumStage, slot: Slot): ConceptScore {
  const { state, settings, now, rng } = ctx;
  const def = CONCEPT_BY_ID.get(id);
  const est = estimate(state, id, now);
  // Thompson sample of the gap, damped toward its mean and weighted by evidence: a weakness needs
  // opportunities behind it. Untested concepts are the explore category's job, not noise in this one.
  const meanGap = weakness(state, id, now).gap;
  const gapSample = meanGap + 0.6 * (sampleGap(state, id, now, rng) - meanGap);
  const weak = clamp(gapSample / 200, -1.5, 1.5) * (est.n / (est.n + 2));
  const uncertainty = clamp(est.sigma / SIGMA_INIT, 0, 1.2);
  const last = state.nodes[id]?.lastSeen ?? null;
  const daysSince = last === null ? 30 : (now - last) / DAY;
  let category: number;
  if (slot.category === 'weakness') category = weak;
  else if (slot.category === 'review') category = clamp(daysSince / 10, 0, 1.2) + (stage === 'mastered' || stage === 'check' ? 0.3 : 0);
  else category = Math.max(uncertainty, -weak) + (est.n === 0 ? 0.3 : 0);
  // In-progress concepts keep momentum so lesson -> practice -> check actually completes.
  if (stage === 'supported' || stage === 'unsupported' || stage === 'check') category += 0.25;

  let goal = 0;
  if (settings.goalRating) {
    const g = estimate(state, '', now).theta;
    const need = clamp((settings.goalRating - g) / 400, 0, 1);
    const lt = tierOfRating(g);
    const gt = tierOfRating(settings.goalRating);
    const tier = def?.tier ?? lt;
    goal = need * (tier >= lt && tier <= gt ? 1 : 0.2) + need * 0.5 * Math.max(0, weak);
    if (settings.goalDate) {
      const days = (Date.parse(settings.goalDate) - now) / DAY;
      if (Number.isFinite(days) && days > 0 && days < 60) goal *= 1.3;
    }
  }
  const domain = Math.log(domainWeight(settings, (def?.domain ?? id.split('/')[0]) as Domain) * (def?.memory ? 0.6 + 0.8 * settings.depth : 1));
  const total = WEIGHTS.category * category + WEIGHTS.weakness * weak + WEIGHTS.uncertainty * uncertainty + WEIGHTS.goal * goal + WEIGHTS.domain * domain;
  return { id, stage, category, weakness: weak, uncertainty, goal, domain, total };
}

function recentCount(done: DoneItem[], conceptId: string, window: number): number {
  let n = 0;
  for (const d of done.slice(-window)) if (d.cand.conceptId === conceptId) n++;
  return n;
}

/** Concepts barred by "no concept more than twice in the last five". */
export function blockedConcepts(done: DoneItem[]): Set<string> {
  const out = new Set<string>();
  // The next pick joins the last four in a window of five.
  const counts = new Map<string, number>();
  for (const d of done.slice(-4)) counts.set(d.cand.conceptId, (counts.get(d.cand.conceptId) ?? 0) + 1);
  for (const [id, n] of counts) if (n >= 2) out.add(id);
  return out;
}

function dueBonus(ctx: PickContext, c: Candidate): number {
  if (!c.memoryKey) return 0;
  const m = ctx.state.memory[c.memoryKey];
  if (!m) return 0.25; // new memory item: mild pull so lines get introduced
  const r = recallNow(m, ctx.now);
  const target = ctx.settings.retention;
  if (r > target) return -0.6 * ((r - target) / (1 - target + 1e-6)); // not due: reviewing now wastes the repetition
  return clamp((target - r) / 0.25, 0, 1.2) + 0.3;
}

function scoreCandidate(ctx: PickContext, c: Candidate, cs: ConceptScore, slot: Slot, band: [number, number]): { score: number; parts: ScoreParts; p: number } {
  const { state, settings, now, session } = ctx;
  const p = predict(state, c, now, settings.timeControl === 'all' ? undefined : settings.timeControl);
  let recency = 0;
  for (let i = state.history.length - 1, k = 0; i >= 0 && k < 400; i--, k++) {
    const h = state.history[i]!;
    if (h.itemId === c.itemId) {
      const days = (now - h.t) / DAY;
      const memDue = c.memoryKey !== undefined;
      recency += memDue ? 0 : days < 30 ? 1.5 : 0.4;
      break;
    }
  }
  recency += 0.3 * recentCount(session.done, c.conceptId, 2);
  let sim = 0;
  const recent = session.done.slice(-5);
  for (let i = 0; i < recent.length; i++) {
    const decay = Math.pow(0.8, recent.length - 1 - i);
    sim = Math.max(sim, decay * similarity(c, recent[i]!.cand));
  }
  const parts: ScoreParts = {
    band: bandCloseness(p, band),
    category: cs.category,
    weakness: cs.weakness,
    uncertainty: cs.uncertainty,
    due: dueBonus(ctx, c),
    goal: cs.goal,
    domain: cs.domain,
    recency,
    similarity: sim,
  };
  const score =
    WEIGHTS.band * parts.band +
    WEIGHTS.category * parts.category +
    WEIGHTS.weakness * parts.weakness +
    WEIGHTS.uncertainty * parts.uncertainty +
    WEIGHTS.due * parts.due +
    WEIGHTS.goal * parts.goal +
    WEIGHTS.domain * parts.domain -
    settings.varietyStrength * (WEIGHTS.recency * parts.recency + WEIGHTS.similarity * parts.similarity);
  return { score, parts, p };
}

/* ---------- picking ---------- */

/** Memory items whose recall has fallen to the retention target, most overdue first. */
export function dueMemoryKeys(state: LearnerState, now: number, retention: number, limit = 50): string[] {
  const due: [string, number][] = [];
  for (const [key, m] of Object.entries(state.memory)) {
    const r = recallNow(m, now);
    if (r <= retention) due.push([key, r]);
  }
  due.sort((a, b) => a[1] - b[1]);
  return due.slice(0, limit).map((d) => d[0]);
}

export function pickNext(ctx: PickContext): SchedPick | null {
  const { session, settings, pool, state, now, rng } = ctx;
  const index = session.done.length;
  const slot = session.slots[index] ?? session.slots[session.slots.length - 1];
  if (!slot) return null;
  const remaining = Math.max(1, session.slots.length - index);

  const withContent = new Set(pool.concepts());
  const eligible: [string, CurriculumStage][] = [];
  for (const [id, stage] of ctx.active) {
    if (!withContent.has(id)) continue;
    const domain = (CONCEPT_BY_ID.get(id)?.domain ?? id.split('/')[0]) as Domain;
    if (!settings.domainEnabled[domain]) continue;
    eligible.push([id, stage]);
  }
  if (eligible.length === 0) return null;

  const usedConcepts = new Set(session.done.map((d) => d.cand.conceptId));
  const usedFormats = new Set(session.done.map((d) => d.cand.format));
  const blocked = blockedConcepts(session.done);
  const needDistinct = Math.max(0, Math.min(MIN_DISTINCT_CONCEPTS, session.slots.length) - usedConcepts.size);
  const needFormats = Math.max(0, Math.min(MIN_FORMATS, session.slots.length) - usedFormats.size);
  const forceNewConcept = needDistinct >= remaining;
  const forceNewFormat = needFormats >= remaining;

  const attempt = (relaxLevel: number): SchedPick | null => {
    let concepts = eligible.filter(([id]) => relaxLevel >= 2 || !blocked.has(id));
    if (forceNewConcept && relaxLevel < 1) concepts = concepts.filter(([id]) => !usedConcepts.has(id));
    if (concepts.length === 0) return null;

    // Lessons first: a concept in the lesson stage is introduced before it is practised (core slots only).
    // Normally in core slots and within the new-concept rate; but when too few concepts are practisable
    // (a new learner), lessons are what keeps the session going, in any slot.
    const practisableCount = concepts.filter(([, st]) => st !== 'lesson').length;
    // Interleave: while starved, a lesson is allowed when nothing else is practisable or the last pick was practice.
    const lastWasLesson = session.done[session.done.length - 1]?.cand.format === 'lesson';
    const starved = practisableCount < Math.min(MIN_DISTINCT_CONCEPTS, remaining + usedConcepts.size) && (practisableCount === 0 || !lastWasLesson);
    if ((slot.kind === 'core' || starved) && pool.lesson) {
      const lessonConcept = concepts.find(([id, st]) => st === 'lesson' && !usedConcepts.has(id));
      const lessonsThisSession = session.done.filter((d) => d.cand.format === 'lesson').length;
      if (lessonConcept && (lessonsThisSession < Math.max(1, settings.newConceptRate) || starved)) {
        const cand = pool.lesson(lessonConcept[0]);
        if (cand && (starved || !(forceNewFormat && usedFormats.has('lesson')))) {
          return {
            cand,
            slot,
            p: 1,
            score: 0,
            parts: { band: 0, category: 0, weakness: 0, uncertainty: 0, due: 0, goal: 0, domain: 0, recency: 0, similarity: 0 },
            why: `New concept: ${conceptName(cand.conceptId)} is now unlocked. Lesson card first, then supported practice.`,
            stage: 'lesson',
            relaxed: relaxLevel > 0,
          };
        }
      }
    }
    const practisable = concepts.filter(([, st]) => st !== 'lesson');
    if (practisable.length === 0) return null;
    const scored = practisable.map(([id, st]) => conceptScore(ctx, id, st, slot)).sort((a, b) => b.total - a.total);
    const short = scored.slice(0, 10);
    let best: SchedPick | null = null;
    const consider = (c: Candidate, cs: ConceptScore): void => {
      if (!c.verified) return;
      if (forceNewFormat && relaxLevel < 1 && usedFormats.has(c.format)) return;
      if (session.done.some((d) => d.cand.itemId === c.itemId)) return;
      const band = bandFor(slot, settings, cs.stage);
      const s = scoreCandidate(ctx, c, cs, slot, band);
      if (!best || s.score > best.score) {
        best = { cand: c, slot, p: s.p, score: s.score, parts: s.parts, why: '', stage: cs.stage, relaxed: relaxLevel > 0 };
      }
    };
    for (const cs of short) {
      const band = bandFor(slot, settings, cs.stage);
      const est = estimate(state, cs.id, now);
      const target = difficultyForP(est.theta, (band[0] + band[1]) / 2);
      for (const c of pool.sample(cs.id, target, 6, rng)) consider(c, cs);
    }
    // Due reviews compete in every slot; they dominate review slots through the due bonus.
    if (pool.byMemoryKey) {
      for (const key of dueMemoryKeys(state, now, settings.retention, slot.category === 'review' ? 12 : 4)) {
        const c = pool.byMemoryKey(key);
        if (!c) continue;
        const st = ctx.active.get(c.conceptId);
        if (!st || st === 'lesson' || (relaxLevel < 2 && blocked.has(c.conceptId))) continue;
        if (forceNewConcept && relaxLevel < 1 && usedConcepts.has(c.conceptId)) continue;
        const domain = (CONCEPT_BY_ID.get(c.conceptId)?.domain ?? c.domain) as Domain;
        if (!settings.domainEnabled[domain]) continue;
        consider(c, conceptScore(ctx, c.conceptId, st, slot));
      }
    }
    if (best) (best as SchedPick).why = explain(ctx, best as SchedPick);
    return best;
  };
  return attempt(0) ?? attempt(1) ?? attempt(2);
}

/* ---------- explanation ---------- */

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** One-line reason derived from model state and the dominant score parts. */
export function explain(ctx: PickContext, pick: SchedPick): string {
  const { state, now, settings } = ctx;
  const c = pick.cand;
  const name = conceptName(c.conceptId);
  const w = weakness(state, c.conceptId, now);
  const est = estimate(state, c.conceptId, now);
  const lead: string[] = [];
  const mem = c.memoryKey ? state.memory[c.memoryKey] : undefined;
  if (mem && pick.parts.due > 0.3) {
    const days = Math.max(0, Math.round((now - mem.lastReview) / DAY));
    lead.push(`Review due: last seen ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} ago`}, estimated recall ${pct(recallNow(mem, now))} (target ${pct(settings.retention)})`);
  } else if (pick.stage === 'check') {
    lead.push(`Mastery check for ${name}: no hints`);
  } else if (pick.stage === 'supported') {
    lead.push(`Supported practice for the new concept ${name}`);
  } else if (pick.slot.kind === 'warmup') {
    lead.push(`Warm-up on ${name}`);
  } else if (pick.slot.kind === 'cooldown') {
    lead.push(`Cool-down on ${name}: finish on something you should get`);
  } else if (pick.slot.category === 'weakness' && w.n >= 3 && w.gap > 25) {
    lead.push(`Weakness: ${name} is about ${Math.round(w.gap)} points below your overall level (${pct(w.rate ?? 0)} solved over ${w.n} tries)`);
  } else if (est.n < 3) {
    lead.push(`Exploring ${name}: only ${est.n} attempt${est.n === 1 ? '' : 's'} so far, so the estimate is uncertain (±${Math.round(est.sigma)})`);
  } else if (pick.slot.category === 'review') {
    const last = state.nodes[c.conceptId]?.lastSeen;
    const days = last ? Math.round((now - last) / DAY) : null;
    lead.push(days !== null && days >= 1 ? `Review: ${name} not practised for ${days} day${days === 1 ? '' : 's'}` : `Review of ${name}`);
  } else if (pick.slot.category === 'explore' && w.gap < -25) {
    lead.push(`Strength maintenance: ${name} is about ${Math.round(-w.gap)} points above your overall level`);
  } else if (pick.slot.kind === 'challenge') {
    lead.push(`Challenge on ${name}`);
  } else {
    lead.push(`${name} at your level`);
  }
  if (pick.slot.kind === 'challenge' && !lead[0]!.startsWith('Challenge')) lead.push('challenge slot, deliberately harder');
  if (pick.parts.goal > 0.5 && settings.goalRating) lead.push(`counts toward your ${settings.goalRating} goal`);
  const band = bandFor(pick.slot, settings, pick.stage);
  const tail = `Predicted success ${pct(pick.p)} (target ${pct(band[0])}-${pct(band[1])}).`;
  const relaxed = pick.relaxed ? ' Variety rule relaxed: not enough other material available.' : '';
  return `${lead.join('; ')}. ${tail}${relaxed}`;
}

/** Session-level constraint audit, used by tests, the simulator and the session summary. */
export function auditSession(done: DoneItem[]): { distinctConcepts: number; formats: number; maxInWindow: number; maxStreak: number } {
  let maxInWindow = 0;
  let maxStreak = 0;
  let streak = 0;
  for (let i = 0; i < done.length; i++) {
    const id = done[i]!.cand.conceptId;
    streak = i > 0 && done[i - 1]!.cand.conceptId === id ? streak + 1 : 1;
    maxStreak = Math.max(maxStreak, streak);
    const win = done.slice(Math.max(0, i - 4), i + 1);
    maxInWindow = Math.max(maxInWindow, win.filter((d) => d.cand.conceptId === id).length);
  }
  return {
    distinctConcepts: new Set(done.map((d) => d.cand.conceptId)).size,
    formats: new Set(done.map((d) => d.cand.format)).size,
    maxInWindow,
    maxStreak,
  };
}
