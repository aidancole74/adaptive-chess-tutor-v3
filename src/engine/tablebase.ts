/**
 * Lichess tablebase client (https://tablebase.lichess.ovh/standard, up to 7 pieces).
 * Isomorphic: used by the browser app for play-outs and by the endgame pipeline in Node.
 *
 * API semantics (confirmed against live responses, see tablebase.test.ts fixtures):
 *  - top-level `category` / `dtm` / `dtz` are from the point of view of the side to move
 *    (positive dtm/dtz = side to move wins);
 *  - every entry of `moves[]` describes the position AFTER the move, i.e. from the OPPONENT's
 *    point of view. This client inverts them so that everything in a TbProbe is from the
 *    MOVER's point of view.
 *
 * The client never throws: failures are reported as a non-ok status.
 */
import type { TbCategory } from '../content/types';
import { pieceCount } from './chessUtil';

export interface TbMove {
  uci: string;
  san: string;
  /** Result for the side that plays the move. */
  category: TbCategory;
  /** False when the raw category was cursed-win / blessed-loss (folded to draw) or maybe-win / maybe-loss. */
  exact: boolean;
  /**
   * Plies to mate counted from the position after the move, signed for the mover:
   * positive = the mover mates, negative = the mover is mated, 0 = this move is checkmate.
   * Null for draws and when the server has no DTM (6-7 pieces).
   */
  dtm: number | null;
  /** DTZ after the move, signed for the mover like `dtm`. Null for draws / unknown. */
  dtz: number | null;
  zeroing: boolean;
  checkmate: boolean;
  stalemate: boolean;
}

export interface TbProbeOk {
  status: 'ok';
  fen: string;
  /** Result for the side to move. */
  category: TbCategory;
  /** False for cursed-win / blessed-loss, which are folded into 'draw' (50-move rule). */
  exact: boolean;
  /** Plies to mate for the side to move (positive = wins, negative = loses). Null for draws / unavailable. */
  dtm: number | null;
  dtz: number | null;
  checkmate: boolean;
  stalemate: boolean;
  insufficientMaterial: boolean;
  /** Legal moves, best first (server order). */
  moves: TbMove[];
}

export interface TbProbeFail {
  status: 'offline' | 'too-many-pieces' | 'error';
  message: string;
}

export type TbProbe = TbProbeOk | TbProbeFail;

/** Async key/value cache for raw API responses, keyed by normalised FEN. */
export interface TbCache {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export interface TablebaseOptions {
  fetchFn?: typeof fetch;
  cache?: TbCache;
  /** Minimum spacing between network requests (default 700 ms, about 1.4 requests/second). */
  minIntervalMs?: number;
  baseUrl?: string;
  /** Retries after HTTP 429 / 5xx (default 2). */
  maxRetries?: number;
  /** Retries after a network-level failure before reporting 'offline' (default 1). */
  networkRetries?: number;
  /** First backoff delay for 5xx and network failures; doubles per attempt (default 1500 ms). */
  backoffMs?: number;
  /** First backoff delay after HTTP 429; doubles per attempt (default 60 s, as Lichess asks). */
  backoff429Ms?: number;
  /** Test hooks. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  isOnline?: () => boolean;
}

export interface Tablebase {
  probe(fen: string): Promise<TbProbe>;
  /** Network requests sent and cache hits so far. */
  stats(): { requests: number; cacheHits: number };
}

export const TB_MAX_PIECES = 7;
export const TB_BASE_URL = 'https://tablebase.lichess.ovh/standard';

export function memoryTbCache(): TbCache {
  const m = new Map<string, unknown>();
  return {
    get: (k) => Promise.resolve(m.get(k)),
    set: (k, v) => {
      m.set(k, v);
      return Promise.resolve();
    },
  };
}

/** Six-field FEN with single spaces; missing trailing fields are defaulted. Used as the cache key. */
export function normaliseFen(fen: string): string {
  const p = fen.trim().split(/[\s_]+/);
  const def = ['', 'w', '-', '-', '0', '1'];
  const out: string[] = [];
  for (let i = 0; i < 6; i++) out.push(p[i] ?? def[i] ?? '');
  return out.join(' ');
}

interface RawMove {
  uci: string;
  san: string;
  category: string;
  dtz?: number | null;
  dtm?: number | null;
  zeroing?: boolean;
  checkmate?: boolean;
  stalemate?: boolean;
}

interface RawProbe {
  category: string;
  dtz?: number | null;
  dtm?: number | null;
  checkmate?: boolean;
  stalemate?: boolean;
  insufficient_material?: boolean;
  moves: RawMove[];
}

function isRawProbe(v: unknown): v is RawProbe {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.category !== 'string' || !Array.isArray(o.moves)) return false;
  return o.moves.every((m: unknown) => {
    if (typeof m !== 'object' || m === null) return false;
    const r = m as Record<string, unknown>;
    return typeof r.uci === 'string' && typeof r.san === 'string' && typeof r.category === 'string';
  });
}

