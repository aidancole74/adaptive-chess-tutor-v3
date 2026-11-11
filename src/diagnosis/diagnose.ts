/**
 * Cross-game diagnosis: which concepts the user misses RELATIVE TO HOW OFTEN THEY CAME UP.
 *
 * Opportunities (tactical concepts): a position where the engine's best move shows the motif per the
 * rule-based detectors run on the best line (`motifsOnBestLine`). Every mistake position has its best
 * line already; for non-mistake positions we sample `sampleSize` user positions per game and need the
 * engine's best line there. Cost: when the game's evals came from the engine, the PV of the position
 * before the move is already in the engine client's FEN cache, so sampling is free; for games with
 * embedded (Lichess) evals each sampled position costs one depth-12 search (~0.1-0.5 s in the browser
 * WASM build). Opportunities in non-mistake positions are then scaled up by (non-mistake moves /
 * sampled moves) - an ESTIMATE, reported with the sample size.
 *
 * Misses: mistakes whose detected motifs include the concept as 'missed'. Allowed motifs (the move let
 * the opponent do something) are normalised per 100 analysed moves instead, since every move is a
 * chance to blunder. Raw counts are reported for transparency but never used as the weakness score.
 */
import { CONCEPT_BY_ID, TACTIC_THEME_TO_CONCEPT } from '../curriculum/concepts';
import type { ErrorCause } from '../exercises/types';
import { detectBackRank, detectDiscoveredAttack, detectFork, detectHangingPiece, detectPin, detectSkewer } from '../engine/motifs';
import type { Engine } from '../engine/stockfish';
import type { ImportedGame } from '../importers/types';
import { DEFAULT_DEPTH, MISTAKE_CP, detectorOf } from './analyze';
import { inferCause, plyClocks, timeInfoFor } from './time';
import type { GameAnalysis } from './types';

