/**
 * Heuristic plan label for a single move.
 *
 * THIS IS A HEURISTIC. The label describes what the move mechanically does on the board (derived
 * from the move itself and the static features before and after it). It is not the engine's
 * reason for the move, and anything shown to the user from it must be worded as heuristic.
 * The move is not checked for legality; pass moves that are already known to be legal.
 *
 * Rules, first match wins:
 *  - castling                                              -> king-safety
 *  - any capture                                           -> capture
 *  - pawn move:
 *      mover has more passed pawns afterwards              -> create-passed-pawn
 *      the pawn now attacks an enemy pawn                  -> pawn-break
 *      one-step push from the 2nd relative rank next to / in front of a castled back-rank king
 *      whose three front squares were all blocked by its own pieces (luft) -> king-safety
 *      the pawn lands on its 4th relative rank or beyond   -> gain-space
 *      otherwise                                           -> prophylaxis
 *  - king move: endgame and the king ends closer to the centre -> centralize; otherwise king-safety
 *  - piece move:
 *      knight/bishop lands on one of the mover's outpost squares -> piece-to-outpost
 *      rook lands on an open or semi-open file from a file that was neither -> rook-to-open-file
 *      knight/bishop leaves the back rank outside the endgame -> develop
 *      more of the mover's pieces attack the enemy king's zone than before -> attack-king
 *      the piece newly attacks an enemy piece of equal value while defended itself -> trade-offer
 *      the piece enters the 16 central squares (c3..f6) from outside -> centralize
 *      the moved piece attacks more squares than before    -> improve-piece
 *      otherwise                                           -> prophylaxis
 */
import {
  BISHOP, KING, KING_TARGETS, KNIGHT, PAWN, PIECE_NAME, PIECE_VALUE, ROOK,
  applyUci, attackersOf, attacksFrom, fileOf, findKing, parseFen, rankOf, signOf, sqIndex, sqName, toFen, typeAt,
  type Sign,
} from './board';
import { extractFromBoard } from './extract';

export type PlanLabel =
  | 'pawn-break'
  | 'gain-space'
  | 'rook-to-open-file'
  | 'piece-to-outpost'
  | 'improve-piece'
  | 'king-safety'
  | 'develop'
  | 'prophylaxis'
  | 'trade-offer'
  | 'create-passed-pawn'
  | 'attack-king'
  | 'centralize'
  | 'capture';

export const PLAN_LABELS: Record<PlanLabel, string> = {
  'pawn-break': 'Pawn break',
  'gain-space': 'Gain space',
  'rook-to-open-file': 'Rook to an open file',
  'piece-to-outpost': 'Piece to an outpost',
  'improve-piece': 'Improve a piece',
  'king-safety': 'King safety',
  develop: 'Develop a piece',
  prophylaxis: 'Quiet useful move (prophylaxis)',
  'trade-offer': 'Offer a trade',
  'create-passed-pawn': 'Create a passed pawn',
  'attack-king': 'Attack the king',
  centralize: 'Centralise',
  capture: 'Capture',
};

/** Number of non-pawn, non-king pieces of `sign` attacking the enemy king or a square next to it. */
function kingZoneAttackers(sq: Int8Array, sign: Sign): number {
  const king = findKing(sq, -sign as Sign);
  if (king < 0) return 0;
  const zone = new Uint8Array(64);
  zone[king] = 1;
  for (const s of KING_TARGETS[king]!) zone[s] = 1;
  let n = 0;
  for (let s = 0; s < 64; s++) {
    const t = sq[s]! * sign;
    if (t < KNIGHT || t === KING) continue;
    if (attacksFrom(sq, s).some((x) => zone[x] === 1)) n++;
  }
  return n;
}

function centreDistance(s: number): number {
  const f = fileOf(s);
  const r = rankOf(s);
  return Math.max(f < 4 ? 3 - f : f - 4, r < 4 ? 3 - r : r - 4);
}
function inBigCentre(s: number): boolean {
  return centreDistance(s) <= 1;
}

