/**
 * Template explanations built ONLY from an exercise's verified facts
 * (solution lines, engine lines, tablebase results, detected motifs, computed features, book statistics).
 */
import { conceptName } from '../curriculum/concepts';
import type { ExplanationStyle } from '../model/settings';
import type { Exercise, Fact } from './types';

export interface Explanation {
  /** Socratic mode: asked before the reveal. */
  question: string | null;
  lines: string[];
}

function numbered(sans: string[], whiteFirst: boolean, startMove = 1): string {
  const out: string[] = [];
  let n = startMove;
  sans.forEach((s, i) => {
    const white = whiteFirst ? i % 2 === 0 : i % 2 === 1;
    if (white) out.push(`${n}.${s}`);
    else {
      out.push(i === 0 ? `${n}...${s}` : s);
      n++;
    }
  });
  return out.join(' ');
}

function evalText(cp: number | null, mate: number | null): string {
  if (mate !== null) return mate > 0 ? `mate in ${mate}` : `mated in ${-mate}`;
  if (cp === null) return 'no evaluation';
  const v = (cp / 100).toFixed(1);
  return `${cp >= 0 ? '+' : ''}${v} for the side to move`;
}

export function factLine(f: Fact, ex: Exercise, detailed: boolean): string | null {
  const whiteFirst = ex.color === 'w';
  switch (f.t) {
    case 'solution':
      return `Solution: ${numbered(f.san, whiteFirst)}.`;
    case 'engine': {
      const fenWhite = f.fen.split(' ')[1] !== 'b';
      const pv = numbered(detailed ? f.pvSan : f.pvSan.slice(0, 4), fenWhite);
      return `Engine (depth ${f.depth}): ${pv} (${evalText(f.cp, f.mate)}).`;
    }
    case 'tablebase': {
      const res = f.category === 'win' ? 'a win' : f.category === 'draw' ? 'a draw' : 'a loss';
      const dtm = f.dtm !== null && f.category !== 'draw' ? `, mate in ${Math.ceil(Math.abs(f.dtm) / 2)} with best play` : '';
      const best = f.bestSan.length > 0 ? ` ${f.bestSan.length === 1 ? 'Only move' : 'Moves'} that keep${f.bestSan.length === 1 ? 's' : ''} the result: ${f.bestSan.join(', ')}.` : '';
      return `Tablebase: the position is ${res} for the side to move${dtm}.${best}`;
    }
    case 'motif':
      return `Motif: ${conceptNameForTheme(f.name)}${f.squares?.length ? ` (${f.squares.join(', ')})` : ''}.`;
    case 'feature':
      return `${f.side === 'w' ? 'White' : 'Black'}: ${f.detail} (heuristic feature detection).`;
    case 'book': {
      if (f.moves.length === 0) return null;
      const top = f.moves.slice(0, detailed ? 4 : 2).map((m) => `${m.san} (${m.games.toLocaleString('en')} games, scores ${m.scorePct}%)`);
      return `Book, ${f.band} band: ${top.join('; ')}.`;
    }
    case 'source':
      return detailed ? `Source: ${f.label}${f.url ? ` — ${f.url}` : ''}.` : null;
    case 'note':
      return f.text;
  }
}

function conceptNameForTheme(theme: string): string {
  // motif facts carry Lichess theme names; show the concept's display name when one exists
  for (const prefix of ['tactics/basics/', 'tactics/double-attack/', 'tactics/mating/', 'tactics/removing-defender/', 'tactics/pawns/', 'tactics/attack/', 'tactics/subtle/']) {
    const name = conceptName(prefix + theme);
    if (name !== theme) return name;
  }
  return theme;
}

const QUESTIONS: Partial<Record<Exercise['format'], string>> = {
  solve: 'Before the reveal: which of the opponent’s pieces or squares was the target, and what was defending it?',
  'spot-motif': 'What does the key move attack, and can both threats be met at once?',
  'find-defense': 'What was the opponent threatening, and which move meets that threat without creating a new weakness?',
  'tactic-or-not': 'List the checks and captures for the side to move. Does any of them win material by force?',
  'eg-best-move': 'Which squares must your king or pawn reach, and whose move would you like it to be?',
  'eg-win-or-draw': 'Can the defending king reach the critical squares in time?',
  'quiet-best-move': 'Which of your pieces is doing the least, and where would it stand better?',
  'who-is-better': 'Compare king safety, pawn weaknesses and piece activity for both sides. Which differences are largest?',
  'choose-plan': 'What does the pawn structure suggest: which side of the board, and which pawn lever?',
  'evaluate-trade': 'After the trade, whose remaining pieces are more active, and whose weaknesses are easier to attack?',
  'opening-line': 'What does this move do for development, the centre and king safety?',
  'opening-deviation': 'What did the opponent’s move stop doing that the book move does?',
  'calc-line': 'At the end of your line, what is the opponent’s best reply? Did you check it?',
  'spot-mistake': 'What changed after the move that was played: which piece or square lost its defender?',
};

/** Depth (0 practical .. 1 theoretical) and style decide how many facts are shown. */
export function explainExercise(ex: Exercise, style: ExplanationStyle, depth: number): Explanation {
  const detailed = style === 'detailed' || depth >= 0.7;
  const lines: string[] = [];
  const order: Fact['t'][] = ['solution', 'tablebase', 'engine', 'motif', 'feature', 'book', 'note', 'source'];
  const facts = [...ex.facts].sort((a, b) => order.indexOf(a.t) - order.indexOf(b.t));
  const limit = style === 'concise' && !detailed ? 3 : 12;
  for (const f of facts) {
    if (lines.length >= limit) break;
    const l = factLine(f, ex, detailed);
    if (l) lines.push(l);
  }
  if (ex.facts.some((f) => f.t === 'feature')) lines.push('Feature attributions are heuristic: they describe the position, they do not prove why the engine prefers a move.');
  if (lines.length === 0) lines.push('No verified explanation is available for this exercise.');
  return { question: style === 'socratic' ? (QUESTIONS[ex.format] ?? 'What was the key idea of the position?') : null, lines };
}
