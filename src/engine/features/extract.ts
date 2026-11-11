/**
 * Static positional feature extraction from a FEN.
 *
 * Everything here is a mechanical description of the piece placement. Nothing is an evaluation:
 * "weak square" or "bad bishop" mean exactly the definitions below and nothing more.
 * No move generation and no chess.js: one scan over an array board (see ./board.ts).
 *
 * "Relative rank" means the rank counted from the side's own back rank (1..8), so White's 4th
 * relative rank is rank 4 and Black's is rank 5.
 *
 * DEFINITIONS
 * - isolated: a pawn with no friendly pawn on either adjacent file.
 * - doubled: every pawn on a file that holds two or more friendly pawns.
 * - passed: a pawn with no enemy pawn ahead of it on its own or an adjacent file, and no
 *   friendly pawn ahead of it on its own file (only the front pawn of a doubled pair counts).
 * - backward: a pawn that is not isolated, has no friendly pawn on an adjacent file level with
 *   or behind it, and whose stop square (the square directly in front) is attacked by an enemy pawn.
 * - hangingPawns: two friendly pawns on adjacent files, each the only friendly pawn on its file,
 *   both on the 4th or 5th relative rank, with no friendly pawn on the two outer adjacent files
 *   and no enemy pawn on either of their files.
 * - iqp: the side has exactly one d-pawn and it is isolated.
 * - openFiles: files with no pawn of either colour. semiOpenFiles (per side): files with no pawn
 *   of that side but at least one enemy pawn. rooksOnOpenFiles: that side's rooks on either kind.
 * - outposts: squares on the side's 5th or 6th relative rank that hold no pawn, are protected by
 *   a friendly pawn, and can never be attacked by an enemy pawn (no enemy pawn on an adjacent file
 *   further up the board from the side's point of view). `occupied` = a friendly knight or bishop
 *   stands there.
 * - weakSquares: squares on the side's 3rd or 4th relative rank that hold no friendly pawn and
 *   that no friendly pawn can ever protect (no friendly pawn on an adjacent file behind the square).
 * - kingShieldPawns: number of files among the king's file and its neighbours (0..3) that have a
 *   friendly pawn one or two ranks directly in front of the king's rank.
 * - castled: inferred from placement only. King on its back rank on the g/h-file with no friendly
 *   rook between it and the h-corner, or on the a/b/c-file with no friendly rook between it and
 *   the a-corner. A king that walked there by hand counts as castled.
 * - kingDanger (0..10): (king-area files without a shield pawn) + (king-area files with no
 *   friendly pawn at all) + (enemy pieces attacking the king or a square next to it: knight,
 *   bishop, rook = 1, queen = 2, capped at 4); halved (rounded down) when the enemy has no queen;
 *   0 when the enemy has no knight, bishop, rook or queen.
 * - mobility: number of squares the side's knights, bishops, rooks and queens attack that are not
 *   occupied by a friendly piece (pseudo-legal: pins and checks ignored).
 * - bishopPair: at least one bishop on each square colour.
 * - badBishops: bishops with three or more friendly pawns on their square colour, at least one of
 *   them on the d- or e-file. goodBishops: bishops that are not bad, have no friendly d/e-pawn on
 *   their square colour, and have fewer friendly pawns on their colour than on the other colour.
 * - space: number of squares in the enemy half (relative ranks 5..8) attacked by at least one
 *   friendly pawn, knight, bishop, rook or queen, plus the number of friendly pawns standing in
 *   the enemy half.
 * - development: knights and bishops off the side's back rank, +1 if castled, +1 if two rooks
 *   stand on the back rank with nothing between them.
 * - material: P=1, N=3, B=3, R=5, Q=9.
 *
 * STRUCTURE LABEL (first matching rule wins)
 * 1. carlsbad: White pawn on d4, a White e-pawn, no White c-pawn; Black pawn on d5, a Black
 *    c-pawn on c6 or c7, no Black e-pawn. Or the colour-reversed mirror: Black pawn on d5, a Black
 *    e-pawn, no Black c-pawn; White pawn on d4, a White c-pawn on c2 or c3, no White e-pawn.
 * 2. maroczy-white: White pawns on c4 and e4, no White d-pawn; Black has no c-pawn and no pawn
 *    on d5. maroczy-black: Black pawns on c5 and e5, no Black d-pawn; White has no c-pawn and no
 *    pawn on d4.
 * 3. iqp-white / iqp-black: exactly one side has an IQP (see above) and it stands on that side's
 *    4th or 5th relative rank.
 * 4. hanging-pawns-white / hanging-pawns-black: exactly one side has hanging pawns.
 * 5. closed-centre: both the d-file and the e-file contain a "ram": a White pawn with a Black
 *    pawn on the square directly in front of it.
 * 6. open-centre: no pawn on d4, d5, e4 or e5 and at least one of the d/e files has no pawns at all.
 * 7. symmetrical: both sides have pawns and Black's pawns are the vertical mirror of White's.
 * 8. other.
 */