/** Folds a raw API category (already from the wanted point of view). Null = not usable. */
function fold(raw: string): { category: TbCategory; exact: boolean } | null {
  switch (raw) {
    case 'win':
      return { category: 'win', exact: true };
    case 'draw':
      return { category: 'draw', exact: true };
    case 'loss':
      return { category: 'loss', exact: true };
    case 'cursed-win':
    case 'blessed-loss':
      return { category: 'draw', exact: false };
    case 'maybe-win':
      return { category: 'win', exact: false };
    case 'maybe-loss':
      return { category: 'loss', exact: false };
    default:
      return null;
  }
}

const INVERT: Record<string, string> = {
  win: 'loss',
  loss: 'win',
  draw: 'draw',
  'cursed-win': 'blessed-loss',
  'blessed-loss': 'cursed-win',
  'maybe-win': 'maybe-loss',
  'maybe-loss': 'maybe-win',
};

const neg = (n: number | null | undefined): number | null => (n === null || n === undefined ? null : n === 0 ? 0 : -n);

/** Converts a raw API response into a TbProbe (everything from the mover's point of view). */
export function parseTbResponse(fen: string, raw: unknown): TbProbe {
  if (!isRawProbe(raw)) return { status: 'error', message: 'malformed tablebase response' };
  if (raw.category === 'unknown' || raw.category.startsWith('maybe-')) {
    return { status: 'error', message: `tablebase result not decided (${raw.category})` };
  }
  const top = fold(raw.category);
  if (!top) return { status: 'error', message: `unknown tablebase category "${raw.category}"` };
  const moves: TbMove[] = [];
  for (const m of raw.moves) {
    const f = fold(INVERT[m.category] ?? 'unknown');
    if (!f) return { status: 'error', message: `move ${m.uci} has undecided category "${m.category}"` };
    const decisive = f.category !== 'draw';
    moves.push({
      uci: m.uci,
      san: m.san,
      category: f.category,
      exact: f.exact,
      // The server sends dtm=null for a mating move; that is mate in 0 further plies.
      dtm: m.checkmate === true ? 0 : decisive ? neg(m.dtm) : null,
      dtz: decisive ? neg(m.dtz) : null,
      zeroing: m.zeroing === true,
      checkmate: m.checkmate === true,
      stalemate: m.stalemate === true,
    });
  }
  const decisive = top.category !== 'draw';
  return {
    status: 'ok',
    fen,
    category: top.category,
    exact: top.exact,
    dtm: decisive ? (raw.dtm ?? null) : null,
    dtz: decisive ? (raw.dtz ?? null) : null,
    checkmate: raw.checkmate === true,
    stalemate: raw.stalemate === true,
    insufficientMaterial: raw.insufficient_material === true,
    moves,
  };
}

type Fetched = { raw: unknown } | { fail: TbProbeFail };

