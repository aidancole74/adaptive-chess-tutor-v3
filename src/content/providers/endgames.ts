/** Endgames provider: tablebase-verified items per concept; best move, win-or-draw and play-out formats. */
import type { Exercise } from '../../exercises/types';
import { buildEgBestMove, buildEgPlayout, buildEgWinOrDraw } from '../../exercises/endgames';
import type { EndgameItem } from '../types';
import { loadShard, packInfo } from '../loader';
import type { Provider } from '../pool';

export interface EndgamesProvider extends Provider {
  load(): Promise<EndgameItem[]>;
  items(): EndgameItem[];
}

export function createEndgamesProvider(): EndgamesProvider {
  let all: EndgameItem[] = [];
  const by = new Map<string, EndgameItem[]>();
  let loading: Promise<EndgameItem[]> | null = null;
  const fromId = new Map<string, EndgameItem>();

  const build = (it: EndgameItem, rng: () => number): Exercise | null => {
    const r = rng();
    if (r < 0.2) return buildEgWinOrDraw(it, rng);
    if (r < 0.4 && it.playoutTarget !== null) return buildEgPlayout(it, rng);
    return buildEgBestMove(it, rng);
  };

  const p: EndgamesProvider = {
    id: 'endgames',
    concepts: () => [...by.keys()],
    sample(conceptId, target, k, rng) {
      const list = by.get(conceptId) ?? [];
      const out: Exercise[] = [];
      // Generated content: all items of a concept share a tier prior, so sample uniformly.
      for (let i = 0; i < k * 3 && out.length < k && list.length > 0; i++) {
        const ex = build(list[Math.floor(rng() * list.length)]!, rng);
        if (ex && !out.some((o) => o.id === ex.id)) out.push(ex);
      }
      void target;
      return out;
    },
    byMemoryKey(key) {
      const it = fromId.get(key.replace(/^eg:/, ''));
      return it ? buildEgBestMove(it) : null;
    },
    async ensure() {
      await p.load();
    },
    load() {
      if (all.length > 0) return Promise.resolve(all);
      loading ??= (async () => {
        const info = await packInfo('endgames');
        if (!info) return [];
        const shards = await Promise.all(info.shards.map((s) => loadShard<EndgameItem[]>(info, s.file)));
        all = shards.flatMap((s) => s ?? []).filter((it) => it.verified);
        for (const it of all) {
          (by.get(it.concept) ?? by.set(it.concept, []).get(it.concept)!).push(it);
          fromId.set(it.id, it);
        }
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
