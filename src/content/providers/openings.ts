/**
 * Openings provider: repertoire line training (FSRS per move node), traps (engine-confirmed),
 * structure cards (computed features) and deviation drills (book replies after an off-repertoire move).
 */
import { Chess } from 'chess.js';
import type { Exercise } from '../../exercises/types';
import { buildDeviation, buildOpeningLine, buildStructureCard, buildTrapAvoid, buildTrapPunish } from '../../exercises/openings';
import { epdOf, tryMove } from '../../engine/chessUtil';
import { Book, OpeningNames, bandForRating, type OpeningTrap, type StructureCard } from '../openings';
import { buildRepertoireTree, memoryKeyFor, suggestDefaults, type Repertoire, type RepertoireNode } from '../repertoire';
import type { BookBand, BookShard, OpeningNameTuple } from '../types';
import { loadShard, packInfo } from '../loader';
import { pickNear, type Provider } from '../pool';

export interface OpeningsState {
  names: OpeningNames | null;
  book: Book | null;
  band: BookBand | null;
  repertoires: { w: Repertoire | null; b: Repertoire | null };
  trees: { w: RepertoireNode[]; b: RepertoireNode[] };
  traps: OpeningTrap[];
  cards: StructureCard[];
}

export interface OpeningsProvider extends Provider {
  state(): OpeningsState;
  setRepertoire(color: 'w' | 'b', rep: Repertoire): void;
  setColors(colors: 'both' | 'white' | 'black'): void;
  /** Load the book band for a rating (and names/traps/cards once). */
  load(rating: number): Promise<OpeningsState>;
}

const CONCEPT = { w: 'openings/repertoire/white-lines', b: 'openings/repertoire/black-lines' } as const;

