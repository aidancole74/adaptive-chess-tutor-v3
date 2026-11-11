/**
 * Calculation and visualisation drills. Everything is generated programmatically and verified:
 * board geometry (coordinates, square colours, knight paths by BFS), chess.js move generation
 * (checks / captures lists) and Lichess puzzle solutions (forced lines, hidden-board, blindfold).
 */
import { Chess } from 'chess.js';
import { TIER_MID } from '../../curriculum/concepts';
import { materialSignature, phaseOf, sanLine, uciOf } from '../../engine/chessUtil';
import type { Exercise, Fact } from '../../exercises/types';
import { isLightSquare, shortestKnightPath } from '../../exercises/grade';
import { positionAfterFirstMove } from '../tactics';
import type { TacticItem } from '../types';
import type { Provider } from '../pool';
import type { TacticsProvider } from './tactics';

const C = 'calculation';
const FILES = 'abcdefgh';
const randSq = (rng: () => number): string => `${FILES[Math.floor(rng() * 8)]}${1 + Math.floor(rng() * 8)}`;

function base(id: string, conceptId: string, format: Exercise['format'], difficulty: number, extra: Partial<Exercise>): Exercise {
  return {
    id,
    itemId: id,
    domain: 'calculation',
    conceptId,
    format,
    difficulty,
    difficultySource: 'tier-prior',
    sim: { themes: [format], material: '' },
    phase: 'middlegame',
    color: 'w',
    verified: true,
    prompt: '',
    interaction: { kind: 'card', title: '', body: [] },
    facts: [],
    ...extra,
  };
}

export function coordinateDrill(rng: () => number, n = 6): Exercise {
  const squares = Array.from({ length: n }, () => randSq(rng));
  const orientation = rng() < 0.5 ? 'white' : 'black';
  const id = `coord:${orientation}:${squares.join('')}`;
  return base(id, `${C}/visualization/coordinates`, 'coordinates', TIER_MID[0]! + (orientation === 'black' ? 150 : 0), {
    prompt: `Click the squares in order: ${squares.join(', ')} (board shown from ${orientation}'s side, no labels).`,
    interaction: { kind: 'set', mode: 'squares', expected: squares, passFraction: 1, maxWrong: 0, hide: 'board-labels', orientation, fen: '8/8/8/8/8/8/8/8 w - - 0 1' },
    facts: [{ t: 'note', text: `Squares: ${squares.join(', ')}.` }],
    timeBudgetSec: 20,
  });
}

export function squareColorDrill(rng: () => number, n = 8): Exercise {
  const squares = Array.from({ length: n }, () => randSq(rng));
  const light = squares.filter(isLightSquare);
  const id = `sqcol:${squares.join('')}`;
  return base(id, `${C}/visualization/square-color`, 'square-color', TIER_MID[0]! + 100, {
    prompt: `Without looking at a board: which of these squares are light? ${squares.join(', ')}`,
    interaction: { kind: 'choice', options: [...new Set(squares)].map((s) => ({ id: s, label: s })), correct: [...new Set(light)], multi: true },
    facts: [{ t: 'note', text: `Light squares: ${[...new Set(light)].join(', ') || 'none'}. A square is light when its file number (a=1) plus rank is odd.` }],
    timeBudgetSec: 25,
  });
}

export function knightPathDrill(rng: () => number): Exercise {
  let from = randSq(rng);
  let to = randSq(rng);
  let path = shortestKnightPath(from, to);
  for (let guard = 0; path.length < 4 && guard < 50; guard++) {
    from = randSq(rng);
    to = randSq(rng);
    path = shortestKnightPath(from, to);
  }
  const moves = path.length - 1;
  return base(`knight:${from}${to}`, `${C}/visualization/knight-moves`, 'knight-path', TIER_MID[1]! + (moves - 3) * 120, {
    prompt: `A knight stands on ${from}. Click the squares of a shortest route to ${to} (${moves} moves), ending on ${to}.`,
    interaction: { kind: 'set', mode: 'path', expected: path, from, to, passFraction: 1, maxWrong: 0, fen: `8/8/8/8/8/8/8/8 w - - 0 1` },
    facts: [{ t: 'note', text: `One shortest route: ${path.join(' → ')} (${moves} moves, computed by breadth-first search).` }],
    timeBudgetSec: 30,
  });
}

/** List every check and capture for the side to move (chess.js move generation). */
export function candidatesDrill(item: TacticItem): Exercise | null {
  const { fen, userColor } = positionAfterFirstMove(item);
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true }).filter((m) => m.san.includes('+') || m.san.includes('#') || m.isCapture() || m.isEnPassant());
  if (moves.length < 2 || moves.length > 9) return null;
  const expected = moves.map(uciOf);
  return base(`cand:${item.id}`, `${C}/candidates/checks-captures-threats`, 'candidates', Math.max(600, item.rating - 250), {
    itemId: item.id,
    prompt: `List every check and capture for ${userColor === 'w' ? 'White' : 'Black'}: play each one on the board, then press Done.`,
    color: userColor,
    phase: phaseOf(fen),
    sim: { themes: ['candidates', ...item.themes.slice(0, 3)], material: materialSignature(fen) },
    interaction: { kind: 'set', mode: 'moves', expected, fen, orientation: userColor === 'w' ? 'white' : 'black', passFraction: 1, maxWrong: 1 },
    facts: [{ t: 'note', text: `Checks and captures (${moves.length}): ${moves.map((m) => m.san).join(', ')}.` }, { t: 'source', label: `Lichess puzzle ${item.id}`, url: `https://lichess.org/training/${item.id}` }],
    timeBudgetSec: 60,
  });
}

