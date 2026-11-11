/**
 * Book stage: stream a Lichess monthly dump, aggregate the first 14 plies per rating band and write BookShards.
 *
 * Game filters (documented in pack meta):
 *  - both Elo headers present and numeric; Result decisive or drawn (not "*");
 *  - standard chess from the normal start position (no Variant other than Standard, no FEN/SetUp header);
 *  - Termination "Normal" or "Time forfeit" (Abandoned / Rules infraction / Unterminated are skipped);
 *  - estimated duration base + 40*inc >= 180 s, i.e. blitz and slower (bullet/ultrabullet and correspondence are skipped);
 *  - at least 2 plies. Games shorter than 14 plies ARE counted for the plies they have.
 * Band = BOOK_BANDS by the average of both Elos.
 *
 * Aggregation uses a position graph keyed by EPD (so transpositions merge while streaming) whose edges are
 * keyed by SAN: chess.js only runs the first time a SAN is seen in a position. Continuations that have been seen
 * once are parked as a lazy "tail" on the edge and only expanded when a second game arrives, which keeps memory
 * proportional to the positions seen at least twice. `finalizeTails()` replays parked tails as long as they stay
 * inside known positions, so counts for every shipped position include transpositions from one-off move orders.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { BOOK_BANDS, type BookBand, type BookShard, type BookStat } from '../../src/content/types';
import { START_FEN, epdOf } from '../../src/engine/chessUtil';
import { CACHE, ensureDir } from '../lib/pack';
import { gameIdOf, gamesFromLines, parseTimeControl, sanTokens } from './pgn';
import { newStreamStatus, resumableZstUrlLines } from './zst';

export const BOOK_PLIES = 14;
export const OPENINGS_CACHE = path.join(CACHE, 'openings');
export const HIGHRATED_PATH = path.join(CACHE, 'highrated-games.ndjson');
export const CLOCKED_PATH = path.join(CACHE, 'clocked-games.pgn');
/** Never ship a move with fewer games than this, whatever the size budget allows. */
export const MIN_MOVE_GAMES_FLOOR = 5;
export const SHARD_BYTE_BUDGET = 2_000_000;

interface Tail {
  sans: string[];
  from: number;
  slot: number;
}
interface Edge {
  uci: string;
  id: number;
  child: GraphNode | null;
  tail: Tail | null;
}
interface GraphNode {
  epd: string;
  edges: Map<string, Edge>;
}

const SLOTS = 12; // 4 bands x (white wins, draws, black wins)

export function bandIndex(avgElo: number): number {
  return avgElo < 1200 ? 0 : avgElo < 1600 ? 1 : avgElo < 2000 ? 2 : 3;
}

export class BookAggregator {
  readonly nodes = new Map<string, GraphNode>();
  readonly root: GraphNode;
  readonly gamesPerBand = [0, 0, 0, 0];
  sanFailures = 0;
  chessCalls = 0;
  private stats = new Uint32Array(SLOTS * (1 << 16));
  private nextId = 0;
  private chess = new Chess();
  private interned = new Map<string, string>();

  constructor() {
    this.root = { epd: epdOf(START_FEN), edges: new Map() };
    this.nodes.set(this.root.epd, this.root);
  }

  get edgeCount(): number {
    return this.nextId;
  }

  /** result: 0 = white win, 1 = draw, 2 = black win. Only the first BOOK_PLIES tokens are used. */
  add(sans: string[], band: number, result: 0 | 1 | 2): void {
    const n = Math.min(sans.length, BOOK_PLIES);
    const own: string[] = new Array<string>(n);
    for (let i = 0; i < n; i++) {
      const s = sans[i] as string;
      let v = this.interned.get(s);
      if (v === undefined) {
        v = s;
        this.interned.set(s, s);
      }
      own[i] = v;
    }
    this.gamesPerBand[band] = (this.gamesPerBand[band] ?? 0) + 1;
    this.walk(this.root, own, 0, band * 3 + result);
  }

  /** Plays `san` in `node`; returns the uci and resulting EPD, or null when the SAN is not legal there. */
  private play(node: GraphNode, san: string): { uci: string; epd: string } | null {
    this.chessCalls++;
    try {
      this.chess.load(`${node.epd} 0 1`);
      const m = this.chess.move(san, { strict: false });
      return { uci: m.from + m.to + (m.promotion ?? ''), epd: epdOf(this.chess.fen()) };
    } catch {
      return null;
    }
  }

  private bump(id: number, slot: number): void {
    const i = id * SLOTS + slot;
    if (i >= this.stats.length) {
      const bigger = new Uint32Array(this.stats.length * 2);
      bigger.set(this.stats);
      this.stats = bigger;
    }
    this.stats[i] = (this.stats[i] ?? 0) + 1;
  }