import { materialSignature, phaseOf } from '../chessUtil';
import {
  BISHOP, KING, KING_TARGETS, KNIGHT, PAWN, QUEEN, ROOK,
  attacksFrom, parseFen, sqName,
  type Board, type Sign,
} from './board';
import type { ExtractFeatures, PositionFeatures, SideFeatures, StructureLabel } from './types';

const FILE_LETTERS = 'abcdefgh';
const MATERIAL: readonly number[] = [0, 1, 3, 3, 5, 9, 0];

/** Pawn ranks (0-based, ascending) per file for one side. */
type PawnFiles = number[][];

interface Scan {
  sq: Int8Array;
  wp: PawnFiles;
  bp: PawnFiles;
}

function pawnFiles(sq: Int8Array, sign: Sign): PawnFiles {
  const files: PawnFiles = [[], [], [], [], [], [], [], []];
  for (let s = 0; s < 64; s++) if (sq[s] === sign * PAWN) files[s & 7]!.push(s >> 3);
  return files;
}

function hasPawnAt(files: PawnFiles, f: number, r: number): boolean {
  if (f < 0 || f > 7) return false;
  return files[f]!.includes(r);
}
function countOnFile(files: PawnFiles, f: number): number {
  return f < 0 || f > 7 ? 0 : files[f]!.length;
}
/** True if `files[f]` has a pawn whose rank is strictly ahead of `r` from `sign`'s point of view. */
function anyAhead(files: PawnFiles, f: number, r: number, sign: Sign): boolean {
  if (f < 0 || f > 7) return false;
  for (const pr of files[f]!) if ((pr - r) * sign > 0) return true;
  return false;
}
function anyBehind(files: PawnFiles, f: number, r: number, sign: Sign): boolean {
  if (f < 0 || f > 7) return false;
  for (const pr of files[f]!) if ((pr - r) * sign < 0) return true;
  return false;
}
function anyLevelOrBehind(files: PawnFiles, f: number, r: number, sign: Sign): boolean {
  if (f < 0 || f > 7) return false;
  for (const pr of files[f]!) if ((pr - r) * sign <= 0) return true;
  return false;
}
/** 0-based relative rank. */
function rel(r: number, sign: Sign): number {
  return sign > 0 ? r : 7 - r;
}
function abs(r: number, sign: Sign): number {
  return sign > 0 ? r : 7 - r;
}

