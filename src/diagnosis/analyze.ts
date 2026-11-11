/**
 * Game analysis: per-ply evaluations, centipawn loss and mistake classification.
 *
 * Evaluation sources, per analysed ply: when the game file embeds an evaluation (Lichess server
 * analysis) for BOTH the position before and after the move, those are used; otherwise both come
 * from the injected engine at `depth` (mixing sources inside one ply would turn depth differences
 * into fake losses). Mistakes always get one engine call at the position before (MultiPV, best move,
 * PV, alternatives) and one after the played move (refutation line), even with embedded evals.
 *
 * Conventions: engine / stored scores are from the side to move's point of view; cp loss is computed
 * from the MOVER's point of view with mate scores folded to +-MATE_CAP and other scores clamped to
 * the same cap, so a missed mate never counts as more than MATE_CAP. A move the engine itself rates
 * best is never a mistake, whatever the score noise.
 */
import { Chess } from 'chess.js';
import { playLine, sanLine } from '../engine/chessUtil';
import { classifyMistake, type DetectedMotif, type MistakeContext } from '../engine/motifs';
import type { Engine, EngineLine } from '../engine/stockfish';
import type { ImportedGame } from '../importers/types';
import { plyClocks } from './time';
import type { DetectorCoverage, EvalSource, GameAnalysis, Mistake, PlyEval } from './types';

export const MATE_CAP = 1500;
export const MISTAKE_CP = 150;
/** Engine moves within this margin of the best are accepted as alternatives in exercises. */
export const ALT_MARGIN_CP = 50;
export const DEFAULT_DEPTH = 12;
const MISTAKE_MULTIPV = 3;

/** Side-to-move point-of-view score; mate 0 = the side to move is checkmated. */
export interface Score {
  cp: number | null;
  mate: number | null;
}

/** Folds a side-to-move score into [-MATE_CAP, MATE_CAP]. */
export function foldScore(s: Score): number {
  if (s.mate !== null) return s.mate > 0 ? MATE_CAP : -MATE_CAP;
  return Math.max(-MATE_CAP, Math.min(MATE_CAP, s.cp ?? 0));
}

export function negate(s: Score): Score {
  return { cp: s.cp === null ? null : -s.cp, mate: s.mate === null ? null : -s.mate };
}

/** Score for positions where the game is over (no engine needed); null otherwise. */
export function terminalScore(fen: string): Score | null {
  let c: Chess;
  try {
    c = new Chess(fen);
  } catch {
    return null;
  }
  if (c.isCheckmate()) return { cp: null, mate: 0 };
  if (c.isStalemate() || c.isInsufficientMaterial()) return { cp: 0, mate: null };
  return null;
}

/** Maps a primary motif theme to the detector that produced it (see DETECTOR_NAMES). */
export function detectorOf(m: DetectedMotif): string {
  if (/^mateIn\d$/.test(m.theme)) return 'mateInN';
  if (m.theme === 'backRankMate') return 'backRank';
  if (['hangingPiece', 'fork', 'pin', 'skewer', 'discoveredAttack'].includes(m.theme)) return m.theme;
  return 'strategicFeature';
}

export interface AnalyseProgress {
  done: number;
  total: number;
  ply: number;
  /** The analysis so far (moves and mistakes up to `ply`). */
  partial: GameAnalysis;
}

export interface AnalyseOptions {
  depth?: number;
  onProgress?: (p: AnalyseProgress) => void;
  signal?: AbortSignal;
  /** Timestamp for analysedAt (pure logic takes `now` as a parameter). */
  now?: number;
}

function abortError(): Error {
  const e = new Error('Analysis cancelled');
  e.name = 'AbortError';
  return e;
}

function mateFor(s: Score): number | null {
  return s.mate !== null && s.mate > 0 ? s.mate : null;
}