  private walk(start: GraphNode, sans: string[], from: number, slot: number): void {
    let node = start;
    for (let i = from; i < sans.length; i++) {
      const san = sans[i] as string;
      let edge = node.edges.get(san);
      let isNew = false;
      if (!edge) {
        const r = this.play(node, san);
        if (!r) {
          this.sanFailures++;
          return;
        }
        edge = { uci: r.uci, id: this.nextId++, child: this.nodes.get(r.epd) ?? null, tail: null };
        node.edges.set(san, edge);
        isNew = true;
      }
      this.bump(edge.id, slot);
      if (i === sans.length - 1) return;
      if (!edge.child) {
        if (isNew) {
          edge.tail = { sans, from: i + 1, slot };
          return;
        }
        if (!this.expand(node, san, edge)) return;
      }
      node = edge.child as GraphNode;
    }
  }

  /** Materialises the child position of an edge and pushes a parked tail one level down. */
  private expand(node: GraphNode, san: string, edge: Edge): boolean {
    const r = this.play(node, san);
    if (!r) return false;
    let child = this.nodes.get(r.epd);
    if (!child) {
      child = { epd: r.epd, edges: new Map() };
      this.nodes.set(r.epd, child);
    }
    edge.child = child;
    const t = edge.tail;
    if (t) {
      edge.tail = null;
      this.walk(child, t.sans, t.from, t.slot);
    }
    return true;
  }

  /**
   * Replays parked one-off continuations for as long as they stay inside already-known positions.
   * Returns the number of tails that re-joined the graph. Call once, before the final `buildShards`.
   */
  finalizeTails(): number {
    const pending: { node: GraphNode; san: string; edge: Edge }[] = [];
    for (const node of this.nodes.values()) {
      for (const [san, edge] of node.edges) if (edge.tail && !edge.child) pending.push({ node, san, edge });
    }
    let rejoined = 0;
    for (const p of pending) {
      const t = p.edge.tail;
      if (!t || p.edge.child) continue; // expanded meanwhile by another replay
      const r = this.play(p.node, p.san);
      if (!r) continue;
      const child = this.nodes.get(r.epd);
      if (!child) continue;
      p.edge.child = child;
      p.edge.tail = null;
      rejoined++;
      this.walk(child, t.sans, t.from, t.slot);
    }
    return rejoined;
  }

  /**
   * One BookShard per band. Moves need >= `floor` games; if the JSON would exceed `maxBytes` the per-band
   * threshold is raised to the smallest value that fits. Returns the thresholds actually used.
   */
  buildShards(maxBytes = SHARD_BYTE_BUDGET, floor = MIN_MOVE_GAMES_FLOOR): { shards: BookShard[]; minMoveGames: number[]; bytes: number[] } {
    interface Entry {
      epd: string;
      uci: string;
      g: number;
      w: number;
      d: number;
      b: number;
    }
    const perBand: Entry[][] = [[], [], [], []];
    const tmp = new Map<string, number[]>();
    for (const node of this.nodes.values()) {
      if (node.edges.size === 0) continue;
      tmp.clear();
      for (const edge of node.edges.values()) {
        let acc = tmp.get(edge.uci);
        if (!acc) {
          acc = new Array<number>(SLOTS).fill(0);
          tmp.set(edge.uci, acc);
        }
        const base = edge.id * SLOTS;
        for (let s = 0; s < SLOTS; s++) acc[s] = (acc[s] ?? 0) + (this.stats[base + s] ?? 0);
      }
      for (const [uci, acc] of tmp) {
        for (let band = 0; band < 4; band++) {
          const w = acc[band * 3] ?? 0;
          const d = acc[band * 3 + 1] ?? 0;
          const b = acc[band * 3 + 2] ?? 0;
          const g = w + d + b;
          if (g >= floor) (perBand[band] as Entry[]).push({ epd: node.epd, uci, g, w, d, b });
        }
      }
    }
    const shards: BookShard[] = [];
    const minMoveGames: number[] = [];
    const bytes: number[] = [];
    const digits = (x: number): number => String(x).length;
    for (let band = 0; band < 4; band++) {
      const entries = perBand[band] as Entry[];
      entries.sort((a, b) => b.g - a.g || (a.epd < b.epd ? -1 : a.epd > b.epd ? 1 : a.uci < b.uci ? -1 : 1));
      // Estimate JSON size cumulatively in descending-games order to find the cut.
      let size = 60;
      let threshold = floor;
      const seen = new Set<string>();
      for (const e of entries) {
        let add = e.uci.length + 7 + digits(e.g) + digits(e.w) + digits(e.d) + digits(e.b) + 3;
        if (!seen.has(e.epd)) add += e.epd.length + 6;
        if (size + add > maxBytes) {
          threshold = e.g + 1;
          break;
        }
        seen.add(e.epd);
        size += add;
      }
      const positions: Record<string, Record<string, BookStat>> = {};
      for (const e of entries) {
        if (e.g < threshold) break;
        (positions[e.epd] ??= {})[e.uci] = [e.g, e.w, e.d, e.b];
      }
      const shard: BookShard = { band: BOOK_BANDS[band] as BookBand, games: this.gamesPerBand[band] ?? 0, positions };
      shards.push(shard);
      minMoveGames.push(threshold);
      bytes.push(Buffer.byteLength(JSON.stringify(shard)));
    }
    return { shards, minMoveGames, bytes };
  }
}

