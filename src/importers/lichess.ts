/**
 * Lichess game import: GET /api/games/user/{username} as NDJSON (one game per line), stream-parsed.
 * Field names verified against the live API on 2026-11-10 (see lichess.test.ts fixture):
 *   id, variant, speed, createdAt, status, winner, initialFen (from-position games only),
 *   players.{white,black}.{user.{name,id}, rating, aiLevel}, opening.{eco,name},
 *   moves (space-separated SAN), clocks (centiseconds; clocks[i] = mover's clock after ply i+1,
 *   plus one trailing entry for the side to move at the end), analysis[i] = {eval} | {mate}
 *   (white's point of view, position after ply i+1; present only for server-analysed games),
 *   clock.{initial, increment} (seconds).
 */
import { START_FEN } from '../engine/chessUtil';
import { replaySans } from './build';
import { speedOf, type EmbeddedEval, type GameSpeed, type ImportError, type ImportedGame } from './types';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ImportResult =
  | { status: 'ok'; games: ImportedGame[]; errors: ImportError[] }
  | { status: 'not-found'; message: string }
  | { status: 'rate-limited'; message: string }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string };

export const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,29}$/;

interface LichessPlayer {
  user?: { name?: string; id?: string };
  rating?: number;
  aiLevel?: number;
}
export interface LichessGameJson {
  id: string;
  variant?: string;
  speed?: string;
  createdAt?: number;
  status?: string;
  winner?: 'white' | 'black';
  initialFen?: string;
  players?: { white?: LichessPlayer; black?: LichessPlayer };
  opening?: { eco?: string; name?: string };
  moves?: string;
  clocks?: number[];
  analysis?: ({ eval?: number; mate?: number } | null)[];
  clock?: { initial?: number; increment?: number };
}

const SPEEDS: Record<string, GameSpeed> = {
  ultraBullet: 'bullet', bullet: 'bullet', blitz: 'blitz', rapid: 'rapid', classical: 'classical', correspondence: 'correspondence',
};
const UNFINISHED = new Set(['created', 'started', 'aborted', 'noStart', 'unknownFinish']);

function playerName(p: LichessPlayer | undefined): string {
  if (p?.user?.name) return p.user.name;
  if (p?.aiLevel) return `Stockfish level ${p.aiLevel}`;
  return 'Anonymous';
}

function resultOf(g: LichessGameJson): string {
  if (g.winner === 'white') return '1-0';
  if (g.winner === 'black') return '0-1';
  if (!g.status || UNFINISHED.has(g.status)) return '*';
  return '1/2-1/2';
}

/** Converts one NDJSON game object. Returns an error string for unsupported or unreadable games. */
export function lichessJsonToGame(g: LichessGameJson, username?: string): ImportedGame | string {
  if (g.variant && g.variant !== 'standard' && g.variant !== 'fromPosition') return `Variant "${g.variant}" is not supported`;
  const sans = (g.moves ?? '').split(' ').filter(Boolean);
  if (sans.length === 0) return 'Game has no moves';
  const evalAt = (i: number): EmbeddedEval | null => {
    const a = g.analysis?.[i];
    if (!a) return null;
    if (typeof a.mate === 'number') return { cp: null, mate: a.mate };
    if (typeof a.eval === 'number') return { cp: a.eval, mate: null };
    return null;
  };
  const replay = replaySans(g.initialFen ?? START_FEN, sans, (i) => {
    const cs = g.clocks?.[i];
    return { clockMs: typeof cs === 'number' ? cs * 10 : null, embeddedEval: evalAt(i) };
  });
  if (!replay.ok) return replay.error;
  const tc = g.clock && typeof g.clock.initial === 'number' ? { base: g.clock.initial, inc: g.clock.increment ?? 0 } : null;
  const white = playerName(g.players?.white);
  const black = playerName(g.players?.black);
  const u = username?.toLowerCase();
  const matches = (p: LichessPlayer | undefined): boolean => !!u && (p?.user?.name?.toLowerCase() === u || p?.user?.id === u);
  return {
    id: `lichess:${g.id}`,
    source: 'lichess',
    url: `https://lichess.org/${g.id}`,
    white,
    black,
    whiteElo: g.players?.white?.rating,
    blackElo: g.players?.black?.rating,
    userColor: matches(g.players?.white) ? 'w' : matches(g.players?.black) ? 'b' : null,
    result: resultOf(g),
    timeControl: tc,
    speed: (g.speed ? SPEEDS[g.speed] : undefined) ?? speedOf(tc),
    startFen: replay.startFen,
    moves: replay.moves,
    opening: g.opening ? { eco: g.opening.eco, name: g.opening.name } : undefined,
    playedAt: g.createdAt,
  };
}

/** Yields complete lines from a streamed body (falls back to text() when there is no stream). */
async function* lines(res: Response): AsyncGenerator<string> {
  if (!res.body) {
    for (const l of (await res.text()).split('\n')) yield l;
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  buf += dec.decode();
  if (buf) yield buf;
}

export interface LichessOptions {
  max?: number;
  fetchFn?: FetchFn;
  signal?: AbortSignal;
  /** Called as each game arrives (progressive UI). */
  onGame?: (g: ImportedGame) => void;
}

export async function fetchLichessGames(username: string, opts: LichessOptions = {}): Promise<ImportResult> {
  const name = username.trim();
  if (!USERNAME_RE.test(name)) return { status: 'error', message: 'That does not look like a Lichess username.' };
  const max = Math.max(1, Math.min(300, Math.round(opts.max ?? 100)));
  const fetchFn: FetchFn = opts.fetchFn ?? ((u, i) => fetch(u, i));
  const url = `https://lichess.org/api/games/user/${encodeURIComponent(name)}?max=${max}&clocks=true&evals=true&opening=true`;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: 'application/x-ndjson' }, signal: opts.signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { status: 'error', message: 'Import cancelled.' };
    return { status: 'error', message: 'Could not reach lichess.org. Check your connection and try again.' };
  }
  if (res.status === 404) return { status: 'not-found', message: `Lichess has no user called "${name}".` };
  if (res.status === 429) return { status: 'rate-limited', message: 'Lichess is rate-limiting requests. Please wait a minute and try again.' };
  if (!res.ok) return { status: 'error', message: `Lichess returned HTTP ${res.status}.` };
  const games: ImportedGame[] = [];
  const errors: ImportError[] = [];
  let index = 0;
  try {
    for await (const line of lines(res)) {
      const t = line.trim();
      if (!t) continue;
      const i = index++;
      let json: LichessGameJson;
      try {
        json = JSON.parse(t) as LichessGameJson;
      } catch {
        errors.push({ index: i, message: 'Unreadable line in the Lichess response' });
        continue;
      }
      const g = lichessJsonToGame(json, name);
      if (typeof g === 'string') errors.push({ index: i, message: g, label: `lichess.org/${json.id}` });
      else {
        games.push(g);
        opts.onGame?.(g);
      }
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return { status: 'ok', games, errors: [...errors, { index, message: 'Import cancelled; keeping the games received so far.' }] };
    errors.push({ index, message: 'The connection to lichess.org dropped; keeping the games received so far.' });
  }
  return { status: 'ok', games, errors };
}
