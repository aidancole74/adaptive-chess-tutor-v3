/**
 * Fixtures below are REAL responses captured from https://tablebase.lichess.ovh/standard on 2026-11-10
 * during development (fields the client does not read - variant_win, variant_loss, dtw, dtc,
 * conversion, precise_dtz - were dropped; `mate1` and `eight` keep only a subset of the move list).
 * They document the API semantics the client relies on:
 *  - top-level category/dtm are for the side to move (kpkWin: win, dtm 21);
 *  - move entries are for the opponent after the move (best move Kd6: "loss", dtm -20);
 *  - a mating move has checkmate=true and dtm=null (mate1);
 *  - draws carry dtm 0 / dtz 0; more than 7 pieces answers 200 with category "unknown" (eight).
 */
import { describe, expect, it } from 'vitest';
import { bestCategory, bestMoves, createTablebase, memoryTbCache, normaliseFen, optimalMoves, parseTbResponse, pickDefence, type TbProbeOk } from './tablebase';

const FX = {
  kpkWin: {
    fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: 3, dtm: 21, category: 'win',
      moves: [
        { uci: 'e6d6', san: 'Kd6', zeroing: false, checkmate: false, stalemate: false, dtz: -2, dtm: -20, category: 'loss' },
        { uci: 'e6f6', san: 'Kf6', zeroing: false, checkmate: false, stalemate: false, dtz: -2, dtm: -22, category: 'loss' },
        { uci: 'e6d5', san: 'Kd5', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'e6f5', san: 'Kf5', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
      ],
    },
  },
  kpkB: {
    fen: '4k3/8/8/4P3/4K3/8/8/8 b - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: 0, dtm: 0, category: 'draw',
      moves: [
        { uci: 'e8d7', san: 'Kd7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'e8e7', san: 'Ke7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'e8f7', san: 'Kf7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'e8d8', san: 'Kd8', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'e8f8', san: 'Kf8', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
      ],
    },
  },
  krkLoss: {
    fen: '1k6/8/1K6/8/8/8/8/7R b - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: -4, dtm: -4, category: 'loss',
      moves: [
        { uci: 'b8c8', san: 'Kc8', zeroing: false, checkmate: false, stalemate: false, dtz: 3, dtm: 3, category: 'win' },
        { uci: 'b8a8', san: 'Ka8', zeroing: false, checkmate: false, stalemate: false, dtz: 1, dtm: 1, category: 'win' },
      ],
    },
  },
  mate1: {
    fen: 'k7/8/1K6/8/8/8/8/7R w - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: 1, dtm: 1, category: 'win',
      moves: [
        { uci: 'h1h8', san: 'Rh8#', zeroing: false, checkmate: true, stalemate: false, dtz: -1, dtm: null, category: 'loss' },
        { uci: 'h1d1', san: 'Rd1', zeroing: false, checkmate: false, stalemate: false, dtz: -2, dtm: -2, category: 'loss' },
        { uci: 'h1e1', san: 'Re1', zeroing: false, checkmate: false, stalemate: false, dtz: -2, dtm: -2, category: 'loss' },
        { uci: 'b6a5', san: 'Ka5', zeroing: false, checkmate: false, stalemate: false, dtz: -10, dtm: -10, category: 'loss' },
        { uci: 'b6c5', san: 'Kc5', zeroing: false, checkmate: false, stalemate: false, dtz: -10, dtm: -10, category: 'loss' },
      ],
    },
  },
  stalemate: {
    fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1',
    raw: {
      checkmate: false, stalemate: true, insufficient_material: false, dtz: 0, dtm: 0, category: 'draw',
      moves: [
      ],
    },
  },
  eight: {
    fen: '4k3/pppp4/8/8/8/8/PPP5/4K3 w - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: null, dtm: null, category: 'unknown',
      moves: [
        { uci: 'a2a3', san: 'a3', zeroing: true, checkmate: false, stalemate: false, dtz: null, dtm: null, category: 'unknown' },
        { uci: 'b2b3', san: 'b3', zeroing: true, checkmate: false, stalemate: false, dtz: null, dtm: null, category: 'unknown' },
      ],
    },
  },
  cursed: {
    fen: '2N5/8/4p1K1/8/8/1N5k/8/8 w - - 0 1',
    raw: {
      checkmate: false, stalemate: false, insufficient_material: false, dtz: 52, dtm: 95, category: 'win',
      moves: [
        { uci: 'b3c5', san: 'Nc5', zeroing: false, checkmate: false, stalemate: false, dtz: -51, dtm: -94, category: 'loss' },
        { uci: 'c8d6', san: 'Nd6', zeroing: false, checkmate: false, stalemate: false, dtz: -51, dtm: -94, category: 'loss' },
        { uci: 'b3d2', san: 'Nd2', zeroing: false, checkmate: false, stalemate: false, dtz: -53, dtm: -94, category: 'loss' },
        { uci: 'c8b6', san: 'Nb6', zeroing: false, checkmate: false, stalemate: false, dtz: -103, dtm: -162, category: 'blessed-loss' },
        { uci: 'c8e7', san: 'Ne7', zeroing: false, checkmate: false, stalemate: false, dtz: -103, dtm: -162, category: 'blessed-loss' },
        { uci: 'b3d4', san: 'Nd4', zeroing: false, checkmate: false, stalemate: false, dtz: -103, dtm: -164, category: 'blessed-loss' },
        { uci: 'b3a5', san: 'Na5', zeroing: false, checkmate: false, stalemate: false, dtz: -105, dtm: -164, category: 'blessed-loss' },
        { uci: 'b3a1', san: 'Na1', zeroing: false, checkmate: false, stalemate: false, dtz: -111, dtm: -164, category: 'blessed-loss' },
        { uci: 'b3c1', san: 'Nc1', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'c8a7', san: 'Na7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6g5', san: 'Kg5', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6h5', san: 'Kh5', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6f6', san: 'Kf6', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6h6', san: 'Kh6', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6f7', san: 'Kf7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6g7', san: 'Kg7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
        { uci: 'g6h7', san: 'Kh7', zeroing: false, checkmate: false, stalemate: false, dtz: 0, dtm: 0, category: 'draw' },
      ],
    },
  },
} as const;

