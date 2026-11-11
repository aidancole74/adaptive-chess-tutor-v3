import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chessComJsonToGame, fetchChessComGames } from './chesscom';
import { fetchLichessGames, lichessJsonToGame, type FetchFn, type LichessGameJson } from './lichess';
import { parsePgn } from './pgn';

// Captured from the live APIs on 2026-11-10 (public games, no auth):
//  - lichess.org/api/games/user/DrNykterstein?max=3&clocks=true&evals=true&opening=true (one NDJSON line)
//  - api.chess.com/pub/player/hikaru/games/2026/11 (two archive entries)
const FIX = path.join(import.meta.dirname, 'fixtures');
const ndjsonLine = fs.readFileSync(path.join(FIX, 'lichess-user-games.ndjson'), 'utf8').trim();
const evalPgn = fs.readFileSync(path.join(FIX, 'lichess-eval.pgn'), 'utf8');
const chesscom = JSON.parse(fs.readFileSync(path.join(FIX, 'chesscom-archive.json'), 'utf8')) as { games: unknown[] };

function respond(body: string, status = 200, chunks = 1): Response {
  const enc = new TextEncoder().encode(body);
  const size = Math.ceil(enc.length / chunks);
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < enc.length; i += size) c.enqueue(enc.slice(i, i + size));
      c.close();
    },
  });
  return new Response(stream, { status });
}

describe('lichessJsonToGame (captured API line)', () => {
  const json = JSON.parse(ndjsonLine) as LichessGameJson;
  const g = lichessJsonToGame(json, 'drnykterstein');
  it('maps players, speed, clock, opening and result', () => {
    if (typeof g === 'string') throw new Error(g);
    expect(g.id).toBe('lichess:J3C5rR4Z');
    expect(g.white).toBe('AngelitoRT');
    expect(g.black).toBe('DrNykterstein');
    expect(g.userColor).toBe('b');
    expect(g.whiteElo).toBe(2853);
    expect(g.speed).toBe('blitz');
    expect(g.timeControl).toEqual({ base: 180, inc: 0 });
    expect(g.result).toBe('0-1');
    expect(g.opening).toEqual({ eco: 'B51', name: 'Sicilian Defense: Moscow Variation' });
    expect(g.playedAt).toBe(json.createdAt);
  });
  it('aligns clocks (centiseconds) and analysis (white POV) with the PGN export of the same game', () => {
    if (typeof g === 'string') throw new Error(g);
    const fromPgn = parsePgn(evalPgn).games[0]!;
    expect(g.moves.map((m) => m.uci)).toEqual(fromPgn.moves.map((m) => m.uci));
    g.moves.forEach((m, i) => {
      // PGN clocks are whole seconds; the API has centiseconds.
      expect(Math.abs(m.clockMs! - fromPgn.moves[i]!.clockMs!)).toBeLessThan(1000);
      expect(m.embeddedEval).toEqual(fromPgn.moves[i]!.embeddedEval);
    });
  });
});

describe('fetchLichessGames', () => {
  it('requests NDJSON with clocks, evals and openings and stream-parses split chunks', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, init });
      return respond(`${ndjsonLine}\n${ndjsonLine}\n`, 200, 7);
    };
    const seen: string[] = [];
    const r = await fetchLichessGames('DrNykterstein', { max: 2, fetchFn, onGame: (g) => seen.push(g.id) });
    expect(calls[0]!.url).toBe('https://lichess.org/api/games/user/DrNykterstein?max=2&clocks=true&evals=true&opening=true');
    expect((calls[0]!.init!.headers as Record<string, string>).Accept).toBe('application/x-ndjson');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.games).toHaveLength(2);
    expect(seen).toEqual(['lichess:J3C5rR4Z', 'lichess:J3C5rR4Z']);
  });
  it('maps 404, 429 and network failures to user-facing statuses', async () => {
    expect((await fetchLichessGames('nobody', { fetchFn: async () => respond('{"error":"Not found"}', 404) })).status).toBe('not-found');
    const limited = await fetchLichessGames('busy', { fetchFn: async () => respond('', 429) });
    expect(limited.status).toBe('rate-limited');
    expect(limited.status === 'rate-limited' && limited.message).toMatch(/wait a minute/);
    const offline = await fetchLichessGames('x1', {
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(offline.status).toBe('error');
    expect((await fetchLichessGames('bad name!', { fetchFn: async () => respond('') })).status).toBe('error');
  });
  it('reports unreadable lines without dropping good games', async () => {
    const r = await fetchLichessGames('u1', { fetchFn: async () => respond(`{oops\n${ndjsonLine}\n`) });
    expect(r.status === 'ok' && r.games.length).toBe(1);
    expect(r.status === 'ok' && r.errors.length).toBe(1);
  });
});

describe('Chess.com', () => {
  it('converts archive entries (PGN with %clk tenths, ratings, time class)', () => {
    const g = chessComJsonToGame(chesscom.games[1] as never, 'hikaru');
    if (typeof g === 'string') throw new Error(g);
    expect(g.id).toBe('chesscom:188647699045');
    expect(g.source).toBe('chesscom');
    expect(g.userColor).toBe('w');
    expect(g.whiteElo).toBe(3464);
    expect(g.speed).toBe('blitz');
    expect(g.timeControl).toEqual({ base: 300, inc: 0 });
    expect(g.moves[0]).toMatchObject({ san: 'c4', clockMs: 299_900 });
  });
  it('walks archives newest first and maps a thrown fetch to "blocked"', async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      if (url.endsWith('/archives')) return new Response(JSON.stringify({ archives: ['https://api.chess.com/pub/player/hikaru/games/2026/10', 'https://api.chess.com/pub/player/hikaru/games/2026/11'] }));
      return new Response(JSON.stringify(chesscom));
    };
    const r = await fetchChessComGames('Hikaru', { max: 2, fetchFn });
    expect(urls).toEqual(['https://api.chess.com/pub/player/hikaru/games/archives', 'https://api.chess.com/pub/player/hikaru/games/2026/11']);
    expect(r.status === 'ok' && r.games.map((g) => g.id)[0]).toBe('chesscom:188647699045');
    const blocked = await fetchChessComGames('Hikaru', {
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(blocked.status).toBe('blocked');
  });
});