function sideFeatures(scan: Scan, sign: Sign): SideFeatures {
  const { sq } = scan;
  const own = sign > 0 ? scan.wp : scan.bp;
  const opp = sign > 0 ? scan.bp : scan.wp;

  /* ----- pawns ----- */
  const isolated: string[] = [];
  const doubled: string[] = [];
  const backward: string[] = [];
  const passed: string[] = [];
  let ownPawnCount = 0;
  const pawnsOnColour = [0, 0];
  const centralOnColour = [0, 0];
  let advancedPawns = 0;
  for (let f = 0; f < 8; f++) {
    const ranks = own[f]!;
    const lonely = countOnFile(own, f - 1) === 0 && countOnFile(own, f + 1) === 0;
    for (const r of ranks) {
      const name = FILE_LETTERS.charAt(f) + String(r + 1);
      ownPawnCount++;
      const colour = (f + r) & 1;
      pawnsOnColour[colour]!++;
      if (f === 3 || f === 4) centralOnColour[colour]!++;
      if (rel(r, sign) >= 4) advancedPawns++;
      if (lonely) isolated.push(name);
      if (ranks.length >= 2) doubled.push(name);
      if (
        !anyAhead(own, f, r, sign) &&
        !anyAhead(opp, f, r, sign) && !anyAhead(opp, f - 1, r, sign) && !anyAhead(opp, f + 1, r, sign)
      ) {
        passed.push(name);
      }
      if (
        !lonely &&
        !anyLevelOrBehind(own, f - 1, r, sign) && !anyLevelOrBehind(own, f + 1, r, sign) &&
        (hasPawnAt(opp, f - 1, r + 2 * sign) || hasPawnAt(opp, f + 1, r + 2 * sign))
      ) {
        backward.push(name);
      }
    }
  }

  const hangingPawns: string[] = [];
  for (let f = 0; f < 7; f++) {
    const a = own[f]!;
    const b = own[f + 1]!;
    if (a.length !== 1 || b.length !== 1) continue;
    const ra = rel(a[0]!, sign);
    const rb = rel(b[0]!, sign);
    if (ra < 3 || ra > 4 || rb < 3 || rb > 4) continue;
    if (countOnFile(own, f - 1) > 0 || countOnFile(own, f + 2) > 0) continue;
    if (countOnFile(opp, f) > 0 || countOnFile(opp, f + 1) > 0) continue;
    hangingPawns.push(FILE_LETTERS.charAt(f) + String(a[0]! + 1), FILE_LETTERS.charAt(f + 1) + String(b[0]! + 1));
  }

  const iqp = own[3]!.length === 1 && countOnFile(own, 2) === 0 && countOnFile(own, 4) === 0;

  const semiOpenFiles: string[] = [];
  for (let f = 0; f < 8; f++) if (own[f]!.length === 0 && opp[f]!.length > 0) semiOpenFiles.push(FILE_LETTERS.charAt(f));

  /* ----- squares ----- */
  const outposts: { square: string; occupied: boolean }[] = [];
  for (let rr = 4; rr <= 5; rr++) {
    const r = abs(rr, sign);
    for (let f = 0; f < 8; f++) {
      const s = r * 8 + f;
      const p = sq[s]!;
      if (p === PAWN || p === -PAWN) continue;
      if (!hasPawnAt(own, f - 1, r - sign) && !hasPawnAt(own, f + 1, r - sign)) continue;
      if (anyAhead(opp, f - 1, r, sign) || anyAhead(opp, f + 1, r, sign)) continue;
      outposts.push({ square: sqName(s), occupied: p === sign * KNIGHT || p === sign * BISHOP });
    }
  }
  const weakSquares: string[] = [];
  for (let rr = 2; rr <= 3; rr++) {
    const r = abs(rr, sign);
    for (let f = 0; f < 8; f++) {
      const s = r * 8 + f;
      if (sq[s] === sign * PAWN) continue;
      if (anyBehind(own, f - 1, r, sign) || anyBehind(own, f + 1, r, sign)) continue;
      weakSquares.push(sqName(s));
    }
  }

  /* ----- pieces: one pass ----- */
  let ownKing = -1;
  for (let s = 0; s < 64; s++) if (sq[s] === sign * KING) ownKing = s;
  const kingZone = new Uint8Array(64);
  if (ownKing >= 0) {
    kingZone[ownKing] = 1;
    for (const s of KING_TARGETS[ownKing]!) kingZone[s] = 1;
  }

  let mobility = 0;
  let material = 0;
  let minorsOut = 0;
  let enemyQueens = 0;
  let enemyPieces = 0;
  let attackWeight = 0;
  const bishops: number[] = [];
  const rooks: number[] = [];
  const control = new Uint8Array(64);
  const backRank = abs(0, sign);
  for (let s = 0; s < 64; s++) {
    const p = sq[s]!;
    if (p === 0) continue;
    if (p * sign > 0) {
      const type = p * sign;
      material += MATERIAL[type]!;
      if (type === KING) continue;
      const att = attacksFrom(sq, s);
      for (let i = 0; i < att.length; i++) {
        const t = att[i]!;
        control[t] = 1;
        if (type !== PAWN && sq[t]! * sign <= 0) mobility++;
      }
      if (type === BISHOP) bishops.push(s);
      else if (type === ROOK) rooks.push(s);
      if ((type === BISHOP || type === KNIGHT) && s >> 3 !== backRank) minorsOut++;
    } else {
      const type = -p * sign;
      if (type === PAWN || type === KING) continue;
      enemyPieces++;
      if (type === QUEEN) enemyQueens++;
      if (ownKing >= 0) {
        const att = attacksFrom(sq, s);
        for (let i = 0; i < att.length; i++) {
          if (kingZone[att[i]!] === 1) {
            attackWeight += type === QUEEN ? 2 : 1;
            break;
          }
        }
      }
    }
  }

  let space = advancedPawns;
  for (let rr = 4; rr <= 7; rr++) {
    const base = abs(rr, sign) * 8;
    for (let f = 0; f < 8; f++) space += control[base + f]!;
  }

  /* ----- bishops ----- */
  const goodBishops: string[] = [];
  const badBishops: string[] = [];
  let lightBishop = false;
  let darkBishop = false;
  for (const s of bishops) {
    const colour = ((s & 7) + (s >> 3)) & 1;
    if (colour === 1) lightBishop = true;
    else darkBishop = true;
    const same = pawnsOnColour[colour]!;
    const central = centralOnColour[colour]!;
    if (same >= 3 && central >= 1) badBishops.push(sqName(s));
    else if (central === 0 && same < ownPawnCount - same) goodBishops.push(sqName(s));
  }

  /* ----- rooks ----- */
  const rooksOnOpenFiles: string[] = [];
  for (const s of rooks) if (own[s & 7]!.length === 0) rooksOnOpenFiles.push(sqName(s));
  let connectedRooks = false;
  for (let i = 0; i < rooks.length && !connectedRooks; i++) {
    for (let j = i + 1; j < rooks.length; j++) {
      const a = rooks[i]!;
      const b = rooks[j]!;
      if (a >> 3 !== backRank || b >> 3 !== backRank) continue;
      let clear = true;
      for (let s = a + 1; s < b; s++) if (sq[s] !== 0) clear = false;
      if (clear) connectedRooks = true;
    }
  }

  /* ----- king ----- */
  let kingShieldPawns = 0;
  let castled = false;
  let kingDanger = 0;
  if (ownKing >= 0) {
    const kf = ownKing & 7;
    const kr = ownKing >> 3;
    let files = 0;
    let bare = 0;
    for (let f = kf - 1; f <= kf + 1; f++) {
      if (f < 0 || f > 7) continue;
      files++;
      if (hasPawnAt(own, f, kr + sign) || hasPawnAt(own, f, kr + 2 * sign)) kingShieldPawns++;
      if (own[f]!.length === 0) bare++;
    }
    if (kr === backRank) {
      const base = backRank * 8;
      if (kf >= 6) {
        castled = true;
        for (let f = kf + 1; f <= 7; f++) if (sq[base + f] === sign * ROOK) castled = false;
      } else if (kf <= 2) {
        castled = true;
        for (let f = 0; f < kf; f++) if (sq[base + f] === sign * ROOK) castled = false;
      }
    }
    if (enemyPieces > 0) {
      const raw = files - kingShieldPawns + bare + Math.min(4, attackWeight);
      kingDanger = Math.min(10, enemyQueens > 0 ? raw : Math.floor(raw / 2));
    }
  }

  return {
    isolated,
    doubled,
    backward,
    passed,
    hangingPawns,
    iqp,
    semiOpenFiles,
    outposts,
    weakSquares,
    kingDanger,
    kingShieldPawns,
    castled,
    mobility,
    bishopPair: lightBishop && darkBishop,
    badBishops,
    goodBishops,
    space,
    development: minorsOut + (castled ? 1 : 0) + (connectedRooks ? 1 : 0),
    rooksOnOpenFiles,
    material,
  };
}

