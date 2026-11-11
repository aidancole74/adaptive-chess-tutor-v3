/** Feeds learner-dependent context into providers before a session (opponent strength, speed, weak concepts, game positions). */
import { getDb } from '../model/db';
import { estimate, weakness } from '../model/learner';
import type { LearnerState } from '../model/types';
import type { Settings } from '../model/settings';
import type { ImportedGame } from '../importers/types';
import type { GameAnalysis } from '../diagnosis/types';
import { HOLD_RANGE, CONVERT_MIN_CP, type EvalPosition } from './providers/process';
import { getProcess } from './registry';

/** Median solve time (s) of solved tactics within ±150 of a rating, or null with fewer than 5 samples. */
export function speedAt(state: LearnerState, rating: number): number | null {
  const ts = state.history
    .filter((h) => h.solved && h.domain === 'tactics' && Math.abs(h.difficulty - rating) <= 150)
    .map((h) => h.timeMs / 1000)
    .sort((a, b) => a - b);
  return ts.length >= 5 ? ts[Math.floor(ts.length / 2)]! : null;
}

export function gamePositions(games: { id: string; game: ImportedGame; analysis?: GameAnalysis }[]): EvalPosition[] {
  const out: EvalPosition[] = [];
  for (const g of games) {
    if (!g.analysis || !g.game?.moves) continue;
    let last = -10;
    for (const pe of g.analysis.moves) {
      if (g.game.userColor && pe.color !== g.game.userColor) continue;
      const cp = pe.evalBeforeCp;
      const usable = (cp >= CONVERT_MIN_CP && cp < 1200) || (cp >= HOLD_RANGE[0] && cp <= HOLD_RANGE[1]);
      if (!usable || pe.ply - last < 8) continue;
      const fen = g.game.moves[pe.ply - 1]?.fenBefore;
      if (!fen) continue;
      last = pe.ply;
      out.push({ id: `${g.id}:${pe.ply}`, fen, cp, source: `your game ${g.game.white} – ${g.game.black}, move ${Math.ceil(pe.ply / 2)}`, url: g.game.url });
    }
  }
  return out;
}

export async function prepareProviders(state: LearnerState, settings: Settings): Promise<void> {
  const p = getProcess();
  const now = Date.now();
  p.setOpponentElo(Math.max(400, estimate(state, '', now).theta + settings.sparringOffset));
  p.setSpeed((r) => speedAt(state, r));
  p.setWeakConcepts(() =>
    Object.keys(state.nodes)
      .filter((id) => id.split('/').length === 3 && (state.nodes[id]?.n ?? 0) >= 3)
      .map((id) => ({ id, gap: weakness(state, id, now).gap }))
      .sort((a, b) => b.gap - a.gap)
      .slice(0, 5)
      .map((x) => x.id),
  );
  try {
    const rows = await getDb().games.toArray();
    p.setGamePositions(gamePositions(rows.map((r) => ({ id: r.id, game: r.game as ImportedGame, analysis: r.analysis as GameAnalysis | undefined }))));
  } catch {
    /* no stored games */
  }
}
