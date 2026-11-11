/**
 * Strategy position bank: quiet middlegame positions from real >= 2200 Lichess games, labelled by Stockfish.
 *
 *   npm run data:strategy -- [--positions 3000] [--depth 14] [--workers 8] [--games N] [--per-game 12] [--assemble-only]
 *
 * 1. Reads .cache/highrated-games.ndjson (written by the openings pipeline; read as far as it currently goes).
 * 2. Samples up to --per-game positions per game from plies 16..60, one per equal segment of the range, with a
 *    seeded RNG keyed by the game id (deterministic). Skips positions in check / game over and duplicate EPDs.
 * 3. Writes the task list to .cache/strategy-tasks.json and starts --workers child processes
 *    (scripts/strategy/worker.ts), each with its own single-threaded Stockfish. Results are checkpointed to
 *    .cache/strategy-w<i>.ndjson, so a rerun resumes. Workers are stopped once --positions items are kept.
 * 4. Assembles kept items (dedup by EPD, game order) into public/packs/strategy/strategy-NNN.json shards of 500.
 * Selection rules and the tier heuristic are documented in ./analyse.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { Chess } from 'chess.js';
import { arg, CACHE, ensureDir, ROOT, writePack } from '../lib/pack';
import { epdOf } from '../../src/engine/chessUtil';
import { mulberry32 } from '../../src/model/math';
import { FEATURE_TO_CONCEPT, parseFeatureDelta } from '../../src/engine/features';
import { conceptsForStrategyItem } from '../../src/content/strategy';
import type { StrategyItem } from '../../src/content/types';
import { MARGIN_CP, MAX_ABS_CP, MULTIPV, PRE_DEPTH, PRE_MARGIN_CP, PRE_MAX_ABS_CP, QUIET_PLIES, type Task, type TaskResult } from './analyse';
import { checkpointFiles } from './worker';

const GAMES_FILE = path.join(CACHE, 'highrated-games.ndjson');
const TASK_FILE = path.join(CACHE, 'strategy-tasks.json');
const MIN_PLY = 16;
const MAX_PLY = 60;
const SHARD_SIZE = 500;

interface Game {
  id: string;
  whiteElo: number;
  blackElo: number;
  moves: string[];
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Plies to sample from one game: one per equal segment of [16, min(60, last ply - 2)]. */
export function samplePlies(gameId: string, nMoves: number, perGame: number): number[] {
  const lo = MIN_PLY;
  const hi = Math.min(MAX_PLY, nMoves - 2);
  if (hi < lo) return [];
  const rng = mulberry32(hash(gameId));
  const span = hi - lo + 1;
  const k = Math.min(perGame, span);
  const out: number[] = [];
  for (let i = 0; i < k; i++) {
    const a = lo + Math.floor((i * span) / k);
    const b = lo + Math.floor(((i + 1) * span) / k) - 1;
    out.push(a + Math.floor(rng() * (b - a + 1)));
  }
  return out;
}

function readGames(limit: number): Game[] {
  const games: Game[] = [];
  const text = fs.readFileSync(GAMES_FILE, 'utf8');
  for (const line of text.split('\n')) {
    if (games.length >= limit) break;
    if (!line.trim()) continue;
    try {
      const g = JSON.parse(line) as Game;
      if (g.id && Array.isArray(g.moves)) games.push(g);
    } catch {
      /* partial last line while the openings pipeline is appending */
    }
  }
  return games;
}

function buildTasks(games: Game[], perGame: number): { tasks: Task[]; sampled: number; skipped: Record<string, number> } {
  const tasks: Task[] = [];
  const seen = new Set<string>();
  const skipped: Record<string, number> = { 'in-check': 0, 'game-over': 0, 'duplicate-epd': 0, 'illegal-replay': 0 };
  let sampled = 0;
  for (const g of games) {
    const plies = new Set(samplePlies(g.id, g.moves.length, perGame));
    if (plies.size === 0) continue;
    const chess = new Chess();
    const maxPly = Math.max(...plies);
    for (let p = 1; p <= maxPly; p++) {
      try {
        chess.move(g.moves[p - 1]!);
      } catch {
        skipped['illegal-replay']!++;
        break;
      }
      if (!plies.has(p)) continue;
      sampled++;
      const fen = chess.fen();
      if (chess.inCheck()) {
        skipped['in-check']!++;
        continue;
      }
      if (chess.isGameOver()) {
        skipped['game-over']!++;
        continue;
      }
      const epd = epdOf(fen);
      if (seen.has(epd)) {
        skipped['duplicate-epd']!++;
        continue;
      }
      seen.add(epd);
      tasks.push({ key: `${g.id}:${p}`, game: g.id, ply: p, fen });
    }
  }
  return { tasks, sampled, skipped };
}

function readResults(): TaskResult[] {
  const out: TaskResult[] = [];
  for (const f of checkpointFiles()) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as TaskResult);
      } catch {
        /* partial line */
      }
    }
  }
  return out;
}

function countKept(): number {
  let n = 0;
  for (const f of checkpointFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    let i = -1;
    while ((i = text.indexOf('"item":', i + 1)) >= 0) n++;
  }
  return n;
}

