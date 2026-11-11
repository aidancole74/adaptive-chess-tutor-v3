/**
 * Exercises from the user's own games: "spot the mistake" (replay the position before a classified
 * mistake and find the engine's move) and pairing with pack puzzles of the same concept.
 * Every fact comes from the engine analysis or the detectors; nothing is written by hand.
 */
import type { TacticsProvider } from '../content/providers/tactics';
import { CONCEPT_BY_ID, TIER_MID, conceptName, domainOf } from '../curriculum/concepts';
import { epdOf, materialSignature, phaseOf, playLine } from '../engine/chessUtil';
import type { Exercise, Fact } from '../exercises/types';
import { buildSolve } from '../exercises/tactics';
import type { ImportedGame } from '../importers/types';
import type { Mistake } from './types';

/**
 * Difficulty prior (rating scale) for a spot-the-mistake exercise. Starts from the concept tier's
 * difficulty prior (TIER_MID) and shifts it by how much the move lost: a 150 cp slip is subtle
 * (+100), a loss of 1150 cp or more is glaring (-100), linear in between. This is a prior only
 * ('tier-prior'); the learner model refines it from results.
 */
export function spotMistakeDifficulty(conceptId: string, cpLoss: number): number {
  const tier = CONCEPT_BY_ID.get(conceptId)?.tier ?? 2;
  const base = TIER_MID[Math.max(0, Math.min(TIER_MID.length - 1, tier))]!;
  const shift = 100 - Math.min(200, Math.max(0, (cpLoss - 150) / 5));
  return Math.round(base + shift);
}

function moveLabel(ply: number): string {
  const n = Math.ceil(ply / 2);
  return ply % 2 === 1 ? `${n}.` : `${n}...`;
}

/** Game url pointing at the ply where the platform supports it (Lichess "#ply"). */
function plyUrl(game: ImportedGame, ply: number): string | undefined {
  if (!game.url) return undefined;
  return game.source === 'lichess' || game.id.startsWith('lichess:') ? `${game.url}#${ply}` : game.url;
}

/**
 * Builds a spot-the-mistake exercise, or null for unclassified mistakes (no verified concept to
 * attach it to) and for positions the engine lines do not replay legally.
 */
export function buildSpotMistake(game: ImportedGame, mistake: Mistake): Exercise | null {
  const conceptId = mistake.conceptId;
  if (!conceptId || mistake.unclassified || !CONCEPT_BY_ID.has(conceptId)) return null;
  if (!playLine(mistake.fen, [mistake.best]) || !playLine(mistake.fen, [mistake.played])) return null;
  const after = playLine(mistake.fen, [mistake.played])!.chess.fen();
  const alternatives = mistake.alternatives.filter((u) => u !== mistake.best && u !== mistake.played && playLine(mistake.fen, [u]));
  const secondary = [...new Set(mistake.motifs.map((m) => m.conceptId))].filter((c) => c !== conceptId && CONCEPT_BY_ID.has(c));
  const facts: Fact[] = [
    { t: 'engine', fen: mistake.fen, pvSan: mistake.bestPvSan, cp: mistake.bestLine.cp, mate: mistake.bestLine.mate, depth: mistake.bestLine.depth },
  ];
  if (mistake.refutationPvSan.length > 0) {
    // After the played move the opponent is to move: their point of view is the negation of the mover's.
    facts.push({
      t: 'engine',
      fen: after,
      pvSan: mistake.refutationPvSan,
      cp: mistake.mateAfter !== null ? null : -mistake.evalAfterCp,
      mate: mistake.mateAfter,
      depth: mistake.bestLine.depth,
    });
  }
  for (const m of mistake.motifs) {
    if (m.conceptId.startsWith('tactics/')) {
      facts.push({ t: 'motif', name: `${conceptName(m.conceptId)} (${m.kind === 'missed' ? 'you missed it' : 'your move allowed it'})`, squares: m.squares });
    } else {
      const side = m.kind === 'missed' ? mistake.color : mistake.color === 'w' ? 'b' : 'w';
      facts.push({ t: 'feature', name: m.theme, side, detail: m.detail, heuristic: true });
    }
  }
  const opp = mistake.color === 'w' ? game.black : game.white;
  facts.push({ t: 'source', label: `Your game against ${opp}, move ${moveLabel(mistake.ply)}`, url: plyUrl(game, mistake.ply) });
  facts.push({ t: 'note', text: `Your move ${mistake.playedSan} lost about ${(mistake.cpLoss / 100).toFixed(1)} pawns of evaluation (engine, depth ${mistake.bestLine.depth}).` });
  const id = `spot:${game.id}:${mistake.ply}`;
  return {
    id,
    itemId: id,
    domain: domainOf(conceptId),
    conceptId,
    secondaryConcepts: secondary.length ? secondary : undefined,
    format: 'spot-mistake',
    difficulty: spotMistakeDifficulty(conceptId, mistake.cpLoss),
    difficultySource: 'tier-prior',
    sim: { themes: mistake.motifs.map((m) => m.theme), material: materialSignature(mistake.fen), sourceGame: game.id },
    phase: phaseOf(mistake.fen),
    color: mistake.color,
    verified: true,
    prompt: `You played ${moveLabel(mistake.ply)} ${mistake.playedSan} here. Find the better move.`,
    interaction: {
      kind: 'line',
      fen: mistake.fen,
      orientation: mistake.color === 'w' ? 'white' : 'black',
      preMoves: [],
      solution: [mistake.best],
      alternatives: alternatives.length ? { 0: alternatives } : undefined,
      acceptAnyMate: mistake.mateBefore === 1,
    },
    facts,
    timeBudgetSec: 60,
  };
}

/**
 * Up to `k` pack puzzles for the mistake's concept, nearest to `rating`. Puzzles taken from the same
 * game are excluded by position: the tactics pack does not carry the puzzle's source game id, so any
 * puzzle whose start position (EPD) occurs in `gameFens` is dropped.
 */
export function pairSimilar(
  mistake: Pick<Mistake, 'conceptId'>,
  tactics: Pick<TacticsProvider, 'itemsFor'>,
  k: number,
  opts: { rating: number; gameFens?: string[] },
): Exercise[] {
  if (!mistake.conceptId || k <= 0) return [];
  const exclude = new Set((opts.gameFens ?? []).map(epdOf));
  const items = tactics
    .itemsFor(mistake.conceptId)
    .filter((it) => !exclude.has(epdOf(it.fen)))
    .map((it) => ({ it, d: Math.abs(it.rating - opts.rating) }))
    .sort((a, b) => a.d - b.d || (a.it.id < b.it.id ? -1 : 1));
  const out: Exercise[] = [];
  for (const { it } of items) {
    if (out.length >= k) break;
    try {
      out.push(buildSolve(it));
    } catch {
      /* item without a legal line or mapped concept: skip */
    }
  }
  return out;
}
