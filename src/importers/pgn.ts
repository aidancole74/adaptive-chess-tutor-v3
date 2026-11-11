/**
 * Multi-game PGN parser. Tolerant of real-world exports: % escape lines, ; and {} comments, NAGs
 * ($n and !? glyphs), nested variations (skipped), move numbers glued to moves ("1.e4"), FEN/SetUp
 * headers, Lichess / Chess.com clock comments ([%clk h:mm:ss(.d)]) and Lichess eval comments
 * ([%eval 0.18], [%eval #-3], optionally with ",depth"). Every move is replayed with chess.js; a game
 * with an illegal move is reported in `errors` and not returned (never half-guessed).
 */
import { START_FEN } from '../engine/chessUtil';
import { replaySans, type MoveAnnotations } from './build';
import { hashString, speedOf, type EmbeddedEval, type GameSource, type GameSpeed, type ImportError, type ImportedGame } from './types';

export interface PgnOptions {
  /** Username to match (case-insensitive) against the White / Black headers to set userColor. */
  username?: string;
  source?: GameSource;
}

interface RawGame {
  headers: Record<string, string>;
  sans: string[];
  /** Comments attached to each main-line move (index = ply - 1). */
  comments: string[][];
  result: string | null;
  text: string;
}

const RESULTS = new Set(['1-0', '0-1', '1/2-1/2', '½-½', '*']);

