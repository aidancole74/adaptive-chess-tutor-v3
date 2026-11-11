/** App state (Zustand): learner model, settings, the active session. Persists to IndexedDB. */
import { create } from 'zustand';
import type { Exercise, ExerciseResult } from '../exercises/types';
import { applyResult, newLearner, seedRating, tagLastCause } from '../model/learner';
import type { LearnerState } from '../model/types';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../model/settings';
import { loadKv, saveKv } from '../model/db';
import { mulberry32 } from '../model/math';
import { activeConcepts, advanceStage, refreshCurriculum } from '../curriculum/progress';
import { conceptName } from '../curriculum/concepts';
import { newSession, pickNext, type SchedPick, type SessionState } from '../scheduler/scheduler';
import type { ErrorCause } from '../exercises/types';
import { getOpenings, getPool } from '../content/registry';
import { prepareProviders } from '../content/context';

export interface ActiveItem {
  pick: SchedPick;
  exercise: Exercise;
  startedAt: number;
}

export interface SessionLogEntry {
  exercise: Exercise;
  why: string;
  result: ExerciseResult;
  stageChange: string | null;
}

interface AppState {
  ready: boolean;
  learner: LearnerState;
  settings: Settings;
  session: SessionState | null;
  current: ActiveItem | null;
  log: SessionLogEntry[];
  notices: string[];
  init(): Promise<void>;
  updateSettings(patch: Partial<Settings>): void;
  replaceAll(learner: LearnerState, settings: Settings): void;
  seed(rating: number, sigma: number): void;
  startSession(): Promise<void>;
  submit(result: ExerciseResult): void;
  next(): void;
  endSession(): void;
  tagCause(exerciseId: string, cause: ErrorCause): void;
  /** Record a result for an exercise outside a session (placement, library, review). */
  recordStandalone(ex: Exercise, result: ExerciseResult): void;
  reset(): void;
}

const rng = mulberry32((Date.now() ^ 0x5eed) >>> 0);
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export const useApp = create<AppState>((set, get) => {
  // Settings are tiny: written at once. The learner is coalesced into one write per task turn.
  const persist = (): void => {
    void saveKv('settings', get().settings).catch(() => undefined);
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveKv('learner', get().learner).catch(() => undefined);
    }, 0);
  };

  const pickInto = (session: SessionState): ActiveItem | null => {
    const { learner, settings } = get();
    const pool = getPool();
    const now = Date.now();
    const pick = pickNext({ state: learner, settings, now, rng, pool, session, active: activeConcepts(learner) });
    if (!pick) return null;
    const exercise = pool.materialize(pick.cand);
    if (!exercise) return null;
    return { pick, exercise, startedAt: now };
  };

  return {
    ready: false,
    learner: newLearner(Date.now()),
    settings: DEFAULT_SETTINGS,
    session: null,
    current: null,
    log: [],
    notices: [],

    async init() {
      try {
        const [l, s] = await Promise.all([loadKv<LearnerState>('learner'), loadKv<Settings>('settings')]);
        set({
          learner: l && l.version === 1 ? l : get().learner,
          settings: sanitizeSettings({ ...DEFAULT_SETTINGS, ...(s ?? {}) }),
        });
      } catch {
        /* storage unavailable: run in memory */
      }
      set({ ready: true });
    },

    updateSettings(patch) {
      set({ settings: sanitizeSettings({ ...get().settings, ...patch }) });
      persist();
    },

    replaceAll(learner, settings) {
      set({ learner, settings: sanitizeSettings(settings), session: null, current: null, log: [] });
      persist();
    },

    seed(rating, sigma) {
      const learner = structuredClone(get().learner);
      seedRating(learner, rating, sigma, Date.now());
      set({ learner });
      persist();
    },

    async startSession() {
      const pool = getPool();
      const { learner } = get();
      const est = learner.nodes.global!.theta;
      getOpenings().setColors(get().settings.openingColor);
      await Promise.all([pool.ensure(est), prepareProviders(learner, get().settings)]);
      const state = structuredClone(learner);
      const now = Date.now();
      const changes = refreshCurriculum(state, now, new Set(pool.concepts()), get().settings.newConceptRate);
      const notices: string[] = [];
      if (changes.placedOut.length) notices.push(`Placed out of ${changes.placedOut.length} concept${changes.placedOut.length === 1 ? '' : 's'} you already know (${changes.placedOut.slice(0, 3).map(conceptName).join(', ')}${changes.placedOut.length > 3 ? ', …' : ''}).`);
      if (changes.unlocked.length) notices.push(`Unlocked: ${changes.unlocked.map(conceptName).join(', ')}.`);
      if (changes.decayed.length) notices.push(`Needs a refresher (mastery faded): ${changes.decayed.map(conceptName).join(', ')}.`);
      set({ learner: state });
      const session = newSession(get().settings, now, rng);
      set({ session, log: [], notices, current: null });
      const current = pickInto(session);
      set({ current });
      if (!current) set({ notices: [...notices, 'No exercises are available yet: content packs may still be loading or every domain is turned off.'] });
      persist();
    },

    submit(result) {
      const { current, session } = get();
      if (!current || !session) return;
      const learner = structuredClone(get().learner);
      const now = Date.now();
      const ex = current.exercise;
      applyResult(learner, ex, result, now, {
        retention: get().settings.retention,
        tc: get().settings.timeControl === 'all' ? undefined : get().settings.timeControl,
        slot: `${current.pick.slot.kind}/${current.pick.slot.category}`,
        sessionId: session.id,
        ratingNeutral: ex.format === 'lesson',
      });
      const stage = advanceStage(learner, ex, result, now);
      const stageChange = stage ? `${conceptName(ex.conceptId)}: ${stage === 'mastered' ? 'mastered' : `now in ${stage === 'check' ? 'mastery check' : `${stage} practice`}`}` : null;
      const done = [...session.done, { cand: ex, solved: result.solved }];
      set({
        learner,
        session: { ...session, done },
        log: [...get().log, { exercise: ex, why: current.pick.why, result, stageChange }],
      });
      persist();
    },

    next() {
      const { session } = get();
      if (!session) return;
      if (session.done.length >= session.slots.length) {
        set({ current: null });
        return;
      }
      set({ current: pickInto(session) });
    },

    endSession() {
      set({ session: null, current: null });
    },

    tagCause(exerciseId, cause) {
      const learner = structuredClone(get().learner);
      tagLastCause(learner, exerciseId, cause);
      set({ learner, log: get().log.map((l) => (l.exercise.id === exerciseId ? { ...l, result: { ...l.result, cause } } : l)) });
      persist();
    },

    recordStandalone(ex, result) {
      const learner = structuredClone(get().learner);
      applyResult(learner, ex, result, Date.now(), { retention: get().settings.retention, slot: 'standalone' });
      set({ learner });
      persist();
    },

    reset() {
      set({ learner: newLearner(Date.now()), settings: DEFAULT_SETTINGS, session: null, current: null, log: [], notices: [] });
      persist();
    },
  };
});