export interface BookMeta {
  month: string;
  url: string;
  gamesRequested: number;
  gamesStreamed: number;
  gamesAggregated: number;
  gamesAggregatedPerBand: Record<string, number>;
  positionsPerBand: Record<string, number>;
  movesPerBand: Record<string, number>;
  shardBytesPerBand: Record<string, number>;
  minMoveGamesPerBand: Record<string, number>;
  minMoveGamesFloor: number;
  shardByteBudget: number;
  plies: number;
  skipped: Record<string, number>;
  sanFailures: number;
  compressedBytes: number;
  reconnects: number;
  highRatedGames: number;
  clockedGames: number;
  tailsRejoined: number | null;
  /** True once the stream reached the requested game count (or the end of the dump). */
  complete: boolean;
  /** Why the stream ended early, when it did. */
  partialReason: string | null;
  filters: string;
  updatedAt: string;
}

export const FILTERS_DOC =
  'rated standard games from the normal start position; both Elos present; result 1-0/0-1/1/2-1/2; ' +
  'Termination Normal or Time forfeit; base+40*inc >= 180s (bullet, ultrabullet and correspondence skipped); ' +
  '>= 2 plies (games shorter than 14 plies count for the plies they have); band = average of both Elos';

export async function latestMonth(): Promise<string> {
  const res = await fetch('https://database.lichess.org/standard/list.txt');
  if (!res.ok) throw new Error(`list.txt HTTP ${res.status}`);
  const m = /rated_(\d{4}-\d{2})\.pgn\.zst/.exec(await res.text());
  if (!m) throw new Error('no month found in list.txt');
  return m[1] as string;
}

export function readBookShards(): BookShard[] | null {
  const out: BookShard[] = [];
  for (const band of BOOK_BANDS) {
    const f = path.join(OPENINGS_CACHE, `book-${band}.json`);
    if (!fs.existsSync(f)) return null;
    out.push(JSON.parse(fs.readFileSync(f, 'utf8')) as BookShard);
  }
  return out;
}

export function readBookMeta(): BookMeta | null {
  const f = path.join(OPENINGS_CACHE, 'book-meta.json');
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as BookMeta) : null;
}