/** Splits PGN text into raw games (headers, main-line SAN tokens and their comments). */
export function tokenizePgn(input: string): RawGame[] {
  const text = input.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const games: RawGame[] = [];
  let cur: RawGame | null = null;
  let start = 0;
  let depth = 0;
  let inMoves = false;
  const fresh = (at: number): RawGame => {
    start = at;
    return { headers: {}, sans: [], comments: [], result: null, text: '' };
  };
  const finish = (end: number): void => {
    if (cur && (cur.sans.length > 0 || Object.keys(cur.headers).length > 0 || cur.result)) {
      cur.text = text.slice(start, end).trim();
      games.push(cur);
    }
    cur = null;
    depth = 0;
    inMoves = false;
  };
  const comment = (body: string): void => {
    if (!cur || depth > 0 || cur.sans.length === 0) return;
    cur.comments[cur.sans.length - 1]!.push(body);
  };

  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i]!;
    if (ch === '\n' || ch === ' ' || ch === '\t') {
      i++;
      continue;
    }
    if (ch === '%' && (i === 0 || text[i - 1] === '\n')) {
      const e = text.indexOf('\n', i);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '[' && depth === 0) {
      const e = text.indexOf('\n', i);
      const line = text.slice(i, e < 0 ? n : e);
      const m = /^\[\s*([A-Za-z0-9_]+)\s+"((?:[^"\\]|\\.)*)"\s*\]/.exec(line);
      if (m) {
        if (inMoves || (cur && cur.result)) finish(i);
        cur ??= fresh(i);
        cur.headers[m[1]!] = m[2]!.replace(/\\(["\\])/g, '$1');
        i += m[0].length;
        continue;
      }
      // Not a header: skip the bracket so it cannot stall the parser.
      i++;
      continue;
    }
    if (ch === '{') {
      const e = text.indexOf('}', i + 1);
      const body = text.slice(i + 1, e < 0 ? n : e);
      comment(body);
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === ';') {
      const e = text.indexOf('\n', i);
      comment(text.slice(i + 1, e < 0 ? n : e));
      i = e < 0 ? n : e + 1;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    // Plain token.
    let j = i;
    while (j < n && !/[\s{}()[\];]/.test(text[j]!)) j++;
    if (j === i) {
      i++;
      continue;
    }
    let tok = text.slice(i, j);
    i = j;
    if (depth > 0) continue;
    if (RESULTS.has(tok)) {
      cur ??= fresh(i - tok.length);
      cur.result = tok === '½-½' ? '1/2-1/2' : tok;
      inMoves = true;
      continue;
    }
    if (tok.startsWith('$')) continue;
    tok = tok.replace(/^\d+\.+/, '');
    if (!tok || /^[!?]+$/.test(tok) || /^\d+$/.test(tok) || tok === '..' || tok === '...') continue;
    cur ??= fresh(i - tok.length);
    if (cur.result) {
      // Movetext after a result without new headers: start a new game.
      finish(i - tok.length);
      cur = fresh(i - tok.length);
    }
    inMoves = true;
    cur.sans.push(tok);
    cur.comments.push([]);
  }
  finish(n);
  return games;
}

/** "[%clk 0:04:59.9]" -> milliseconds. */
export function parseClock(comment: string): number | null {
  const m = /\[%clk\s+(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*\]/.exec(comment);
  if (!m) return null;
  return Math.round((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000);
}

/** "[%eval 0.18]" / "[%eval #-3]" / "[%eval -1.2,23]" -> white-POV eval. */
export function parseEval(comment: string): EmbeddedEval | null {
  const m = /\[%eval\s+(#?)([+-]?\d+(?:\.\d+)?)(?:,\d+)?\s*\]/.exec(comment);
  if (!m) return null;
  const v = Number(m[2]);
  if (!Number.isFinite(v)) return null;
  return m[1] ? { cp: null, mate: Math.trunc(v) } : { cp: Math.round(v * 100), mate: null };
}

/** "300+2" -> {base 300, inc 2}; "300" -> {300, 0}; "-", "?" and daily "1/86400" -> null. */
export function parseTimeControl(tc: string | undefined): { base: number; inc: number } | null {
  if (!tc) return null;
  const m = /^(\d+)(?:\+(\d+))?$/.exec(tc.trim());
  if (!m) return null;
  return { base: Number(m[1]), inc: Number(m[2] ?? 0) };
}

function parseDate(h: Record<string, string>): number | undefined {
  const d = h.UTCDate ?? h.Date;
  const m = d ? /^(\d{4})\.(\d{2})\.(\d{2})$/.exec(d) : null;
  if (!m) return undefined;
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(h.UTCTime ?? h.StartTime ?? '');
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(t?.[1] ?? 0), Number(t?.[2] ?? 0), Number(t?.[3] ?? 0));
}

function eloOf(v: string | undefined): number | undefined {
  const n = Number(v);
  return v && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Stable id and canonical url from Site / Link / GameId headers. */
function identify(h: Record<string, string>, text: string): { id: string; url?: string } {
  const site = h.Site ?? '';
  const lichess = /lichess\.org\/(?:game\/)?([A-Za-z0-9]{8})(?:[A-Za-z0-9]{4})?\b/.exec(site);
  if (lichess) return { id: `lichess:${lichess[1]}`, url: `https://lichess.org/${lichess[1]}` };
  if (h.GameId && /lichess/i.test(site)) return { id: `lichess:${h.GameId}`, url: `https://lichess.org/${h.GameId}` };
  const link = h.Link ?? (site.includes('chess.com/game') ? site : '');
  const cc = /chess\.com\/game\/(?:live|daily)\/(\d+)/.exec(link);
  if (cc) return { id: `chesscom:${cc[1]}`, url: link };
  return { id: `pgn:${hashString(text)}` };
}

const VARIANTS_OK = new Set(['', 'standard', 'from position']);

export function parsePgn(input: string, opts: PgnOptions = {}): { games: ImportedGame[]; errors: ImportError[] } {
  const games: ImportedGame[] = [];
  const errors: ImportError[] = [];
  const raws = tokenizePgn(input);
  const user = opts.username?.trim().toLowerCase() || null;
  raws.forEach((raw, index) => {
    const h = raw.headers;
    const label = `${h.White ?? '?'} vs ${h.Black ?? '?'}${h.Date ? `, ${h.Date}` : ''}`;
    const variant = (h.Variant ?? '').toLowerCase();
    if (!VARIANTS_OK.has(variant)) {
      errors.push({ index, label, message: `Variant "${h.Variant}" is not supported (standard chess only)` });
      return;
    }
    if (raw.sans.length === 0) {
      errors.push({ index, label, message: 'Game has no moves' });
      return;
    }
    const startFen = h.FEN && (h.SetUp === '1' || h.SetUp === undefined) ? h.FEN : START_FEN;
    const notes = (ply: number): MoveAnnotations => {
      const cs = raw.comments[ply] ?? [];
      let clockMs: number | null = null;
      let embeddedEval: EmbeddedEval | null = null;
      for (const c of cs) {
        clockMs ??= parseClock(c);
        embeddedEval ??= parseEval(c);
      }
      return { clockMs, embeddedEval };
    };
    const replay = replaySans(startFen, raw.sans, notes);
    if (!replay.ok) {
      errors.push({ index, label, message: replay.error });
      return;
    }
    const { id, url } = identify(h, raw.text);
    const timeControl = parseTimeControl(h.TimeControl);
    let speed: GameSpeed | null = speedOf(timeControl);
    if (!timeControl && (/correspondence|daily/i.test(h.Event ?? '') || /^\d+\/\d+$/.test(h.TimeControl ?? ''))) speed = 'correspondence';
    const white = h.White ?? '?';
    const black = h.Black ?? '?';
    let userColor: 'w' | 'b' | null = null;
    if (user && white.toLowerCase() === user) userColor = 'w';
    else if (user && black.toLowerCase() === user) userColor = 'b';
    const result = h.Result && RESULTS.has(h.Result) ? h.Result : (raw.result ?? '*');
    games.push({
      id,
      source: opts.source ?? 'pgn',
      url,
      white,
      black,
      whiteElo: eloOf(h.WhiteElo),
      blackElo: eloOf(h.BlackElo),
      userColor,
      result,
      timeControl,
      speed,
      startFen: replay.startFen,
      moves: replay.moves,
      opening: h.ECO || h.Opening ? { eco: h.ECO || undefined, name: h.Opening || undefined } : undefined,
      playedAt: parseDate(h),
    });
  });
  return { games, errors };
}
