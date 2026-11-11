/** Synthetic content pool for unit tests and `npm run sim`: abstract items, no chess positions. */
import type { Candidate, ExerciseFormat } from '../exercises/types';
import { CONCEPTS, CONCEPT_BY_ID, TIER_MID } from '../curriculum/concepts';
import type { Pool } from './scheduler';

export interface SyntheticOptions {
  concepts?: string[];
  perConcept?: number;
  formats?: ExerciseFormat[];
  seed?: number;
}

export function syntheticCandidate(conceptId: string, i: number, difficulty: number, format: ExerciseFormat, memory = false): Candidate {
  const def = CONCEPT_BY_ID.get(conceptId);
  const domain = def?.domain ?? 'tactics';
  return {
    id: `${format}:${conceptId}#${i}`,
    itemId: `${conceptId}#${i}`,
    domain,
    conceptId,
    format,
    difficulty,
    difficultySource: domain === 'tactics' ? 'lichess' : 'tier-prior',
    sim: { themes: [conceptId.split('/')[2] ?? conceptId, `g${i % 7}`], material: `m${i % 11}`, structure: `s${i % 5}` },
    phase: domain === 'endgames' ? 'endgame' : 'middlegame',
    color: i % 2 === 0 ? 'w' : 'b',
    memoryKey: memory ? `mem:${conceptId}#${i}` : undefined,
    verified: true,
  };
}

/** Items per concept spread from 500 below to 700 above the concept's tier midpoint. */
export function makeSyntheticPool(opts: SyntheticOptions = {}): Pool & { all: Candidate[] } {
  const ids = opts.concepts ?? CONCEPTS.map((c) => c.id);
  const per = opts.perConcept ?? 60;
  const formats = opts.formats ?? ['solve', 'spot-motif'];
  const by = new Map<string, Candidate[]>();
  const byKey = new Map<string, Candidate>();
  const all: Candidate[] = [];
  for (const id of ids) {
    const def = CONCEPT_BY_ID.get(id);
    const mid = TIER_MID[def?.tier ?? 2]!;
    const list: Candidate[] = [];
    for (let i = 0; i < per; i++) {
      const d = mid - 500 + (1200 * i) / Math.max(1, per - 1);
      const c = syntheticCandidate(id, i, d, formats[i % formats.length]!, Boolean(def?.memory) && i % 3 === 0);
      list.push(c);
      all.push(c);
      if (c.memoryKey) byKey.set(c.memoryKey, c);
    }
    by.set(id, list);
  }
  return {
    all,
    concepts: () => ids,
    sample(conceptId, target, k, rng) {
      const list = by.get(conceptId) ?? [];
      if (list.length === 0) return [];
      // nearest by difficulty with jitter so repeated calls differ
      const scored = list.map((c) => ({ c, d: Math.abs(c.difficulty - target) + rng() * 120 }));
      scored.sort((a, b) => a.d - b.d);
      return scored.slice(0, k).map((s) => s.c);
    },
    byMemoryKey: (key) => byKey.get(key) ?? null,
    lesson(conceptId) {
      const c = syntheticCandidate(conceptId, -1, 0, 'lesson');
      return { ...c, id: `lesson:${conceptId}`, itemId: `lesson:${conceptId}`, difficultySource: 'tier-prior' };
    },
  };
}
