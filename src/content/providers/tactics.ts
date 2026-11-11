/** Tactics provider: lazily loads rating-band shards around the learner and serves the four tactics formats. */
import { primaryTacticConcept } from '../../curriculum/concepts';
import type { Exercise } from '../../exercises/types';
import { buildFindDefense, buildSolve, buildSpotMotif, buildTacticOrNot } from '../../exercises/tactics';
import { loadShard, packInfo } from '../loader';
import { pickNear, type Provider } from '../pool';
import { allBandKeys, bandFileForKey, bandKeyForRating, decodeTactic } from '../tactics';
import type { StrategyItem, TacticItem, TacticTuple } from '../types';

const NO_TACTIC = 'tactics/awareness/noTactic';
const DEFENSE = 'tactics/subtle/defensiveMove';

export interface TacticsProvider extends Provider {
  /** Quiet positions from the strategy bank: the "no tactic" half of tactic-or-not. */
  setQuiet(items: StrategyItem[]): void;
  itemCount(): number;
  /** Items for a concept sorted by rating (placement test, lessons, game-review pairing). */
  itemsFor(conceptId: string): TacticItem[];
  all(): TacticItem[];
}

export function createTacticsProvider(): TacticsProvider {
  const byConcept = new Map<string, TacticItem[]>();
  const everything: TacticItem[] = [];
  const loaded = new Set<string>();
  const loading = new Map<string, Promise<void>>();
  let quiet: StrategyItem[] = [];
  let winning: TacticItem[] = [];

  const insert = (items: TacticItem[]): void => {
    const touched = new Set<string>();
    for (const it of items) {
      const concept = primaryTacticConcept(it.themes);
      if (!concept) continue;
      everything.push(it);
      let list = byConcept.get(concept);
      if (!list) byConcept.set(concept, (list = []));
      list.push(it);
      touched.add(concept);
      if (concept !== DEFENSE && (it.themes.includes('defensiveMove') || it.themes.includes('equality'))) {
        let d = byConcept.get(DEFENSE);
        if (!d) byConcept.set(DEFENSE, (d = []));
        d.push(it);
        touched.add(DEFENSE);
      }
      if (it.themes.includes('crushing') || it.themes.includes('mate')) winning.push(it);
    }
    for (const c of touched) byConcept.get(c)!.sort((a, b) => a.rating - b.rating);
    winning = winning.sort((a, b) => a.rating - b.rating);
  };

  const loadBand = (key: string): Promise<void> => {
    if (loaded.has(key)) return Promise.resolve();
    let p = loading.get(key);
    if (!p) {
      p = (async () => {
        const info = await packInfo('tactics');
        const shard = info?.shards.find((s) => s.key === key);
        if (!info || !shard) return;
        const tuples = await loadShard<TacticTuple[]>(info, shard.file ?? bandFileForKey(key));
        if (!tuples) return;
        insert(tuples.map(decodeTactic));
        loaded.add(key);
      })().finally(() => loading.delete(key));
      loading.set(key, p);
    }
    return p;
  };

  return {
    id: 'tactics',
    concepts() {
      const ids = [...byConcept.keys()];
      if (winning.length > 0 && quiet.length > 0) ids.push(NO_TACTIC);
      return ids;
    },
    sample(conceptId, target, k, rng) {
      const out: Exercise[] = [];
      if (conceptId === NO_TACTIC) {
        for (let i = 0; i < k; i++) {
          const ex =
            rng() < 0.5
              ? buildTacticOrNot({ kind: 'quiet', item: quiet[Math.floor(rng() * quiet.length)]! }, rng)
              : buildTacticOrNot({ kind: 'tactic', item: pickNear(winning, (t) => t.rating, target, 1, rng, 60)[0]! }, rng);
          if (ex) out.push(ex);
        }
        return out;
      }
      const list = byConcept.get(conceptId) ?? [];
      for (const it of pickNear(list, (t) => t.rating, target, k, rng)) {
        let ex: Exercise | null = null;
        if (conceptId === DEFENSE) ex = buildFindDefense(it);
        // spot-the-motif is easier than solving, so aim it at a correspondingly harder puzzle
        else if (rng() < 0.22) ex = buildSpotMotif(it, rng);
        out.push(ex ?? buildSolve(it));
      }
      return out;
    },
    async ensure(rating) {
      const keys = allBandKeys();
      const centre = keys.indexOf(bandKeyForRating(rating));
      const want = keys.filter((_, i) => Math.abs(i - centre) <= 2);
      await Promise.all(want.map(loadBand));
    },
    setQuiet(items) {
      quiet = items.filter((q) => q.verified && Math.abs(q.bestCp) <= 150);
    },
    itemCount: () => everything.length,
    itemsFor: (conceptId) => byConcept.get(conceptId) ?? [],
    all: () => everything,
  };
}