/** Forced line from a Lichess puzzle: enter all your moves before feedback; optionally hidden. */
export function forcedLineDrill(item: TacticItem, mode: 'commit' | 'hidden' | 'blindfold'): Exercise | null {
  const userMoves = Math.ceil((item.moves.length - 1) / 2);
  if (userMoves < 2) return null;
  const { userColor } = positionAfterFirstMove(item);
  const concept =
    mode === 'blindfold' ? `${C}/visualization/blindfold` : mode === 'hidden' ? `${C}/visualization/hidden-board` : userMoves >= 4 ? `${C}/forced/depth-4` : userMoves === 3 ? `${C}/forced/depth-3` : `${C}/forced/depth-2`;
  const sol = sanLine(item.fen, item.moves);
  const facts: Fact[] = [
    { t: 'solution', san: sol.slice(1) },
    { t: 'source', label: `Lichess puzzle ${item.id}`, url: `https://lichess.org/training/${item.id}` },
  ];
  const bump = mode === 'blindfold' ? 350 : mode === 'hidden' ? 200 : 60;
  const prompt =
    mode === 'blindfold'
      ? `Blindfold: the pieces are hidden. Opponent's last move: ${sol[0]}. Type your moves (SAN) for the whole line.`
      : mode === 'hidden'
        ? `The opponent played ${sol[0]}; the board shows the position before it. Calculate and enter your ${userMoves} moves.`
        : `Calculate the whole forced line: enter all ${userMoves} of your moves (the replies are played for you) before you get feedback.`;
  return base(`calc:${mode}:${item.id}`, concept, mode === 'commit' ? 'calc-line' : 'blindfold', item.rating + bump, {
    itemId: item.id,
    prompt,
    color: userColor,
    phase: phaseOf(item.fen),
    sim: { themes: [mode, ...item.themes.slice(0, 3)], material: materialSignature(item.fen) },
    interaction: {
      kind: 'line',
      fen: item.fen,
      orientation: userColor === 'w' ? 'white' : 'black',
      preMoves: [item.moves[0]!],
      solution: item.moves.slice(1),
      acceptAnyMate: item.themes.includes('mate'),
      commitDepth: userMoves,
      hide: mode === 'blindfold' ? 'pieces' : mode === 'hidden' ? 'after-pre' : 'none',
    },
    facts,
    timeBudgetSec: 45 * userMoves,
  });
}

export function createCalculationProvider(getTactics: () => TacticsProvider): Provider {
  const longLines = (): TacticItem[] => getTactics().all().filter((t) => t.moves.length >= 4).sort((a, b) => a.rating - b.rating);
  let cache: TacticItem[] = [];
  let cacheSize = -1;
  const lines = (): TacticItem[] => {
    const n = getTactics().itemCount();
    if (n !== cacheSize) {
      cache = longLines();
      cacheSize = n;
    }
    return cache;
  };
  const near = (list: TacticItem[], target: number, rng: () => number): TacticItem | null => {
    if (list.length === 0) return null;
    let i = list.findIndex((t) => t.rating >= target);
    if (i < 0) i = list.length - 1;
    const j = Math.min(list.length - 1, Math.max(0, i + Math.floor((rng() - 0.5) * 40)));
    return list[j]!;
  };
  return {
    id: 'calculation',
    concepts() {
      const ids = [`${C}/visualization/coordinates`, `${C}/visualization/square-color`, `${C}/visualization/knight-moves`];
      if (getTactics().itemCount() > 0) ids.push(`${C}/candidates/checks-captures-threats`, `${C}/forced/depth-2`, `${C}/forced/depth-3`, `${C}/forced/depth-4`, `${C}/visualization/hidden-board`, `${C}/visualization/blindfold`);
      return ids;
    },
    sample(conceptId, target, k, rng) {
      const out: Exercise[] = [];
      for (let i = 0; i < k * 3 && out.length < k; i++) {
        let ex: Exercise | null = null;
        if (conceptId.endsWith('/coordinates')) ex = coordinateDrill(rng);
        else if (conceptId.endsWith('/square-color')) ex = squareColorDrill(rng);
        else if (conceptId.endsWith('/knight-moves')) ex = knightPathDrill(rng);
        else if (conceptId.endsWith('/checks-captures-threats')) {
          const t = near(getTactics().all().slice().sort((a, b) => a.rating - b.rating), target + 250, rng);
          ex = t ? candidatesDrill(t) : null;
        } else {
          const depth = conceptId.endsWith('depth-2') ? 2 : conceptId.endsWith('depth-3') ? 3 : conceptId.endsWith('depth-4') ? 4 : 2;
          const pool = lines().filter((t) => {
            const u = Math.ceil((t.moves.length - 1) / 2);
            return depth === 4 ? u >= 4 : u === depth;
          });
          const mode = conceptId.endsWith('blindfold') ? 'blindfold' : conceptId.endsWith('hidden-board') ? 'hidden' : 'commit';
          const shift = mode === 'blindfold' ? 350 : mode === 'hidden' ? 200 : 60;
          const t = near(pool, target - shift, rng);
          ex = t ? forcedLineDrill(t, mode) : null;
        }
        if (ex && !out.some((o) => o.id === ex.id)) out.push(ex);
      }
      return out;
    },
  };
}
