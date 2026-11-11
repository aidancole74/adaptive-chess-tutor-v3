/**
 * Optional Lichess opening-explorer client. The app defaults to the local book pack; this is only used when the
 * user opts in. As of 2026-11 explorer.lichess.ovh answers 401 Unauthorized to anonymous requests, so a personal
 * Lichess token is needed: the Authorization header is sent ONLY when the user supplied one.
 */
export interface ExplorerMove {
  uci: string;
  san: string;
  games: number;
  white: number;
  draws: number;
  black: number;
  /** Score in percent from the side to move's point of view. */
  scorePct: number;
  averageRating: number | null;
}

export type ExplorerResult =
  | { status: 'ok'; games: number; moves: ExplorerMove[]; opening: { eco: string; name: string } | null }
  | { status: 'unauthorized' | 'offline' | 'error'; httpStatus?: number; message?: string };

export interface ExplorerOptions {
  token?: string;
  /** e.g. ['blitz', 'rapid'] */
  speeds?: string[];
  /** Rating buckets as accepted by the API, e.g. [1600, 1800]. */
  ratings?: number[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export const EXPLORER_URL = 'https://explorer.lichess.ovh/lichess';

interface RawMove {
  uci?: unknown;
  san?: unknown;
  white?: unknown;
  draws?: unknown;
  black?: unknown;
  averageRating?: unknown;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

export function explorerUrl(fen: string, opts: Pick<ExplorerOptions, 'speeds' | 'ratings'> = {}): string {
  const q = new URLSearchParams({ variant: 'standard', fen });
  if (opts.speeds?.length) q.set('speeds', opts.speeds.join(','));
  if (opts.ratings?.length) q.set('ratings', opts.ratings.join(','));
  return `${EXPLORER_URL}?${q.toString()}`;
}

/** Normalises an explorer JSON response. `whiteToMove` decides the score perspective. */
export function normaliseExplorer(json: unknown, whiteToMove: boolean): ExplorerResult {
  if (!json || typeof json !== 'object') return { status: 'error', message: 'malformed response' };
  const o = json as { moves?: unknown; white?: unknown; draws?: unknown; black?: unknown; opening?: unknown };
  if (!Array.isArray(o.moves)) return { status: 'error', message: 'malformed response' };
  const moves: ExplorerMove[] = [];
  for (const m of o.moves as RawMove[]) {
    if (typeof m.uci !== 'string' || typeof m.san !== 'string') continue;
    const white = num(m.white);
    const draws = num(m.draws);
    const black = num(m.black);
    const games = white + draws + black;
    const mine = whiteToMove ? white : black;
    moves.push({
      uci: m.uci,
      san: m.san,
      games,
      white,
      draws,
      black,
      scorePct: games ? ((mine + draws / 2) / games) * 100 : 0,
      averageRating: typeof m.averageRating === 'number' ? m.averageRating : null,
    });
  }
  moves.sort((a, b) => b.games - a.games);
  const op = o.opening as { eco?: unknown; name?: unknown } | null | undefined;
  const opening = op && typeof op.eco === 'string' && typeof op.name === 'string' ? { eco: op.eco, name: op.name } : null;
  return { status: 'ok', games: num(o.white) + num(o.draws) + num(o.black), moves, opening };
}

export async function fetchExplorer(fen: string, opts: ExplorerOptions = {}): Promise<ExplorerResult> {
  const f = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  let res: Response;
  try {
    res = await f(explorerUrl(fen, opts), { headers, signal: opts.signal });
  } catch (e) {
    return { status: 'offline', message: (e as Error).message };
  }
  if (res.status === 401 || res.status === 403) return { status: 'unauthorized', httpStatus: res.status };
  if (!res.ok) return { status: 'error', httpStatus: res.status };
  try {
    return normaliseExplorer(await res.json(), fen.split(' ')[1] !== 'b');
  } catch (e) {
    return { status: 'error', httpStatus: res.status, message: (e as Error).message };
  }
}
