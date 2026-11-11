/**
 * The app's content pool: a set of domain providers behind the scheduler's `Pool` interface.
 * Providers build full Exercises when sampled; the pool remembers them so the session can show the pick.
 */
import type { Candidate, Exercise } from '../exercises/types';
import type { Pool } from '../scheduler/scheduler';

export interface Provider {
  id: string;
  /** Concept ids this provider currently has verified content for. */
  concepts(): string[];
  sample(conceptId: string, targetDifficulty: number, k: number, rng: () => number): Exercise[];
  byMemoryKey?(key: string): Exercise | null;
  /** Load more content around a rating (lazy shards). Resolves when ready. */
  ensure?(rating: number): Promise<void>;
}

export interface AppPool extends Pool {
  providers: Provider[];
  /** Full exercise for a candidate returned by sample / byMemoryKey / lesson. */
  materialize(c: Candidate): Exercise | null;
  register(ex: Exercise): Exercise;
  setLessonBuilder(fn: (conceptId: string, pool: AppPool) => Exercise | null): void;
  ensure(rating: number): Promise<void>;
}

export function createPool(providers: Provider[]): AppPool {
  const built = new Map<string, Exercise>();
  let lessonBuilder: ((conceptId: string, pool: AppPool) => Exercise | null) | null = null;
  const remember = (ex: Exercise): Exercise => {
    if (built.size > 4000) built.clear();
    built.set(ex.id, ex);
    return ex;
  };
  const pool: AppPool = {
    providers,
    concepts() {
      const s = new Set<string>();
      for (const p of providers) for (const c of p.concepts()) s.add(c);
      return [...s];
    },
    sample(conceptId, target, k, rng) {
      const out: Exercise[] = [];
      for (const p of providers) {
        if (!p.concepts().includes(conceptId)) continue;
        for (const ex of p.sample(conceptId, target, k, rng)) out.push(remember(ex));
      }
      return out;
    },
    byMemoryKey(key) {
      for (const p of providers) {
        const ex = p.byMemoryKey?.(key);
        if (ex) return remember(ex);
      }
      return null;
    },
    lesson(conceptId) {
      const ex = lessonBuilder?.(conceptId, pool) ?? null;
      return ex ? remember(ex) : null;
    },
    materialize: (c) => built.get(c.id) ?? null,
    register: remember,
    setLessonBuilder(fn) {
      lessonBuilder = fn;
    },
    async ensure(rating) {
      await Promise.all(providers.map((p) => p.ensure?.(rating)));
    },
  };
  return pool;
}

/** Items sorted by difficulty with a random pick near a target: shared by providers. */
export function pickNear<T>(sorted: T[], difficultyOf: (t: T) => number, target: number, k: number, rng: () => number, window = 30): T[] {
  if (sorted.length === 0) return [];
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (difficultyOf(sorted[mid]!) < target) lo = mid + 1;
    else hi = mid;
  }
  const from = Math.max(0, lo - window);
  const to = Math.min(sorted.length, lo + window);
  const out: T[] = [];
  const seen = new Set<number>();
  const n = Math.min(k, to - from);
  for (let guard = 0; out.length < n && guard < n * 8; guard++) {
    const i = from + Math.floor(rng() * (to - from));
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(sorted[i]!);
  }
  return out;
}
