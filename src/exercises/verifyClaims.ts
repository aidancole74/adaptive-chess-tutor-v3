/**
 * Verifier for AI-written explanations: every move-level claim (SAN moves, squares) must appear in the
 * exercise's verified facts. Anything else is rejected and the template explanation is shown instead.
 */
import type { Exercise, Fact } from './types';

const SAN_RE = /\b(?:O-O-O|O-O|[KQRBN][a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?|[a-h]x[a-h][1-8](?:=[QRBN])?|[a-h][1-8](?:=[QRBN])?)[+#]?/g;
const SQUARE_RE = /\b[a-h][1-8]\b/g;

const norm = (s: string): string => s.replace(/[+#!?]/g, '');

export function allowedTokens(facts: Fact[]): { moves: Set<string>; squares: Set<string> } {
  const moves = new Set<string>();
  const squares = new Set<string>();
  const addText = (t: string): void => {
    for (const m of t.match(SAN_RE) ?? []) moves.add(norm(m));
    for (const s of t.match(SQUARE_RE) ?? []) squares.add(s);
  };
  for (const f of facts) {
    switch (f.t) {
      case 'solution':
        f.san.forEach((s) => moves.add(norm(s)));
        break;
      case 'engine':
        f.pvSan.forEach((s) => moves.add(norm(s)));
        break;
      case 'tablebase':
        f.bestSan.forEach((s) => moves.add(norm(s)));
        break;
      case 'book':
        f.moves.forEach((m) => moves.add(norm(m.san)));
        break;
      case 'motif':
        f.squares?.forEach((s) => squares.add(s));
        break;
      case 'feature':
        addText(f.detail);
        break;
      case 'note':
        addText(f.text);
        break;
      case 'source':
        break;
    }
  }
  for (const m of moves) for (const s of m.match(SQUARE_RE) ?? []) squares.add(s);
  return { moves, squares };
}

export interface ClaimCheck {
  ok: boolean;
  unsupported: string[];
}

export function verifyClaims(text: string, facts: Fact[]): ClaimCheck {
  const { moves, squares } = allowedTokens(facts);
  const unsupported: string[] = [];
  for (const m of text.match(SAN_RE) ?? []) {
    const n = norm(m);
    // A bare square like "e4" may be a square reference rather than a pawn move: accept it if the square is known.
    if (/^[a-h][1-8]$/.test(n) ? !squares.has(n) && !moves.has(n) : !moves.has(n)) unsupported.push(m);
  }
  return { ok: unsupported.length === 0, unsupported: [...new Set(unsupported)] };
}

/** Structured, fact-only payload sent to the model (no board, no FEN beyond what the facts contain). */
export function factsPayload(ex: Exercise): string {
  return JSON.stringify({ prompt: ex.prompt, concept: ex.conceptId, format: ex.format, sideToMove: ex.color, facts: ex.facts.filter((f) => f.t !== 'source') });
}
