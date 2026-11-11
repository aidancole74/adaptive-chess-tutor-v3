/** Strategy provider: engine-verified quiet positions; also feeds tactic-or-not negatives and blunder-check safe moves. */
import type { Exercise } from '../../exercises/types';
import { buildChoosePlan, buildQuietBestMove, buildWhoIsBetter, quietMoveConcept } from '../../exercises/strategy';
import { CHOOSE_PLAN_CONCEPT, WHO_IS_BETTER_CONCEPT, WHO_IS_BETTER_MIN_CP } from '../strategy';
import { TIER_MID } from '../../curriculum/concepts';
import type { StrategyItem } from '../types';
import { loadShard, packInfo } from '../loader';
import type { Provider } from '../pool';

export interface StrategyProvider extends Provider {
  load(): Promise<StrategyItem[]>;
  items(): StrategyItem[];
}

/**
 * Items are indexed by concept cheaply at load; exercises are built only when sampled.
 * Evaluate-trade is not served: under the bank's 60 cp margin rule no trade can be "good" (DECISIONS #24).
 */
export function createStrategyProvider(onLoaded: (items: StrategyItem[]) => void): StrategyProvider {
  let all: StrategyItem[] = [];
  const byConcept = new Map<string, StrategyItem[]>();
  let loading: Promise<StrategyItem[]> | null = null;

  const add = (c: string, it: StrategyItem): void => {
    (byConcept.get(c) ?? byConcept.set(c, []).get(c)!).push(it);
  };

  const build = (conceptId: string, it: StrategyItem, rng: () => number): Exercise | null => {
    if (conceptId === CHOOSE_PLAN_CONCEPT) return buildChoosePlan(it, rng);
    if (conceptId === WHO_IS_BETTER_CONCEPT) return buildWhoIsBetter(it, rng);
    return buildQuietBestMove(it);
  };

  const p: StrategyProvider = {
    id: 'strategy',
    concepts: () => [...byConcept.keys()],
    sample(conceptId, target, k, rng) {
      const list = byConcept.get(conceptId) ?? [];
      const near = list.filter((it) => Math.abs(TIER_MID[it.tier]! - target) <= 300);
      const src = near.length >= k ? near : list;
      const out: Exercise[] = [];
      for (let i = 0; i < k * 4 && out.length < k && src.length > 0; i++) {
        const ex = build(conceptId, src[Math.floor(rng() * src.length)]!, rng);
        if (ex && ex.verified && !out.some((o) => o.id === ex.id)) out.push(ex);
      }
      return out;
    },
    async ensure() {
      await p.load();
    },
    load() {
      if (all.length > 0) return Promise.resolve(all);
      loading ??= (async () => {
        const info = await packInfo('strategy');
        if (!info) return [];
        const shards = await Promise.all(info.shards.map((s) => loadShard<StrategyItem[]>(info, s.file)));
        all = shards.flatMap((s) => s ?? []).filter((it) => it.verified);
        for (const it of all) {
          add(quietMoveConcept(it), it);
          if (it.otherPlans.length > 0) add(CHOOSE_PLAN_CONCEPT, it);
          if (Math.abs(it.bestCp) >= WHO_IS_BETTER_MIN_CP) add(WHO_IS_BETTER_CONCEPT, it);
        }
        onLoaded(all);
        return all;
      })().finally(() => {
        loading = null;
      });
      return loading;
    },
    items: () => all,
  };
  return p;
}