/** Tactical concepts detected on the engine's best line from `fen` (mover = side to move). */
export function motifsOnBestLine(fen: string, pv: string[], mateForMover: number | null): string[] {
  const themes: string[] = [];
  if (mateForMover !== null && mateForMover > 0) themes.push(`mateIn${Math.min(5, mateForMover)}`);
  const key = pv[0];
  const hits = [
    detectBackRank(fen, pv),
    detectHangingPiece(fen, key),
    detectFork(fen, key),
    detectPin(fen, key),
    detectSkewer(fen, key),
    detectDiscoveredAttack(fen, key),
  ];
  for (const h of hits) if (h) themes.push(h.theme);
  const out: string[] = [];
  for (const t of themes) {
    const c = TACTIC_THEME_TO_CONCEPT.get(t);
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

export interface OpportunitySample {
  gameId: string;
  /** Non-mistake analysed moves in the game, and how many of them were sampled. */
  nonMistakeMoves: number;
  sampled: number;
  /** Concept -> sampled non-mistake positions whose best line showed it. */
  hits: Record<string, number>;
}

/**
 * Samples non-mistake user positions and runs the detectors on the engine's best line there.
 * `rng` is injected for determinism.
 */
export async function sampleOpportunities(
  game: ImportedGame,
  analysis: GameAnalysis,
  engine: Engine,
  opts: { sampleSize?: number; rng: () => number; depth?: number; signal?: AbortSignal },
): Promise<OpportunitySample> {
  const pool = analysis.moves.filter((p) => p.cpLoss < MISTAKE_CP);
  const k = Math.min(pool.length, opts.sampleSize ?? 8);
  const picked = [...pool];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(opts.rng() * (picked.length - i));
    [picked[i], picked[j]] = [picked[j]!, picked[i]!];
  }
  const hits: Record<string, number> = {};
  let sampled = 0;
  for (const p of picked.slice(0, k)) {
    if (opts.signal?.aborted) break;
    const fen = game.moves[p.ply - 1]?.fenBefore;
    if (!fen) continue;
    const line = (await engine.analyse(fen, { depth: opts.depth ?? analysis.depth ?? DEFAULT_DEPTH }))[0];
    if (!line || line.pv.length === 0) continue;
    sampled++;
    for (const c of motifsOnBestLine(fen, line.pv, line.mate !== null && line.mate > 0 ? line.mate : null)) hits[c] = (hits[c] ?? 0) + 1;
  }
  return { gameId: game.id, nonMistakeMoves: pool.length, sampled, hits };
}

export interface ConceptStat {
  conceptId: string;
  /** Estimated opportunities (mistake positions exactly + scaled non-mistake sample). */
  opportunities: number;
  misses: number;
  /** misses / opportunities; null below MIN_OPPORTUNITIES. */
  missRate: number | null;
  /** Mistakes whose primary motif was this concept as 'allowed'. */
  allowed: number;
  allowedPer100Moves: number;
  /** Mistakes with this concept as their primary motif (any kind). */
  primaryMistakes: number;
}

export interface Diagnosis {
  games: number;
  movesAnalysed: number;
  mistakes: number;
  concepts: ConceptStat[];
  /** Concepts ordered by weakness (miss rate, then allowed rate). */
  weakest: string[];
  causes: Record<ErrorCause | 'unknown', number>;
  coverage: { mistakes: number; classified: number; byDetector: Record<string, number> };
  opportunitySample: { sampled: number; nonMistakeMoves: number };
}

export const MIN_OPPORTUNITIES = 3;

export function diagnose(items: { game: ImportedGame; analysis: GameAnalysis }[], samples: OpportunitySample[] = []): Diagnosis {
  const stats = new Map<string, ConceptStat & { exactOpp: number; sampledOpp: number }>();
  const stat = (id: string): ConceptStat & { exactOpp: number; sampledOpp: number } => {
    let s = stats.get(id);
    if (!s) stats.set(id, (s = { conceptId: id, opportunities: 0, misses: 0, missRate: null, allowed: 0, allowedPer100Moves: 0, primaryMistakes: 0, exactOpp: 0, sampledOpp: 0 }));
    return s;
  };
  const causes: Diagnosis['causes'] = { knowledge: 0, vision: 0, calculation: 0, time: 0, discipline: 0, unknown: 0 };
  const coverage = { mistakes: 0, classified: 0, byDetector: {} as Record<string, number> };
  let movesAnalysed = 0;

  for (const { game, analysis } of items) {
    movesAnalysed += analysis.moves.length;
    const clocks = plyClocks(game);
    for (const m of analysis.mistakes) {
      coverage.mistakes++;
      if (m.primary) {
        coverage.classified++;
        const d = detectorOf(m.primary);
        coverage.byDetector[d] = (coverage.byDetector[d] ?? 0) + 1;
        stat(m.primary.conceptId).primaryMistakes++;
        if (m.primary.kind === 'allowed') stat(m.primary.conceptId).allowed++;
      }
      for (const c of motifsOnBestLine(m.fen, m.bestPv, m.mateBefore)) stat(c).exactOpp++;
      const missed = new Set(m.motifs.filter((x) => x.kind === 'missed').map((x) => x.conceptId));
      for (const c of missed) stat(c).misses++;
      causes[inferCause(m, timeInfoFor(game, m.ply, clocks)) ?? 'unknown']++;
    }
  }
  let sampled = 0;
  let nonMistakeMoves = 0;
  for (const s of samples) {
    sampled += s.sampled;
    nonMistakeMoves += s.nonMistakeMoves;
    const scale = s.sampled > 0 ? s.nonMistakeMoves / s.sampled : 0;
    for (const [c, n] of Object.entries(s.hits)) stat(c).sampledOpp += n * scale;
  }
  for (const s of stats.values()) {
    // A miss is always an opportunity, even if the best-line detectors did not fire on it.
    s.opportunities = Math.round((Math.max(s.exactOpp, s.misses) + s.sampledOpp) * 10) / 10;
    s.missRate = s.opportunities >= MIN_OPPORTUNITIES ? s.misses / s.opportunities : null;
    s.allowedPer100Moves = movesAnalysed > 0 ? (100 * s.allowed) / movesAnalysed : 0;
  }
  const concepts: ConceptStat[] = [...stats.values()]
    .filter((s) => CONCEPT_BY_ID.has(s.conceptId))
    .map(({ exactOpp: _e, sampledOpp: _s, ...rest }) => rest);
  const weakest = [...concepts]
    .filter((c) => c.missRate !== null || c.allowed > 0)
    .sort((a, b) => (b.missRate ?? 0) - (a.missRate ?? 0) || b.allowedPer100Moves - a.allowedPer100Moves)
    .map((c) => c.conceptId);
  return {
    games: items.length,
    movesAnalysed,
    mistakes: coverage.mistakes,
    concepts,
    weakest,
    causes,
    coverage,
    opportunitySample: { sampled, nonMistakeMoves },
  };
}

/**
 * Rough starting rating for the learner model from the user's game ratings: the median of the
 * ratings the user had in their imported games, with sigma shrinking with the number of games
 * (350 / sqrt(n) + 100, clamped to [150, 350]). Game ratings are NOT the puzzle-rating scale and
 * Chess.com and Lichess pools differ, so this is only a prior that placement and practice correct.
 */
export function seedFromGames(games: Pick<ImportedGame, 'userColor' | 'whiteElo' | 'blackElo'>[]): { rating: number; sigma: number; count: number } | null {
  const ratings: number[] = [];
  for (const g of games) {
    const r = g.userColor === 'w' ? g.whiteElo : g.userColor === 'b' ? g.blackElo : undefined;
    if (typeof r === 'number' && r > 0) ratings.push(r);
  }
  if (ratings.length === 0) return null;
  ratings.sort((a, b) => a - b);
  const mid = ratings.length >> 1;
  const median = ratings.length % 2 ? ratings[mid]! : (ratings[mid - 1]! + ratings[mid]!) / 2;
  const sigma = Math.max(150, Math.min(350, 350 / Math.sqrt(ratings.length) + 100));
  return { rating: Math.round(median), sigma: Math.round(sigma), count: ratings.length };
}