export async function runBookStage(opts: { games: number; month?: string }): Promise<BookMeta> {
  ensureDir(OPENINGS_CACHE);
  const month = opts.month ?? (await latestMonth());
  const url = `https://database.lichess.org/standard/lichess_db_standard_rated_${month}.pgn.zst`;
  const logFile = path.join(OPENINGS_CACHE, 'stream.log');
  const log = (msg: string): void => {
    const line = `${new Date().toISOString()} ${msg}`;
    console.log(line);
    fs.appendFileSync(logFile, line + '\n');
  };
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(HIGHRATED_PATH, '');
  fs.writeFileSync(CLOCKED_PATH, '');
  log(`[book] month ${month}, target ${opts.games} games, ${url}`);

  const agg = new BookAggregator();
  const status = newStreamStatus();
  const skipped: Record<string, number> = { missingElo: 0, variantOrFen: 0, termination: 0, noResult: 0, tooFast: 0, tooShort: 0 };
  let streamed = 0;
  let highRated = 0;
  let clocked = 0;
  const t0 = Date.now();

  const writeCheckpoint = (complete: boolean, tailsRejoined: number | null, partialReason: string | null): BookMeta => {
    const { shards, minMoveGames, bytes } = agg.buildShards();
    const per = <T>(f: (i: number) => T): Record<string, T> => Object.fromEntries(BOOK_BANDS.map((b, i) => [b, f(i)]));
    for (const s of shards) {
      const f = path.join(OPENINGS_CACHE, `book-${s.band}.json`);
      fs.writeFileSync(f + '.tmp', JSON.stringify(s));
      fs.renameSync(f + '.tmp', f);
    }
    const meta: BookMeta = {
      month,
      url,
      gamesRequested: opts.games,
      gamesStreamed: streamed,
      gamesAggregated: agg.gamesPerBand.reduce((a, b) => a + b, 0),
      gamesAggregatedPerBand: per((i) => agg.gamesPerBand[i] ?? 0),
      positionsPerBand: per((i) => Object.keys(shards[i]?.positions ?? {}).length),
      movesPerBand: per((i) => Object.values(shards[i]?.positions ?? {}).reduce((a, p) => a + Object.keys(p).length, 0)),
      shardBytesPerBand: per((i) => bytes[i] ?? 0),
      minMoveGamesPerBand: per((i) => minMoveGames[i] ?? 0),
      minMoveGamesFloor: MIN_MOVE_GAMES_FLOOR,
      shardByteBudget: SHARD_BYTE_BUDGET,
      plies: BOOK_PLIES,
      skipped: { ...skipped },
      sanFailures: agg.sanFailures,
      compressedBytes: status.offset,
      reconnects: status.reconnects,
      highRatedGames: highRated,
      clockedGames: clocked,
      tailsRejoined,
      complete,
      partialReason,
      filters: FILTERS_DOC,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(OPENINGS_CACHE, 'book-meta.json'), JSON.stringify(meta, null, 1));
    return meta;
  };

  const lines = resumableZstUrlLines(url, status, { log });
  for await (const game of gamesFromLines(lines, () => clocked < 200)) {
    streamed++;
    const h = game.headers;
    if (clocked < 200 && game.raw && game.movetext.includes('%clk')) {
      fs.appendFileSync(CLOCKED_PATH, game.raw + '\n');
      clocked++;
    }
    const we = Number(h.WhiteElo);
    const be = Number(h.BlackElo);
    const res = h.Result === '1-0' ? 0 : h.Result === '1/2-1/2' ? 1 : h.Result === '0-1' ? 2 : -1;
    const tc = parseTimeControl(h.TimeControl);
    if (!Number.isFinite(we) || !Number.isFinite(be) || we <= 0 || be <= 0) skipped.missingElo = (skipped.missingElo ?? 0) + 1;
    else if ((h.Variant && h.Variant !== 'Standard') || h.FEN || h.SetUp) skipped.variantOrFen = (skipped.variantOrFen ?? 0) + 1;
    else if (h.Termination !== 'Normal' && h.Termination !== 'Time forfeit') skipped.termination = (skipped.termination ?? 0) + 1;
    else if (res < 0) skipped.noResult = (skipped.noResult ?? 0) + 1;
    else {
      const wantHigh = highRated < 8000 && we >= 2200 && be >= 2200 && tc !== null && tc.base >= 180 && h.Termination === 'Normal';
      const bookOk = tc !== null && tc.estimated >= 180;
      if (!bookOk) skipped.tooFast = (skipped.tooFast ?? 0) + 1;
      if (bookOk || wantHigh) {
        const sans = sanTokens(game.movetext, wantHigh ? Infinity : BOOK_PLIES);
        if (bookOk) {
          if (sans.length < 2) skipped.tooShort = (skipped.tooShort ?? 0) + 1;
          else agg.add(sans, bandIndex((we + be) / 2), res as 0 | 1 | 2);
        }
        if (wantHigh && sans.length >= 50) {
          const rec = { id: gameIdOf(h.Site), white: h.White ?? '', black: h.Black ?? '', whiteElo: we, blackElo: be, tc: h.TimeControl ?? '', result: h.Result ?? '', moves: sans };
          fs.appendFileSync(HIGHRATED_PATH, JSON.stringify(rec) + '\n');
          highRated++;
        }
      }
    }
    if (streamed % 20000 === 0) {
      const mem = process.memoryUsage();
      log(
        `[book] ${streamed} games streamed, ${agg.gamesPerBand.join('/')} aggregated, ${agg.nodes.size} positions, ${agg.edgeCount} edges, ` +
          `${(status.offset / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)}s, highRated ${highRated}, heap ${(mem.heapUsed / 1e6).toFixed(0)} MB`,
      );
    }
    if (streamed % 100000 === 0) {
      const m = writeCheckpoint(false, null, null);
      log(`[book] checkpoint at ${streamed}: positions ${JSON.stringify(m.positionsPerBand)} thresholds ${JSON.stringify(m.minMoveGamesPerBand)}`);
    }
    if (streamed >= opts.games) break;
  }
  const complete = streamed >= opts.games || status.finished;
  if (!complete) log(`[book] stream ended early at ${streamed} games: ${status.failed ?? 'unknown reason'}`);
  const tReplay = Date.now();
  const rejoined = agg.finalizeTails();
  log(`[book] replayed parked tails: ${rejoined} re-joined known positions (${Math.round((Date.now() - tReplay) / 1000)}s)`);
  const meta = writeCheckpoint(complete, rejoined, complete ? null : (status.failed ?? 'stream ended early'));
  log(`[book] done: ${JSON.stringify(meta)}`);
  return meta;
}