export function classifyPlan(fen: string, uci: string): { plan: PlanLabel; detail: string } {
  const before = parseFen(fen);
  const after = applyUci(before, uci);
  if (!after) return { plan: 'prophylaxis', detail: 'Move could not be applied to the position' };
  const side = before.turn;
  const sign = signOf(side);
  const from = sqIndex(uci.slice(0, 2));
  const to = sqIndex(uci.slice(2, 4));
  const type = typeAt(before.sq, from);
  const name = PIECE_NAME[type]!;
  const toName = sqName(to);
  const relRank = (s: number): number => (sign > 0 ? rankOf(s) : 7 - rankOf(s));

  if (type === KING && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    return { plan: 'king-safety', detail: `Castles ${fileOf(to) === 6 ? 'kingside' : 'queenside'}` };
  }
  const captured = typeAt(before.sq, to);
  const enPassant = type === PAWN && captured === 0 && fileOf(from) !== fileOf(to);
  if (captured !== 0 || enPassant) {
    return { plan: 'capture', detail: `Captures the ${PIECE_NAME[enPassant ? PAWN : captured]} on ${enPassant ? sqName(to - 8 * sign) : toName}` };
  }

  const fBefore = extractFromBoard(before, fen);
  const fAfter = extractFromBoard(after, toFen(after));
  const meBefore = fBefore[side];
  const meAfter = fAfter[side];

  if (type === PAWN) {
    if (meAfter.passed.length > meBefore.passed.length) {
      const wasPassed = meBefore.passed.includes(sqName(from));
      const fresh = meAfter.passed.filter((s) => !meBefore.passed.includes(s) && !(wasPassed && s === toName));
      const which = fresh.includes(toName) ? toName : (fresh[0] ?? toName);
      return { plan: 'create-passed-pawn', detail: `The pawn on ${which} becomes a passed pawn` };
    }
    const hit = attacksFrom(after.sq, to).filter((s) => after.sq[s] === -sign * PAWN);
    if (hit.length > 0) {
      return { plan: 'pawn-break', detail: `Pawn to ${toName} challenges the pawn on ${hit.map(sqName).join(' and ')}` };
    }
    const king = findKing(before.sq, sign);
    if (
      king >= 0 && meBefore.castled && relRank(king) === 0 && relRank(from) === 1 && relRank(to) === 2 &&
      Math.abs(fileOf(from) - fileOf(king)) <= 1
    ) {
      let boxed = true;
      for (let f = fileOf(king) - 1; f <= fileOf(king) + 1; f++) {
        if (f < 0 || f > 7) continue;
        if (before.sq[king + 8 * sign + (f - fileOf(king))]! * sign <= 0) boxed = false;
      }
      if (boxed) return { plan: 'king-safety', detail: `Pawn to ${toName} gives the king an escape square on ${sqName(from)}` };
    }
    if (relRank(to) >= 3) return { plan: 'gain-space', detail: `Pawn advances to ${toName}` };
    return { plan: 'prophylaxis', detail: `Quiet pawn move to ${toName}` };
  }

  if (type === KING) {
    if (fBefore.phase === 'endgame' && centreDistance(to) < centreDistance(from)) {
      return { plan: 'centralize', detail: `King steps towards the centre (${toName})` };
    }
    return { plan: 'king-safety', detail: `King moves to ${toName}` };
  }

  if ((type === KNIGHT || type === BISHOP) && meAfter.outposts.some((o) => o.square === toName && o.occupied)) {
    return { plan: 'piece-to-outpost', detail: `${cap(name)} lands on the outpost ${toName}` };
  }
  if (type === ROOK) {
    const open = (features: typeof fBefore, s: number): boolean => {
      const file = 'abcdefgh'.charAt(fileOf(s));
      return features.openFiles.includes(file) || features[side].semiOpenFiles.includes(file);
    };
    if (open(fAfter, to) && !open(fBefore, from)) {
      const full = fAfter.openFiles.includes(toName.charAt(0));
      return { plan: 'rook-to-open-file', detail: `Rook moves to the ${full ? 'open' : 'semi-open'} ${toName.charAt(0)}-file` };
    }
  }
  if ((type === KNIGHT || type === BISHOP) && relRank(from) === 0 && relRank(to) !== 0 && fBefore.phase !== 'endgame') {
    return { plan: 'develop', detail: `Develops the ${name} to ${toName}` };
  }
  const zoneBefore = kingZoneAttackers(before.sq, sign);
  const zoneAfter = kingZoneAttackers(after.sq, sign);
  if (zoneAfter > zoneBefore) {
    return { plan: 'attack-king', detail: `Pieces attacking squares around the enemy king: ${zoneBefore} -> ${zoneAfter}` };
  }
  const attBefore = attacksFrom(before.sq, from);
  const attAfter = attacksFrom(after.sq, to);
  const value = PIECE_VALUE[type]!;
  const offered = attAfter.find(
    (s) => after.sq[s]! * sign < 0 && typeAt(after.sq, s) !== KING && PIECE_VALUE[typeAt(after.sq, s)] === value && !attBefore.includes(s),
  );
  if (offered !== undefined && attackersOf(after.sq, to, sign).length > 0) {
    return { plan: 'trade-offer', detail: `${cap(name)} on ${toName} offers a trade with the ${PIECE_NAME[typeAt(after.sq, offered)]} on ${sqName(offered)}` };
  }
  if (inBigCentre(to) && !inBigCentre(from)) return { plan: 'centralize', detail: `${cap(name)} moves to the centre (${toName})` };
  const free = (sq: Int8Array, list: number[]): number => list.filter((s) => sq[s]! * sign <= 0).length;
  const mobBefore = free(before.sq, attBefore);
  const mobAfter = free(after.sq, attAfter);
  if (mobAfter > mobBefore) {
    return { plan: 'improve-piece', detail: `${cap(name)} on ${toName} reaches ${mobAfter} squares (was ${mobBefore})` };
  }
  return { plan: 'prophylaxis', detail: `Quiet ${name} move to ${toName}` };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