async function runWorkers(workers: number, depth: number, target: number): Promise<void> {
  const workerPath = path.join(ROOT, 'scripts', 'strategy', 'worker.ts');
  const children: ChildProcess[] = [];
  let alive = 0;
  const finished = new Promise<void>((resolve) => {
    for (let i = 0; i < workers; i++) {
      const c = spawn(process.execPath, ['--import', 'tsx', workerPath, '--shard', String(i), '--of', String(workers), '--depth', String(depth), '--tasks', TASK_FILE], {
        cwd: ROOT,
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      alive++;
      c.on('exit', () => {
        alive--;
        if (alive === 0) resolve();
      });
      children.push(c);
    }
  });
  const t0 = Date.now();
  const timer = setInterval(() => {
    const kept = countKept();
    console.log(`[strategy] ${kept}/${target} kept after ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    if (kept >= target) {
      console.log('[strategy] target reached, stopping workers');
      for (const c of children) c.kill();
    }
  }, 15000);
  await finished;
  clearInterval(timer);
}

function inc(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  const target = Number(arg('positions', '3000'));
  const depth = Number(arg('depth', '14'));
  const workers = Number(arg('workers', '8'));
  const gameLimit = Number(arg('games', String(Number.MAX_SAFE_INTEGER)));
  const perGame = Number(arg('per-game', '12'));
  const assembleOnly = arg('assemble-only') !== undefined;
  ensureDir(CACHE);
  if (!fs.existsSync(GAMES_FILE)) throw new Error(`${GAMES_FILE} missing: run npm run data:openings first`);

  const games = readGames(gameLimit);
  const { tasks, sampled, skipped } = buildTasks(games, perGame);
  console.log(`[strategy] ${games.length} games, ${sampled} positions sampled, ${tasks.length} tasks after pre-filters`);
  fs.writeFileSync(TASK_FILE, JSON.stringify(tasks));

  if (!assembleOnly && countKept() < target) await runWorkers(workers, depth, target);

  // ---- assemble ----
  const order = new Map(tasks.map((t, i) => [t.key, i]));
  const results = readResults();
  const rejections: Record<string, number> = {};
  const byKey = new Map<string, StrategyItem>();
  for (const r of results) {
    if ('reject' in r) inc(rejections, r.reject);
    else byKey.set(r.key, r.item);
  }
  const kept = [...byKey.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 1e12) - (order.get(b[0]) ?? 1e12) || a[0].localeCompare(b[0]))
    .map((e) => e[1]);
  const seen = new Set<string>();
  const items: StrategyItem[] = [];
  for (const it of kept) {
    const epd = epdOf(it.fen);
    if (seen.has(epd)) continue;
    seen.add(epd);
    items.push(it);
  }

  const perPlan: Record<string, number> = {};
  const perStructure: Record<string, number> = {};
  const perConcept: Record<string, number> = {};
  const perDeltaConcept: Record<string, number> = {};
  const perTier: Record<string, number> = {};
  const trades: Record<string, number> = {};
  for (const it of items) {
    inc(perPlan, it.plan);
    inc(perStructure, it.structure);
    inc(perTier, String(it.tier));
    inc(trades, it.trade ? it.trade.verdict : 'none');
    for (const c of conceptsForStrategyItem(it)) inc(perConcept, c);
    const dc = new Set<string>();
    for (const d of it.featureDeltas) {
      const p = parseFeatureDelta(d);
      if (p) dc.add(FEATURE_TO_CONCEPT[p.name]);
    }
    for (const c of dc) inc(perDeltaConcept, c);
  }

  const shards: { file: string; key: string; count: number; data: unknown }[] = [];
  for (let i = 0; i * SHARD_SIZE < items.length; i++) {
    const data = items.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
    const key = String(i).padStart(3, '0');
    shards.push({ file: `strategy-${key}.json`, key, count: data.length, data });
  }
  const analysed = results.length;
  writePack('strategy', 'strategy', {
    version: '1',
    license: 'CC0 (Lichess game database); labels by Stockfish (GPLv3)',
    source: 'Lichess games with both players >= 2200, analysed with Stockfish lite single-threaded WASM',
    meta: {
      gamesRead: games.length,
      positionsSampled: sampled,
      preFilterSkipped: skipped,
      tasks: tasks.length,
      analysed,
      kept: items.length,
      rejections,
      perPlan,
      perStructure,
      perConcept,
      perDeltaConcept,
      perTier,
      trades,
      depth,
      multipv: MULTIPV,
      marginCp: MARGIN_CP,
      maxAbsCp: MAX_ABS_CP,
      quietPlies: QUIET_PLIES,
      prefilter: { depth: PRE_DEPTH, marginCp: PRE_MARGIN_CP, maxAbsCp: PRE_MAX_ABS_CP, multipv: 2 },
      plies: [MIN_PLY, MAX_PLY],
      perGame,
      buildSeconds: Math.round((Date.now() - t0) / 1000),
    },
  }, shards);
  console.log(`[strategy] kept ${items.length} of ${analysed} analysed; rejections ${JSON.stringify(rejections)}`);
  console.log(`[strategy] plans ${JSON.stringify(perPlan)}`);
  console.log(`[strategy] structures ${JSON.stringify(perStructure)}`);
  console.log(`[strategy] concepts ${JSON.stringify(perConcept)}`);
  console.log(`[strategy] done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