export function createTablebase(opts: TablebaseOptions = {}): Tablebase {
  const cache = opts.cache ?? memoryTbCache();
  const minInterval = opts.minIntervalMs ?? 700;
  const baseUrl = opts.baseUrl ?? TB_BASE_URL;
  const maxRetries = opts.maxRetries ?? 2;
  const networkRetries = opts.networkRetries ?? 1;
  const backoffMs = opts.backoffMs ?? 1500;
  const backoff429Ms = opts.backoff429Ms ?? 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const isOnline = opts.isOnline ?? (() => !(typeof navigator !== 'undefined' && navigator.onLine === false));
  const counters = { requests: 0, cacheHits: 0 };
  const inflight = new Map<string, Promise<Fetched>>();
  let chain: Promise<unknown> = Promise.resolve();
  let last = Number.NEGATIVE_INFINITY;

  async function cacheGet(key: string): Promise<unknown> {
    try {
      return await cache.get(key);
    } catch {
      return undefined;
    }
  }

  async function fetchRaw(key: string): Promise<Fetched> {
    const fetchFn = opts.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!fetchFn) return { fail: { status: 'offline', message: 'fetch is not available' } };
    const url = `${baseUrl}?fen=${key.replace(/ /g, '_')}`;
    let httpTries = 0;
    let netTries = 0;
    for (;;) {
      if (!isOnline()) return { fail: { status: 'offline', message: 'browser is offline' } };
      const wait = last + minInterval - now();
      if (wait > 0) await sleep(wait);
      last = now();
      counters.requests++;
      let res: Response;
      try {
        res = await fetchFn(url);
      } catch (e) {
        if (netTries++ < networkRetries) {
          await sleep(backoffMs * 2 ** (netTries - 1));
          continue;
        }
        return { fail: { status: 'offline', message: `tablebase unreachable: ${e instanceof Error ? e.message : String(e)}` } };
      }
      if (res.status === 429 || res.status >= 500) {
        if (httpTries++ < maxRetries) {
          await sleep((res.status === 429 ? backoff429Ms : backoffMs) * 2 ** (httpTries - 1));
          continue;
        }
        return { fail: { status: 'error', message: `tablebase HTTP ${res.status}` } };
      }
      if (!res.ok) {
        let body = '';
        try {
          body = (await res.text()).slice(0, 200);
        } catch {
          /* ignore */
        }
        return { fail: { status: 'error', message: `tablebase HTTP ${res.status}${body ? `: ${body}` : ''}` } };
      }
      try {
        const raw: unknown = await res.json();
        if (!isRawProbe(raw)) return { fail: { status: 'error', message: 'malformed tablebase response' } };
        try {
          await cache.set(key, raw);
        } catch {
          /* a failing cache must not break lookups */
        }
        return { raw };
      } catch (e) {
        return { fail: { status: 'error', message: `bad tablebase response: ${e instanceof Error ? e.message : String(e)}` } };
      }
    }
  }

  async function probe(fen: string): Promise<TbProbe> {
    try {
      const key = normaliseFen(fen);
      if (pieceCount(key) > TB_MAX_PIECES) {
        return { status: 'too-many-pieces', message: `tablebase covers at most ${TB_MAX_PIECES} pieces` };
      }
      const hit = await cacheGet(key);
      if (hit !== undefined && hit !== null) {
        counters.cacheHits++;
        return parseTbResponse(key, hit);
      }
      let job = inflight.get(key);
      if (!job) {
        // Serialise: one request at a time, in arrival order.
        job = chain.then(() => fetchRaw(key));
        chain = job.catch(() => undefined);
        inflight.set(key, job);
        void job.finally(() => inflight.delete(key)).catch(() => undefined);
      }
      const got = await job;
      return 'fail' in got ? got.fail : parseTbResponse(key, got.raw);
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  return { probe, stats: () => ({ ...counters }) };
}

const RANK: Record<TbCategory, number> = { win: 2, draw: 1, loss: 0 };

/** Best category any move achieves (equals probe.category for consistent data). Null when there are no moves. */
export function bestCategory(probe: TbProbeOk): TbCategory | null {
  let best: TbCategory | null = null;
  for (const m of probe.moves) if (best === null || RANK[m.category] > RANK[best]) best = m.category;
  return best;
}

/** Moves preserving the best achievable result (for wins: every winning move). */
export function bestMoves(probe: TbProbeOk): TbMove[] {
  const best = bestCategory(probe);
  return best === null ? [] : probe.moves.filter((m) => m.category === best);
}

function extreme(moves: TbMove[], key: (m: TbMove) => number | null): TbMove[] | null {
  let min = Number.POSITIVE_INFINITY;
  for (const m of moves) {
    const v = key(m);
    if (v === null) return null;
    if (v < min) min = v;
  }
  return moves.filter((m) => key(m) === min);
}

/**
 * Subset of bestMoves that is also optimal by distance: fastest mate when winning, longest
 * resistance when losing. Uses DTM, falling back to DTZ when DTM is missing (6-7 pieces);
 * with neither it returns bestMoves unchanged. `by` tells which one was used.
 */
export function optimalMoves(probe: TbProbeOk): { moves: TbMove[]; by: 'dtm' | 'dtz' | 'none' } {
  const best = bestMoves(probe);
  const cat = best[0]?.category;
  if (!cat || cat === 'draw') return { moves: best, by: 'none' };
  // Signed for the mover: a win wants the smallest positive value, a loss the most negative one.
  const byDtm = extreme(best, (m) => m.dtm);
  if (byDtm) return { moves: byDtm, by: 'dtm' };
  const byDtz = extreme(best, (m) => m.dtz);
  if (byDtz) return { moves: byDtz, by: 'dtz' };
  return { moves: best, by: 'none' };
}

/**
 * Opponent reply for play-outs: keeps the best result available and, when lost, resists longest
 * (DTM, fallback DTZ); random among ties. Null when the side to move has no legal move.
 */
export function pickDefence(probe: TbProbeOk, rng: () => number): TbMove | null {
  const { moves } = optimalMoves(probe);
  if (moves.length === 0) return null;
  return moves[Math.min(moves.length - 1, Math.floor(rng() * moves.length))] ?? null;
}
