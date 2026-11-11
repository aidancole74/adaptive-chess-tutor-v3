/**
 * Defence & conversion, targeted sparring, and time/process drills.
 * Sources (all verified): positions from the user's analysed games (engine evals), the strategy bank
 * (Stockfish MultiPV), and Lichess puzzles (the opponent's first move is a verified blunder).
 */
import { Chess } from 'chess.js';
import { TIER_MID, primaryTacticConcept } from '../../curriculum/concepts';
import { materialSignature, phaseOf, sanLine, tryMove } from '../../engine/chessUtil';
import type { Exercise, Fact } from '../../exercises/types';
import { buildSolve } from '../../exercises/tactics';
import type { StrategyItem, TacticItem } from '../types';
import { positionAfterFirstMove } from '../tactics';
import type { Provider } from '../pool';
import type { TacticsProvider } from './tactics';

export interface EvalPosition {
  id: string;
  fen: string;
  /** Evaluation from the side to move's point of view. */
  cp: number;
  source: string;
  url?: string;
}

const CONVERT = 'defense/conversion/convert-winning';
const HOLD = 'defense/holding/hold-worse';
const SPAR = 'sparring/play/targeted';
const BLUNDER = 'time/process/blunder-check';
const TIMED = 'time/process/timed-drill';

export const CONVERT_MIN_CP = 250;
export const HOLD_RANGE: [number, number] = [-600, -150];

function base(id: string, conceptId: string, format: Exercise['format'], fen: string, difficulty: number, prompt: string): Omit<Exercise, 'interaction' | 'facts'> {
  const turn = new Chess(fen).turn();
  return {
    id,
    itemId: id,
    domain: conceptId.split('/')[0] as Exercise['domain'],
    conceptId,
    format,
    difficulty,
    difficultySource: 'tier-prior',
    sim: { themes: [format], material: materialSignature(fen) },
    phase: phaseOf(fen),
    color: turn,
    verified: true,
    prompt,
  };
}

export function buildConvertOrHold(p: EvalPosition, opponentElo: number): Exercise | null {
  const moves = 12;
  if (p.cp >= CONVERT_MIN_CP && p.cp < 1500) {
    return {
      ...base(`convert:${p.id}`, CONVERT, 'convert', p.fen, TIER_MID[2]! + Math.max(0, 600 - p.cp) / 3, `You are better (+${(p.cp / 100).toFixed(1)}). Keep your advantage for ${moves} moves.`),
      interaction: { kind: 'playout', fen: p.fen, orientation: new Chess(p.fen).turn() === 'w' ? 'white' : 'black', opponent: 'engine', opponentElo, objective: { type: 'convert', startCp: p.cp, retainFraction: 0.75, moves } },
      facts: [{ t: 'note', text: `Start evaluation +${(p.cp / 100).toFixed(1)} for the side to move (${p.source}). Success = at least 75% of it retained after ${moves} moves, judged by Stockfish at depth 12.` }, ...(p.url ? [{ t: 'source' as const, label: p.source, url: p.url }] : [])],
    };
  }
  if (p.cp >= HOLD_RANGE[0] && p.cp <= HOLD_RANGE[1]) {
    return {
      ...base(`hold:${p.id}`, HOLD, 'hold', p.fen, TIER_MID[3]! + (-p.cp - 150) / 3, `You are worse (${(p.cp / 100).toFixed(1)}). Hold the position for ${moves} moves.`),
      interaction: { kind: 'playout', fen: p.fen, orientation: new Chess(p.fen).turn() === 'w' ? 'white' : 'black', opponent: 'engine', opponentElo, objective: { type: 'hold', startCp: p.cp, maxExtraLossCp: 150, moves } },
      facts: [{ t: 'note', text: `Start evaluation ${(p.cp / 100).toFixed(1)} for the side to move (${p.source}). Success = losing at most 1.5 more pawns of evaluation over ${moves} moves (Stockfish depth 12).` }, ...(p.url ? [{ t: 'source' as const, label: p.source, url: p.url }] : [])],
    };
  }
  return null;
}