function structureLabel(scan: Scan, w: SideFeatures, b: SideFeatures): StructureLabel {
  const { wp, bp } = scan;
  const C = 2;
  const D = 3;
  const E = 4;
  const n = countOnFile;
  // 1. Carlsbad and its colour-reversed mirror.
  if (hasPawnAt(wp, D, 3) && hasPawnAt(bp, D, 4)) {
    if (n(wp, C) === 0 && n(wp, E) > 0 && n(bp, E) === 0 && (hasPawnAt(bp, C, 5) || hasPawnAt(bp, C, 6))) return 'carlsbad';
    if (n(bp, C) === 0 && n(bp, E) > 0 && n(wp, E) === 0 && (hasPawnAt(wp, C, 2) || hasPawnAt(wp, C, 1))) return 'carlsbad';
  }
  // 2. Maroczy bind.
  if (hasPawnAt(wp, C, 3) && hasPawnAt(wp, E, 3) && n(wp, D) === 0 && n(bp, C) === 0 && !hasPawnAt(bp, D, 4)) return 'maroczy-white';
  if (hasPawnAt(bp, C, 4) && hasPawnAt(bp, E, 4) && n(bp, D) === 0 && n(wp, C) === 0 && !hasPawnAt(wp, D, 3)) return 'maroczy-black';
  // 3. IQP on the 4th/5th relative rank, one side only.
  const wIqp = w.iqp && (wp[D]![0] === 3 || wp[D]![0] === 4);
  const bIqp = b.iqp && (bp[D]![0] === 4 || bp[D]![0] === 3);
  if (wIqp && !bIqp) return 'iqp-white';
  if (bIqp && !wIqp) return 'iqp-black';
  // 4. Hanging pawns, one side only.
  if (w.hangingPawns.length > 0 && b.hangingPawns.length === 0) return 'hanging-pawns-white';
  if (b.hangingPawns.length > 0 && w.hangingPawns.length === 0) return 'hanging-pawns-black';
  // 5. Closed centre: a ram on both central files.
  const ram = (f: number): boolean => wp[f]!.some((r) => hasPawnAt(bp, f, r + 1));
  if (ram(D) && ram(E)) return 'closed-centre';
  // 6. Open centre.
  const centreEmpty = ![wp, bp].some((p) => hasPawnAt(p, D, 3) || hasPawnAt(p, D, 4) || hasPawnAt(p, E, 3) || hasPawnAt(p, E, 4));
  if (centreEmpty && (n(wp, D) + n(bp, D) === 0 || n(wp, E) + n(bp, E) === 0)) return 'open-centre';
  // 7. Symmetrical.
  let pawns = 0;
  let mirrored = true;
  for (let f = 0; f < 8 && mirrored; f++) {
    const wr = wp[f]!;
    const br = bp[f]!;
    pawns += wr.length;
    if (wr.length !== br.length) mirrored = false;
    else for (const r of wr) if (!br.includes(7 - r)) mirrored = false;
  }
  if (mirrored && pawns > 0) return 'symmetrical';
  return 'other';
}

/** Feature extraction from an already parsed board (used by plans/motifs to avoid re-parsing). */
export function extractFromBoard(board: Board, fen: string): PositionFeatures {
  const scan: Scan = { sq: board.sq, wp: pawnFiles(board.sq, 1), bp: pawnFiles(board.sq, -1) };
  const w = sideFeatures(scan, 1);
  const b = sideFeatures(scan, -1);
  const openFiles: string[] = [];
  for (let f = 0; f < 8; f++) if (scan.wp[f]!.length === 0 && scan.bp[f]!.length === 0) openFiles.push(FILE_LETTERS.charAt(f));
  return {
    fen,
    w,
    b,
    openFiles,
    structure: structureLabel(scan, w, b),
    phase: phaseOf(fen),
    materialSignature: materialSignature(fen),
  };
}

export const extractFeatures: ExtractFeatures = (fen) => extractFromBoard(parseFen(fen), fen);