const BY_QUERY = new Map<string, unknown>(Object.values(FX).map((f) => [f.fen.replace(/ /g, '_'), f.raw]));

function mockFetch(log: string[], script: (n: number) => Response | Error | null = () => null): typeof fetch {
  return ((input: RequestInfo | URL) => {
    const url = String(input);
    log.push(url);
    const forced = script(log.length);
    if (forced instanceof Error) return Promise.reject(forced);
    if (forced) return Promise.resolve(forced);
    const raw = BY_QUERY.get(url.split('fen=')[1] ?? '');
    if (!raw) return Promise.resolve(new Response('illegal position', { status: 400 }));
    return Promise.resolve(new Response(JSON.stringify(raw), { status: 200, headers: { 'content-type': 'application/json' } }));
  }) as typeof fetch;
}

function make(log: string[], extra: Parameters<typeof createTablebase>[0] = {}, script?: (n: number) => Response | Error | null) {
  const sleeps: number[] = [];
  const tb = createTablebase({
    fetchFn: mockFetch(log, script),
    minIntervalMs: 0,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    isOnline: () => true,
    ...extra,
  });
  return { tb, sleeps };
}

async function ok(tb: ReturnType<typeof createTablebase>, fen: string): Promise<TbProbeOk> {
  const p = await tb.probe(fen);
  if (p.status !== 'ok') throw new Error(`expected ok, got ${p.status}: ${p.message}`);
  return p;
}