export function createOpeningsProvider(loadRepertoires: () => Promise<{ w?: Repertoire; b?: Repertoire } | undefined>): OpeningsProvider {
  const st: OpeningsState = { names: null, book: null, band: null, repertoires: { w: null, b: null }, trees: { w: [], b: [] }, traps: [], cards: [] };
  const shards = new Map<BookBand, BookShard>();
  let colors: 'both' | 'white' | 'black' = 'both';
  let loading: Promise<OpeningsState> | null = null;
  let loadedBand: BookBand | null = null;

  const rebuild = (color: 'w' | 'b'): void => {
    if (!st.book || !st.band || !st.names) return;
    const rep = st.repertoires[color] ?? suggestDefaults(st.book, st.names, st.band, color);
    st.repertoires[color] = rep;
    st.trees[color] = buildRepertoireTree(st.book, st.band, rep).sort((a, b) => a.ply - b.ply);
  };

  const wanted = (): ('w' | 'b')[] => (colors === 'white' ? ['w'] : colors === 'black' ? ['b'] : ['w', 'b']);

  const deviation = (color: 'w' | 'b', rng: () => number): Exercise | null => {
    const { book, band } = st;
    if (!book || !band) return null;
    const tree = st.trees[color];
    if (tree.length === 0) return null;
    const node = tree[Math.floor(rng() * tree.length)]!;
    // After the user's move, the opponent is to move: pick a book move the repertoire does not branch on.
    const chess = new Chess(node.fen);
    if (!tryMove(chess, node.userMove)) return null;
    const oppFen = chess.fen();
    const covered = new Set(tree.filter((n) => n.line.length === node.line.length + 2 && n.line.slice(0, -1).join() === [...node.line, node.userMove].join()).map((n) => n.line[n.line.length - 1]));
    const opp = book.movesAt(band, epdOf(oppFen)).filter((m) => m.freq < 0.05 && m.games >= 20 && !covered.has(m.uci));
    const om = opp[0];
    if (!om) return null;
    const after = new Chess(oppFen);
    if (!tryMove(after, om.uci)) return null;
    const replies = book.movesAt(band, epdOf(after.fen())).filter((m) => m.games >= 15);
    if (replies.length === 0) return null;
    const top = Math.max(...replies.map((r) => r.scorePct));
    const acceptable = replies.filter((r) => r.scorePct >= top - 4 && r.freq >= 0.08).map((r) => r.uci);
    if (acceptable.length === 0) return null;
    return buildDeviation({ fen: oppFen, line: [...node.line, node.userMove], opponentMove: om.uci, bookMoves: replies.map((r) => ({ uci: r.uci, games: r.games, scorePct: r.scorePct })), band }, acceptable);
  };

  const provider: OpeningsProvider = {
    id: 'openings',
    state: () => st,
    concepts() {
      const ids: string[] = [];
      for (const c of wanted()) if (st.trees[c].length > 0) ids.push(CONCEPT[c]);
      if (st.traps.some((t) => t.verified)) ids.push('openings/skills/traps');
      if (st.cards.length) ids.push('openings/skills/structures');
      if (st.trees.w.length || st.trees.b.length) ids.push('openings/skills/deviation');
      return ids;
    },
    sample(conceptId, target, k, rng) {
      const out: Exercise[] = [];
      if (conceptId === CONCEPT.w || conceptId === CONCEPT.b) {
        const color = conceptId === CONCEPT.w ? 'w' : 'b';
        const ex = st.trees[color].map((n) => buildOpeningLine(n, color, { book: st.book ?? undefined, band: st.band ?? undefined }));
        ex.sort((a, b) => a.difficulty - b.difficulty);
        return pickNear(ex, (e) => e.difficulty, target, k, rng, 40);
      }
      if (conceptId === 'openings/skills/traps') {
        for (const t of st.traps.filter((x) => x.verified)) {
          const e = rng() < 0.5 ? buildTrapAvoid(t) : buildTrapPunish(t);
          if (e) out.push(e);
        }
        return out.sort(() => rng() - 0.5).slice(0, k);
      }
      if (conceptId === 'openings/skills/structures') {
        return [...st.cards].sort(() => rng() - 0.5).slice(0, k).map(buildStructureCard);
      }
      if (conceptId === 'openings/skills/deviation') {
        const cols = wanted();
        for (let i = 0; i < k * 4 && out.length < k; i++) {
          const e = deviation(cols[Math.floor(rng() * cols.length)]!, rng);
          if (e && !out.some((o) => o.id === e.id)) out.push(e);
        }
      }
      return out;
    },
    byMemoryKey(key) {
      if (key.startsWith('op:')) {
        for (const c of ['w', 'b'] as const) {
          const n = st.trees[c].find((x) => memoryKeyFor(c, x.epd) === key);
          if (n) return buildOpeningLine(n, c, { book: st.book ?? undefined, band: st.band ?? undefined });
        }
      }
      if (key.startsWith('card:')) {
        const card = st.cards.find((c) => `card:${c.id}` === key);
        if (card) return buildStructureCard(card);
      }
      return null;
    },
    async ensure(rating) {
      await provider.load(rating);
    },
    load(rating) {
      const band = bandForRating(rating);
      if (loadedBand === band && st.book) return Promise.resolve(st);
      loading ??= (async () => {
        try {
          const info = await packInfo('openings');
          if (!info) return st;
          const file = (key: string): string | undefined => info.shards.find((s) => s.key === key)?.file;
          if (!st.names) {
            const n = await loadShard<OpeningNameTuple[]>(info, file('names') ?? 'names.json');
            if (n) st.names = new OpeningNames(n);
            const traps = await loadShard<OpeningTrap[]>(info, file('traps') ?? 'traps.json');
            if (traps) st.traps = traps;
            const cards = await loadShard<StructureCard[]>(info, file('cards') ?? 'cards.json');
            if (cards) st.cards = cards;
            const saved = await loadRepertoires().catch(() => undefined);
            if (saved?.w) st.repertoires.w = saved.w;
            if (saved?.b) st.repertoires.b = saved.b;
          }
          if (!shards.has(band)) {
            const s = await loadShard<BookShard>(info, file(`book:${band}`) ?? `book-${band}.json`);
            if (s) shards.set(band, s);
          }
          st.book = new Book([...shards.values()]);
          st.band = st.book.hasBand(band) ? band : (st.book.bands()[0] ?? null);
          loadedBand = band;
          rebuild('w');
          rebuild('b');
          return st;
        } finally {
          loading = null;
        }
      })();
      return loading;
    },
    setRepertoire(color, rep) {
      st.repertoires[color] = rep;
      rebuild(color);
    },
    setColors(c) {
      colors = c;
    },
  };
  return provider;
}