export async function analyseGame(game: ImportedGame, engine: Engine, opts: AnalyseOptions = {}): Promise<GameAnalysis> {
  const depth = opts.depth ?? DEFAULT_DEPTH;
  const n = game.moves.length;
  // Position k = before move k (0-based); position n = after the last move.
  const fens: string[] = game.moves.map((m) => m.fenBefore);
  const last = game.moves[n - 1];
  if (last) {
    const after = playLine(last.fenBefore, [last.uci]);
    fens.push(after ? after.chess.fen() : last.fenBefore);
  }
  const plies: number[] = [];
  for (let i = 0; i < n; i++) {
    const color = game.moves[i]!.fenBefore.split(' ')[1] === 'b' ? 'b' : 'w';
    if (game.userColor === null || game.userColor === color) plies.push(i);
  }

  const engineCache = new Map<number, Score | null>();
  const evalSources = { embedded: 0, engine: 0 };
  const embeddedUsed = new Set<number>();
  const engineScore = async (k: number): Promise<Score | null> => {
    if (engineCache.has(k)) return engineCache.get(k)!;
    const fen = fens[k]!;
    let s = terminalScore(fen);
    if (!s) {
      const lines = await engine.analyse(fen, { depth });
      const l = lines[0];
      s = l ? { cp: l.cp, mate: l.mate } : null;
      if (s) evalSources.engine++;
    }
    engineCache.set(k, s);
    return s;
  };
  /** Embedded eval of position k, converted to side-to-move POV; null when absent. */
  const embeddedScore = (k: number): Score | null => {
    const fen = fens[k]!;
    const t = terminalScore(fen);
    if (t) return t;
    const e = k >= 1 ? game.moves[k - 1]!.embeddedEval : null;
    if (!e || (e.cp === null && e.mate === null)) return null;
    const white: Score = { cp: e.cp, mate: e.mate };
    return fen.split(' ')[1] === 'b' ? negate(white) : white;
  };

  const clocks = plyClocks(game);
  const moves: PlyEval[] = [];
  const mistakes: Mistake[] = [];
  const graph: (number | null)[] = new Array<number | null>(fens.length).fill(null);
  const coverage: DetectorCoverage = { mistakes: 0, classified: 0, byDetector: {} };
  const result = (): GameAnalysis => ({
    gameId: game.id,
    depth,
    userColor: game.userColor,
    moves: [...moves],
    mistakes: [...mistakes],
    coverage: { ...coverage, byDetector: { ...coverage.byDetector } },
    graph: [...graph],
    evalSources: { ...evalSources },
    analysedAt: opts.now ?? 0,
  });
  const setGraph = (k: number, s: Score): void => {
    const v = foldScore(s);
    graph[k] = fens[k]!.split(' ')[1] === 'b' ? -v : v;
  };

  let done = 0;
  for (const i of plies) {
    if (opts.signal?.aborted) throw abortError();
    const mv = game.moves[i]!;
    const color: 'w' | 'b' = mv.fenBefore.split(' ')[1] === 'b' ? 'b' : 'w';
    let before = embeddedScore(i);
    let after = embeddedScore(i + 1);
    let source: EvalSource = 'embedded';
    // A position before a move is never terminal, so `before` is non-null only with embedded data;
    // `after` may be an exact game-over score (mate / stalemate), which is not an estimate.
    if (before && after) {
      embeddedUsed.add(i);
      if (game.moves[i]!.embeddedEval) embeddedUsed.add(i + 1);
      evalSources.embedded = embeddedUsed.size;
    } else {
      source = 'engine';
      before = await engineScore(i);
      after = await engineScore(i + 1);
    }
    if (opts.signal?.aborted) throw abortError();
    if (!before || !after) {
      done++;
      continue;
    }
    setGraph(i, before);
    setGraph(i + 1, after);
    const evalBeforeCp = foldScore(before);
    const evalAfterCp = -foldScore(after);
    const cpLoss = Math.max(0, evalBeforeCp - evalAfterCp);
    const c = clocks[i];
    const ply: PlyEval = {
      ply: i + 1,
      color,
      san: mv.san,
      uci: mv.uci,
      evalBeforeCp,
      evalAfterCp,
      cpLoss,
      mateBefore: mateFor(before),
      mateAfter: mateFor(after),
      clockMs: mv.clockMs,
      timeSpentMs: c?.timeSpentMs ?? null,
      source,
    };
    moves.push(ply);

    if (cpLoss >= MISTAKE_CP) {
      const m = await buildMistake(engine, depth, mv.fenBefore, fens[i + 1]!, ply);
      if (m) {
        mistakes.push(m);
        coverage.mistakes++;
        if (m.primary) {
          coverage.classified++;
          const d = detectorOf(m.primary);
          coverage.byDetector[d] = (coverage.byDetector[d] ?? 0) + 1;
        }
      }
    }
    done++;
    opts.onProgress?.({ done, total: plies.length, ply: i + 1, partial: result() });
  }
  return result();
}