describe('tablebase client', () => {
  it('reports results from the mover point of view', async () => {
    const { tb } = make([]);
    const p = await ok(tb, FX.kpkWin.fen);
    expect(p.category).toBe('win');
    expect(p.exact).toBe(true);
    expect(p.dtm).toBe(21);
    const kd6 = p.moves.find((m) => m.uci === 'e6d6');
    expect(kd6).toMatchObject({ category: 'win', dtm: 20, dtz: 2, san: 'Kd6' });
    expect(p.moves.find((m) => m.uci === 'e6d5')).toMatchObject({ category: 'draw', dtm: null, dtz: null });
    expect(bestCategory(p)).toBe('win');
    expect(bestMoves(p).map((m) => m.uci)).toEqual(['e6d6', 'e6f6']);
    expect(optimalMoves(p)).toMatchObject({ by: 'dtm', moves: [{ uci: 'e6d6' }] });
  });

  it('handles draws, stalemate and mating moves', async () => {
    const { tb } = make([]);
    const d = await ok(tb, FX.kpkB.fen);
    expect(d.category).toBe('draw');
    expect(d.dtm).toBeNull();
    expect(bestMoves(d)).toHaveLength(5);
    const s = await ok(tb, FX.stalemate.fen);
    expect(s).toMatchObject({ category: 'draw', stalemate: true, moves: [] });
    expect(bestCategory(s)).toBeNull();
    expect(pickDefence(s, () => 0.5)).toBeNull();
    const m = await ok(tb, FX.mate1.fen);
    expect(m.moves[0]).toMatchObject({ uci: 'h1h8', checkmate: true, category: 'win', dtm: 0 });
    expect(optimalMoves(m).moves.map((x) => x.uci)).toEqual(['h1h8']);
  });

  it('picks the longest resistance when lost', async () => {
    const { tb } = make([]);
    const p = await ok(tb, FX.krkLoss.fen);
    expect(p.category).toBe('loss');
    expect(p.dtm).toBe(-4);
    expect(p.moves.map((m) => [m.uci, m.category, m.dtm])).toEqual([
      ['b8c8', 'loss', -3],
      ['b8a8', 'loss', -1],
    ]);
    for (const r of [0, 0.5, 0.999]) expect(pickDefence(p, () => r)?.uci).toBe('b8c8');
  });

  it('keeps the result and randomises among ties when not lost', async () => {
    const { tb } = make([]);
    const d = await ok(tb, FX.kpkB.fen);
    expect(pickDefence(d, () => 0)?.uci).toBe('e8d7');
    expect(pickDefence(d, () => 0.999)?.uci).toBe('e8f8');
  });

  it('folds cursed wins into inexact draws', async () => {
    const { tb } = make([]);
    const p = await ok(tb, FX.cursed.fen);
    expect(p.category).toBe('win');
    const nb6 = p.moves.find((m) => m.uci === 'c8b6');
    expect(nb6).toMatchObject({ category: 'draw', exact: false, dtm: null });
    expect(bestMoves(p).map((m) => m.uci)).toEqual(['b3c5', 'c8d6', 'b3d2']);
    expect(optimalMoves(p).moves).toHaveLength(3);
    // A position whose own category is cursed is a draw with exact=false.
    const folded = parseTbResponse('x', { ...FX.cursed.raw, category: 'cursed-win' });
    expect(folded).toMatchObject({ status: 'ok', category: 'draw', exact: false, dtm: null });
    expect(parseTbResponse('x', { ...FX.cursed.raw, category: 'maybe-win' }).status).toBe('error');
  });

  it('caches responses and deduplicates concurrent probes', async () => {
    const log: string[] = [];
    const cache = memoryTbCache();
    const { tb } = make(log, { cache });
    const [a, b] = await Promise.all([tb.probe(FX.kpkWin.fen), tb.probe(FX.kpkWin.fen.replace(/ /g, '_'))]);
    expect(a).toEqual(b);
    await tb.probe(FX.kpkWin.fen);
    expect(log).toHaveLength(1);
    expect(tb.stats()).toEqual({ requests: 1, cacheHits: 1 });
    expect(await cache.get(normaliseFen(FX.kpkWin.fen))).toBeTruthy();
    // A second client sharing the cache needs no network at all.
    const log2: string[] = [];
    const again = make(log2, { cache });
    expect((await again.tb.probe(FX.kpkWin.fen)).status).toBe('ok');
    expect(log2).toHaveLength(0);
  });

  it('rejects more than 7 pieces without a request and undecided results', async () => {
    const log: string[] = [];
    const { tb } = make(log);
    expect((await tb.probe('4k3/pppppppp/8/8/8/8/8/4K3 w - - 0 1')).status).toBe('too-many-pieces');
    expect(log).toHaveLength(0);
    expect(parseTbResponse(FX.eight.fen, FX.eight.raw).status).toBe('error');
    expect(parseTbResponse('x', { nonsense: true }).status).toBe('error');
  });

  it('degrades to offline without throwing', async () => {
    const log: string[] = [];
    const { tb, sleeps } = make(log, { networkRetries: 1 }, () => new TypeError('fetch failed'));
    const p = await tb.probe(FX.kpkWin.fen);
    expect(p.status).toBe('offline');
    expect(log).toHaveLength(2);
    expect(sleeps).toEqual([1500]);
    const off = make([], { isOnline: () => false });
    expect((await off.tb.probe(FX.kpkWin.fen)).status).toBe('offline');
  });

  it('backs off on 429 / 5xx and reports other HTTP errors', async () => {
    const log: string[] = [];
    const { tb, sleeps } = make(log, { backoffMs: 100, backoff429Ms: 1000 }, (n) =>
      n === 1 ? new Response('', { status: 429 }) : n === 2 ? new Response('', { status: 503 }) : null,
    );
    expect((await tb.probe(FX.kpkWin.fen)).status).toBe('ok');
    expect(log).toHaveLength(3);
    expect(sleeps).toEqual([1000, 200]);
    const always = make([], { maxRetries: 1, backoffMs: 1 }, () => new Response('', { status: 502 }));
    expect(await always.tb.probe(FX.kpkWin.fen)).toMatchObject({ status: 'error' });
    const bad = await make([]).tb.probe('7k/8/5QK1/8/8/8/8/8 w - - 0 1');
    expect(bad).toMatchObject({ status: 'error' });
    expect(bad.status !== 'ok' && bad.message).toContain('400');
  });

  it('spaces requests by minIntervalMs', async () => {
    const log: string[] = [];
    let t = 1000;
    const waits: number[] = [];
    const tb = createTablebase({
      fetchFn: mockFetch(log),
      minIntervalMs: 700,
      isOnline: () => true,
      now: () => t,
      sleep: (ms) => {
        waits.push(ms);
        t += ms;
        return Promise.resolve();
      },
    });
    await Promise.all([tb.probe(FX.kpkWin.fen), tb.probe(FX.kpkB.fen), tb.probe(FX.krkLoss.fen)]);
    expect(waits).toEqual([700, 700]);
    expect(log).toHaveLength(3);
  });
});