/** Spar from a puzzle position of a weak concept: the side to move is winning by the puzzle's verified solution. */
export function buildSparring(item: TacticItem, opponentElo: number): Exercise | null {
  if (!item.themes.includes('crushing') && !item.themes.includes('advantage')) return null;
  const { fen, userColor } = positionAfterFirstMove(item);
  const concept = primaryTacticConcept(item.themes);
  const moves = 15;
  const sol = sanLine(item.fen, item.moves).slice(1);
  return {
    ...base(`spar:${item.id}`, SPAR, 'sparring', fen, item.rating + 150, `Sparring: play this position out against Stockfish (about ${opponentElo}). Find the idea, then finish ahead.`),
    color: userColor,
    sim: { themes: ['sparring', ...item.themes.slice(0, 3)], material: materialSignature(fen) },
    secondaryConcepts: concept ? [concept] : undefined,
    interaction: { kind: 'playout', fen, orientation: userColor === 'w' ? 'white' : 'black', opponent: 'engine', opponentElo, objective: { type: 'spar', goal: 'Finish at least a pawn up in evaluation', moves, minCp: 100 } },
    facts: [
      { t: 'solution', san: sol },
      { t: 'note', text: `Objective met = Stockfish (depth 12) rates your position at least +1.0 after ${moves} moves, or you deliver mate. The puzzle's verified winning idea is shown above.` },
      { t: 'source', label: `Lichess puzzle ${item.id}`, url: `https://lichess.org/training/${item.id}` },
    ],
  };
}

/** Blunder-check: is this candidate move safe? Unsafe = a real puzzle's blunder; safe = the engine-best quiet move. */
export function buildBlunderCheck(src: { kind: 'blunder'; item: TacticItem } | { kind: 'safe'; item: StrategyItem }): Exercise | null {
  let fen: string;
  let move: string;
  let facts: Fact[];
  let difficulty: number;
  if (src.kind === 'blunder') {
    if (!src.item.themes.includes('crushing') && !src.item.themes.includes('mate')) return null;
    fen = src.item.fen;
    move = src.item.moves[0]!;
    const sol = sanLine(src.item.fen, src.item.moves);
    facts = [
      { t: 'note', text: `${sol[0]} is a blunder: it allows ${sol.slice(1).join(' ')} (Lichess puzzle ${src.item.id}, verified solution).` },
      { t: 'source', label: `Lichess puzzle ${src.item.id}`, url: `https://lichess.org/training/${src.item.id}` },
    ];
    difficulty = src.item.rating - 100;
  } else {
    if (Math.abs(src.item.bestCp) > 150) return null;
    fen = src.item.fen;
    move = src.item.best;
    facts = [{ t: 'engine', fen, pvSan: sanLine(fen, src.item.pv), cp: src.item.bestCp, mate: null, depth: src.item.depth }];
    difficulty = TIER_MID[src.item.tier]!;
  }
  const chess = new Chess(fen);
  const mv = tryMove(chess, move);
  if (!mv) return null;
  const id = `bcheck:${src.kind}:${src.item.id}`;
  return {
    ...base(id, BLUNDER, 'blunder-check', fen, difficulty, `Blunder check: you are about to play ${mv.san}. Is it safe?`),
    sim: { themes: ['blunder-check'], material: materialSignature(fen) },
    interaction: {
      kind: 'choice',
      fen,
      orientation: new Chess(fen).turn() === 'w' ? 'white' : 'black',
      options: [
        { id: 'safe', label: 'Safe: play it' },
        { id: 'unsafe', label: 'Unsafe: it allows a tactic' },
      ],
      correct: [src.kind === 'blunder' ? 'unsafe' : 'safe'],
      multi: false,
      highlight: [move.slice(0, 2), move.slice(2, 4)],
    },
    facts,
    timeBudgetSec: 30,
  };
}

/** Timed drill: an easy puzzle under a time budget from the user's own speed-accuracy data. */
export function buildTimedDrill(item: TacticItem, budgetSec: number): Exercise {
  const ex = buildSolve(item);
  return {
    ...ex,
    id: `timed:${item.id}`,
    conceptId: TIMED,
    domain: 'time',
    format: 'timed-drill',
    secondaryConcepts: [ex.conceptId],
    difficulty: item.rating + 120,
    difficultySource: 'tier-prior',
    prompt: `Timed: solve within ${budgetSec} seconds. ${ex.prompt}`,
    timeBudgetSec: budgetSec,
  };
}