/** Engine lines for the mistake, then the rule-based classification. Null when the engine prefers the played move. */
async function buildMistake(engine: Engine, depth: number, fen: string, fenAfter: string, p: PlyEval): Promise<Mistake | null> {
  const lines: EngineLine[] = await engine.analyse(fen, { depth, multipv: MISTAKE_MULTIPV });
  const best = lines[0];
  if (!best || best.pv.length === 0) return null;
  const bestUci = best.pv[0]!;
  if (bestUci === p.uci) return null;
  const terminalAfter = terminalScore(fenAfter);
  const refutation = terminalAfter ? [] : ((await engine.analyse(fenAfter, { depth }))[0]?.pv ?? []);
  const bestFold = foldScore(best);
  const alternatives = lines
    .slice(1)
    .filter((l) => l.pv[0] && l.pv[0] !== p.uci && bestFold - foldScore(l) <= ALT_MARGIN_CP)
    .map((l) => l.pv[0]!);
  const ctx: MistakeContext = {
    fen,
    playedUci: p.uci,
    bestUci,
    bestPv: best.pv,
    refutationPv: refutation,
    evalBeforeCp: p.evalBeforeCp,
    evalAfterCp: p.evalAfterCp,
    mateBefore: p.mateBefore ?? (best.mate !== null && best.mate > 0 ? best.mate : null),
    mateAfter: p.mateAfter,
  };
  const cls = classifyMistake(ctx);
  const bestPvSan = sanLine(fen, best.pv);
  return {
    ply: p.ply,
    color: p.color,
    fen,
    played: p.uci,
    playedSan: p.san,
    best: bestUci,
    bestSan: bestPvSan[0] ?? bestUci,
    bestPv: best.pv,
    bestPvSan,
    refutationPv: refutation,
    refutationPvSan: sanLine(fenAfter, refutation),
    alternatives,
    evalBeforeCp: p.evalBeforeCp,
    evalAfterCp: p.evalAfterCp,
    cpLoss: p.cpLoss,
    mateBefore: ctx.mateBefore,
    mateAfter: p.mateAfter,
    bestLine: { cp: best.cp, mate: best.mate, depth: best.depth },
    motifs: cls.motifs,
    primary: cls.primary,
    conceptId: cls.primary?.conceptId ?? null,
    unclassified: cls.unclassified,
    clockMs: p.clockMs,
    timeSpentMs: p.timeSpentMs,
    source: p.source,
  };
}

/** Runs analyses one game at a time; `cancel()` aborts the current game and drops the rest. */
export class AnalysisQueue {
  private controller: AbortController | null = null;
  private cancelled = false;

  constructor(
    private readonly engine: Engine,
    private readonly opts: { depth?: number; now?: () => number } = {},
  ) {}

  async run(
    games: ImportedGame[],
    cb: {
      onGameStart?: (g: ImportedGame, index: number) => void;
      onProgress?: (g: ImportedGame, p: AnalyseProgress) => void;
      onGameDone?: (g: ImportedGame, a: GameAnalysis) => void | Promise<void>;
      onError?: (g: ImportedGame, e: Error) => void;
    } = {},
  ): Promise<GameAnalysis[]> {
    this.cancelled = false;
    const out: GameAnalysis[] = [];
    for (let i = 0; i < games.length; i++) {
      if (this.cancelled) break;
      const g = games[i]!;
      this.controller = new AbortController();
      cb.onGameStart?.(g, i);
      try {
        const a = await analyseGame(g, this.engine, {
          depth: this.opts.depth,
          signal: this.controller.signal,
          now: this.opts.now?.(),
          onProgress: (p) => cb.onProgress?.(g, p),
        });
        out.push(a);
        await cb.onGameDone?.(g, a);
      } catch (e) {
        if ((e as Error).name === 'AbortError') break;
        cb.onError?.(g, e as Error);
      }
    }
    this.controller = null;
    return out;
  }

  cancel(): void {
    this.cancelled = true;
    this.controller?.abort();
  }

  get running(): boolean {
    return this.controller !== null;
  }
}
