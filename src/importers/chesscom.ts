/**
 * Chess.com import through the public "PubAPI" (no auth):
 *   GET https://api.chess.com/pub/player/{username}/games/archives -> { archives: string[] } (monthly URLs, oldest first)
 *   GET <archive url> -> { games: [{ url, pgn, time_control, time_class, end_time, rated, uuid, rules,
 *                                    white: {username, rating, result}, black: {...} }] } (oldest first)
 * Verified against the live API on 2026-11-10; both endpoints answered with
 * `Access-Control-Allow-Origin: *`, so browser requests normally work. Requests are made one at a
 * time (Chess.com rate-limits parallel requests). If the browser still blocks the request
 * (privacy extension, network policy), the result is { status: 'blocked' } and the UI offers PGN upload.
 */
import type { FetchFn, ImportResult } from './lichess';
import { USERNAME_RE } from './lichess';
import { parsePgn } from './pgn';
import type { GameSpeed, ImportError, ImportedGame } from './types';

export interface ChessComGameJson {
  url?: string;
  pgn?: string;
  time_control?: string;
  time_class?: string;
  end_time?: number;
  uuid?: string;
  rules?: string;
  white?: { username?: string; rating?: number };
  black?: { username?: string; rating?: number };
}

const CLASSES: Record<string, GameSpeed> = { bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', daily: 'correspondence', classical: 'classical' };

/** Converts one archive entry (its PGN carries the %clk comments). */
export function chessComJsonToGame(g: ChessComGameJson, username?: string): ImportedGame | string {
  if (g.rules && g.rules !== 'chess') return `Variant "${g.rules}" is not supported`;
  if (!g.pgn) return 'Game has no PGN';
  const { games, errors } = parsePgn(g.pgn, { username, source: 'chesscom' });
  const game = games[0];
  if (!game) return errors[0]?.message ?? 'Unreadable PGN';
  const idFromUrl = g.url ? /\/(\d+)(?:\?|$)/.exec(g.url)?.[1] : undefined;
  return {
    ...game,
    id: idFromUrl ? `chesscom:${idFromUrl}` : game.id.startsWith('chesscom:') ? game.id : `chesscom:${g.uuid ?? game.id}`,
    url: g.url ?? game.url,
    whiteElo: g.white?.rating ?? game.whiteElo,
    blackElo: g.black?.rating ?? game.blackElo,
    speed: (g.time_class ? CLASSES[g.time_class] : undefined) ?? game.speed,
    playedAt: typeof g.end_time === 'number' ? g.end_time * 1000 : game.playedAt,
  };
}

export interface ChessComOptions {
  max?: number;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /** Most monthly archives to read (newest first). */
  maxArchives?: number;
}

const BLOCKED = 'Your browser blocked the request to Chess.com. Download your games as PGN from chess.com and paste or upload them instead.';

async function getJson(fetchFn: FetchFn, url: string, signal?: AbortSignal): Promise<{ ok: true; body: unknown } | { ok: false; result: ImportResult }> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/json' }, signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { ok: false, result: { status: 'error', message: 'Import cancelled.' } };
    return { ok: false, result: { status: 'blocked', message: BLOCKED } };
  }
  if (res.status === 404) return { ok: false, result: { status: 'not-found', message: 'Chess.com has no user with that name.' } };
  if (res.status === 429) return { ok: false, result: { status: 'rate-limited', message: 'Chess.com is rate-limiting requests. Please wait a minute and try again.' } };
  if (!res.ok) return { ok: false, result: { status: 'error', message: `Chess.com returned HTTP ${res.status}.` } };
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return { ok: false, result: { status: 'error', message: 'Chess.com sent a response that could not be read.' } };
  }
}

export async function fetchChessComGames(username: string, opts: ChessComOptions = {}): Promise<ImportResult> {
  const name = username.trim();
  if (!USERNAME_RE.test(name)) return { status: 'error', message: 'That does not look like a Chess.com username.' };
  const max = Math.max(1, Math.min(300, Math.round(opts.max ?? 100)));
  const fetchFn: FetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  const idx = await getJson(fetchFn, `https://api.chess.com/pub/player/${encodeURIComponent(name.toLowerCase())}/games/archives`, opts.signal);
  if (!idx.ok) return idx.result;
  const archives = (idx.body as { archives?: unknown }).archives;
  if (!Array.isArray(archives)) return { status: 'error', message: 'Chess.com sent an unexpected archive list.' };
  const urls = archives.filter((a): a is string => typeof a === 'string' && a.startsWith('https://api.chess.com/')).reverse();
  const games: ImportedGame[] = [];
  const errors: ImportError[] = [];
  let index = 0;
  for (const url of urls.slice(0, opts.maxArchives ?? 6)) {
    if (games.length >= max) break;
    const month = await getJson(fetchFn, url, opts.signal);
    if (!month.ok) {
      if (games.length > 0) break; // keep what we have
      return month.result;
    }
    const list = (month.body as { games?: unknown }).games;
    if (!Array.isArray(list)) continue;
    for (const raw of [...(list as ChessComGameJson[])].reverse()) {
      if (games.length >= max) break;
      const i = index++;
      const g = chessComJsonToGame(raw, name);
      if (typeof g === 'string') errors.push({ index: i, message: g, label: raw.url });
      else games.push(g);
    }
  }
  return { status: 'ok', games, errors };
}