export interface ProcessProvider extends Provider {
  setGamePositions(p: EvalPosition[]): void;
  setStrategy(items: StrategyItem[]): void;
  setOpponentElo(elo: number): void;
  /** Median seconds for solved puzzles near a rating, from history; drives timed drills. */
  setSpeed(fn: (rating: number) => number | null): void;
  setWeakConcepts(fn: () => string[]): void;
}

export function createProcessProvider(getTactics: () => TacticsProvider): ProcessProvider {
  let games: EvalPosition[] = [];
  let strategy: StrategyItem[] = [];
  let elo = 1200;
  let speed: (rating: number) => number | null = () => null;
  let weak: () => string[] = () => [];
  const evalPositions = (): EvalPosition[] => [
    ...games,
    ...strategy.map((s) => ({ id: `sb:${s.id}`, fen: s.fen, cp: s.bestCp, source: `strategy bank (Stockfish depth ${s.depth})`, url: `https://lichess.org/${s.sourceGame}` })),
  ];
  return {
    id: 'process',
    concepts() {
      const ids: string[] = [];
      const ev = evalPositions();
      if (ev.some((p) => p.cp >= CONVERT_MIN_CP)) ids.push(CONVERT);
      if (ev.some((p) => p.cp >= HOLD_RANGE[0] && p.cp <= HOLD_RANGE[1])) ids.push(HOLD);
      if (getTactics().itemCount() > 0) ids.push(SPAR, TIMED);
      if (getTactics().itemCount() > 0 && strategy.length > 0) ids.push(BLUNDER);
      return ids;
    },
    sample(conceptId, target, k, rng) {
      const out: Exercise[] = [];
      const t = getTactics();
      const near = (list: TacticItem[], r: number): TacticItem | null => {
        if (!list.length) return null;
        const sorted = list;
        let i = sorted.findIndex((x) => x.rating >= r);
        if (i < 0) i = sorted.length - 1;
        return sorted[Math.max(0, Math.min(sorted.length - 1, i + Math.floor((rng() - 0.5) * 30)))]!;
      };
      for (let n = 0; n < k * 4 && out.length < k; n++) {
        let ex: Exercise | null = null;
        if (conceptId === CONVERT || conceptId === HOLD) {
          const ev = evalPositions().filter((p) => (conceptId === CONVERT ? p.cp >= CONVERT_MIN_CP : p.cp >= HOLD_RANGE[0] && p.cp <= HOLD_RANGE[1]));
          const p = ev[Math.floor(rng() * ev.length)];
          ex = p ? buildConvertOrHold(p, elo) : null;
        } else if (conceptId === SPAR) {
          const ws = weak().filter((c) => c.startsWith('tactics/'));
          const c = ws[Math.floor(rng() * Math.max(1, ws.length))];
          const list = c ? t.itemsFor(c) : t.all().slice().sort((a, b) => a.rating - b.rating);
          const it = near(list.filter((x) => x.themes.includes('crushing')), target - 150);
          ex = it ? buildSparring(it, elo) : null;
          if (ex && c) ex = { ...ex, prompt: `${ex.prompt} (chosen from your weakest concepts)` };
        } else if (conceptId === TIMED) {
          const it = near(t.all().slice().sort((a, b) => a.rating - b.rating), target - 200);
          if (it) {
            const median = speed(it.rating);
            ex = buildTimedDrill(it, Math.max(10, Math.round((median ?? 40) * 0.8)));
          }
        } else if (conceptId === BLUNDER) {
          if (rng() < 0.5) {
            const it = near(t.all().slice().sort((a, b) => a.rating - b.rating), target);
            ex = it ? buildBlunderCheck({ kind: 'blunder', item: it }) : null;
          } else {
            const s = strategy[Math.floor(rng() * strategy.length)];
            ex = s ? buildBlunderCheck({ kind: 'safe', item: s }) : null;
          }
        }
        if (ex && !out.some((o) => o.id === ex.id)) out.push(ex);
      }
      return out;
    },
    setGamePositions(p) {
      games = p;
    },
    setStrategy(items) {
      strategy = items.filter((s) => s.verified);
    },
    setOpponentElo(e) {
      elo = Math.round(e);
    },
    setSpeed(fn) {
      speed = fn;
    },
    setWeakConcepts(fn) {
      weak = fn;
    },
  };
}
