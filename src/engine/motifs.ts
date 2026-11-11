/**
 * Rule-based motif detectors used to classify mistakes found in the user's games.
 *
 * Every detector is a pure function of a position and a "key move" (the engine's best move the
 * mover missed, or the opponent's refutation the mover allowed). They are pattern matchers over
 * the board after the key move, NOT proofs: the engine evaluation says the move is strong, the
 * detector only suggests which pattern the move shows. `classifyMistake` reports `unclassified`
 * when nothing fires so the app can state detector coverage honestly.
 *
 * Shared vocabulary:
 * - values: P=1, N=3, B=3, R=5, Q=9; the king is always the most valuable target.
 * - "wins material": the static exchange evaluation (`see`) of the capture is positive. SEE ignores
 *   pins, checks, promotions and anything away from the capture square.
 * - "safe": the opponent cannot capture the key piece with a positive SEE.
 */
import { Chess } from 'chess.js';
import { TACTIC_THEME_TO_CONCEPT } from '../curriculum/concepts';
import { tryMove } from './chessUtil';
import {
  BISHOP, KING, KNIGHT, PAWN, PIECE_NAME, PIECE_VALUE, QUEEN, RAYS, ROOK,
  attackersOf, attacksFrom, fileOf, oppositeDir, parseFen, seeCapture, seeOnBoard, signOf, sliderDirs, sqIndex, sqName, typeAt,
  type Board, type Sign,
} from './features/board';
import { extractFeatures } from './features/extract';
import { FEATURE_TO_CONCEPT, featureDeltas, parseFeatureDelta } from './features/flags';

export interface MistakeContext {
  /** Position before the mistake. */
  fen: string;
  playedUci: string;
  bestUci: string;
  /** Engine PV from `fen` (UCI). */
  bestPv: string[];
  /** Engine PV after the played move (UCI), opponent to move first. */
  refutationPv: string[];
  /** Both evaluations are from the mover's point of view, in centipawns. */
  evalBeforeCp: number;
  evalAfterCp: number;
  /** Mate-in-N available to the mover before the move, or null. */
  mateBefore: number | null;
  /** Mate-in-N against the mover after the move, or null. */
  mateAfter: number | null;
}

export interface DetectedMotif {
  /** Lichess theme name for tactical motifs; the feature name for a missed strategic feature. */
  theme: string;
  conceptId: string;
  /** 'missed': the mover had it. 'allowed': the mover's move let the opponent do it. */
  kind: 'missed' | 'allowed';
  squares: string[];
  detail: string;
}

/** What a single detector returns; `detectMotifs` adds `kind` and `conceptId`. */
export interface MotifHit {
  theme: string;
  squares: string[];
  detail: string;
}

export const DETECTOR_NAMES = [
  'mateInN', 'backRank', 'hangingPiece', 'fork', 'pin', 'skewer', 'discoveredAttack', 'strategicFeature',
] as const;
export type DetectorName = (typeof DETECTOR_NAMES)[number];

/** Strategic detector only runs below this centipawn loss (larger losses are almost always tactical). */
export const STRATEGIC_MAX_CP_LOSS = 300;
/** Minimum SEE gain (pawns) for the hanging-piece detector: more than a pawn. */
export const HANGING_MIN_GAIN = 2;

/* ---------- shared helpers ---------- */

interface KeyMove {
  before: Board;
  after: Board;
  afterFen: string;
  from: number;
  to: number;
  sign: Sign;
  /** Type of the piece standing on `to` after the move (the promoted piece for promotions). */
  type: number;
}

/** Plays `uci` with chess.js (legality) and returns both array boards; null when illegal. */
function keyMove(fen: string, uci: string | undefined): KeyMove | null {
  if (!uci) return null;
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  if (!tryMove(chess, uci)) return null;
  const before = parseFen(fen);
  const afterFen = chess.fen();
  const after = parseFen(afterFen);
  const to = sqIndex(uci.slice(2, 4));
  return { before, after, afterFen, from: sqIndex(uci.slice(0, 2)), to, sign: signOf(before.turn), type: typeAt(after.sq, to) };
}

function pieceLabel(sq: Int8Array, s: number): string {
  return `${PIECE_NAME[typeAt(sq, s)]} on ${sqName(s)}`;
}
function value(sq: Int8Array, s: number): number {
  return PIECE_VALUE[typeAt(sq, s)] ?? 0;
}
function isSafe(k: KeyMove): boolean {
  return seeOnBoard(k.after.sq, k.to, -k.sign as Sign) === 0;
}

/* ---------- static exchange evaluation ---------- */

/**
 * Static exchange evaluation: material (in pawns, >= 0) the side to move in `fen` wins by starting
 * captures on `square`, with both sides recapturing with their least valuable piece and free to
 * stop. 0 when the square is empty, holds the mover's own piece, or no capture is profitable.
 * Ignores pins, checks and promotions.
 */
export function see(fen: string, square: string): number {
  const b = parseFen(fen);
  const s = sqIndex(square);
  if (s < 0) return 0;
  return seeOnBoard(b.sq, s, signOf(b.turn));
}

/** Enemy pieces the side to move can capture with SEE >= HANGING_MIN_GAIN, largest gain first. */
export function hangingPieces(fen: string): { square: string; gain: number }[] {
  const b = parseFen(fen);
  const sign = signOf(b.turn);
  const out: { square: string; gain: number }[] = [];
  for (let s = 0; s < 64; s++) {
    if (b.sq[s]! * sign >= 0 || typeAt(b.sq, s) === KING) continue;
    const gain = seeOnBoard(b.sq, s, sign);
    if (gain >= HANGING_MIN_GAIN) out.push({ square: sqName(s), gain });
  }
  return out.sort((x, y) => y.gain - x.gain);
}

/* ---------- detectors ---------- */

/**
 * Hanging piece: `uci` is a capture whose static exchange value is at least HANGING_MIN_GAIN
 * pawns, i.e. it takes an undefended or under-defended piece.
 */
export function detectHangingPiece(fen: string, uci: string | undefined): MotifHit | null {
  const k = keyMove(fen, uci);
  if (!k) return null;
  const enPassant = typeAt(k.before.sq, k.from) === PAWN && k.to === k.before.ep && fileOf(k.from) !== fileOf(k.to);
  if (k.before.sq[k.to] === 0 && !enPassant) return null;
  const gain = seeCapture(k.before.sq, k.from, k.to, k.before.ep);
  if (gain < HANGING_MIN_GAIN) return null;
  const defended = attackersOf(k.before.sq, k.to, -k.sign as Sign).length > 0;
  return {
    theme: 'hangingPiece',
    squares: [sqName(k.to), sqName(k.from)],
    detail: `The ${pieceLabel(k.before.sq, k.to)} is ${defended ? 'under-defended' : 'undefended'}: capturing it with the ${pieceLabel(k.before.sq, k.from)} wins ${gain} points of material (static exchange count)`,
  };
}

/**
 * Fork: after `uci` the moved piece (not a king) attacks two or more targets, where a target is
 * the enemy king or an enemy piece (not a pawn) whose capture by the moved piece wins material,
 * and the moved piece is safe.
 */
export function detectFork(fen: string, uci: string | undefined): MotifHit | null {
  const k = keyMove(fen, uci);
  if (!k || k.type === KING) return null;
  const sq = k.after.sq;
  const targets: number[] = [];
  for (const t of attacksFrom(sq, k.to)) {
    if (sq[t]! * k.sign >= 0) continue;
    const tt = typeAt(sq, t);
    if (tt === KING || (tt >= KNIGHT && seeCapture(sq, k.to, t) > 0)) targets.push(t);
  }
  if (targets.length < 2 || !isSafe(k)) return null;
  return {
    theme: 'fork',
    squares: [sqName(k.to), ...targets.map(sqName)],
    detail: `The ${pieceLabel(sq, k.to)} attacks ${targets.map((t) => `the ${pieceLabel(sq, t)}`).join(' and ')} at the same time`,
  };
}

interface Line {
  front: number;
  back: number;
}
/** For a slider on `to`: each ray whose first two pieces are both enemy pieces. */
function enemyPairsOnRays(k: KeyMove): Line[] {
  const sq = k.after.sq;
  const out: Line[] = [];
  for (const d of sliderDirs(k.type)) {
    let front = -1;
    for (const s of RAYS[k.to]![d]!) {
      const p = sq[s]!;
      if (p === 0) continue;
      if (p * k.sign > 0) break;
      if (front < 0) {
        front = s;
        continue;
      }
      out.push({ front, back: s });
      break;
    }
  }
  return out;
}
/** Number of enemy defenders of `target`, not counting a defender standing on `ignore`. */
function defenders(sq: Int8Array, target: number, owner: Sign, ignore: number): number {
  return attackersOf(sq, target, owner).filter((s) => s !== ignore).length;
}

/**
 * Pin: after `uci` the moved bishop/rook/queen is safe and looks along a line at an enemy piece
 * (not a pawn, not the king) with a MORE valuable enemy piece directly behind it, where the piece
 * behind is the king, or is worth more than the pinning piece, or is undefended.
 */
export function detectPin(fen: string, uci: string | undefined): MotifHit | null {
  const k = keyMove(fen, uci);
  if (!k || sliderDirs(k.type).length === 0) return null;
  const sq = k.after.sq;
  const enemy = -k.sign as Sign;
  for (const { front, back } of enemyPairsOnRays(k)) {
    const ft = typeAt(sq, front);
    const bt = typeAt(sq, back);
    if (ft === PAWN || ft === KING) continue;
    if (value(sq, back) <= value(sq, front)) continue;
    if (!(bt === KING || value(sq, back) > value(sq, k.to) || defenders(sq, back, enemy, front) === 0)) continue;
    if (!isSafe(k)) return null;
    return {
      theme: 'pin',
      squares: [sqName(k.to), sqName(front), sqName(back)],
      detail: `The ${pieceLabel(sq, k.to)} pins the ${pieceLabel(sq, front)} to the ${pieceLabel(sq, back)}`,
    };
  }
  return null;
}

/**
 * Skewer: after `uci` the moved bishop/rook/queen is safe and attacks an enemy piece that is the
 * king or worth more than the slider, with a LESS valuable enemy piece (not a pawn) directly
 * behind it on the same line that is undefended (not counting the front piece) or worth more than
 * the slider.
 */
export function detectSkewer(fen: string, uci: string | undefined): MotifHit | null {
  const k = keyMove(fen, uci);
  if (!k || sliderDirs(k.type).length === 0) return null;
  const sq = k.after.sq;
  const enemy = -k.sign as Sign;
  for (const { front, back } of enemyPairsOnRays(k)) {
    const bt = typeAt(sq, back);
    if (bt === PAWN || bt === KING) continue;
    if (value(sq, front) <= value(sq, k.to)) continue;
    if (value(sq, back) >= value(sq, front)) continue;
    if (!(value(sq, back) > value(sq, k.to) || defenders(sq, back, enemy, front) === 0)) continue;
    if (!isSafe(k)) return null;
    return {
      theme: 'skewer',
      squares: [sqName(k.to), sqName(front), sqName(back)],
      detail: `The ${pieceLabel(sq, k.to)} attacks the ${pieceLabel(sq, front)}; when it moves, the ${pieceLabel(sq, back)} behind it is lost`,
    };
  }
  return null;
}

/**
 * Discovered attack: `uci` moves a piece off a line so that a friendly bishop/rook/queen behind
 * it now attacks an enemy target through the vacated square. A target is the king (discovered
 * check) or a piece (not a pawn) that is worth more than the slider or whose capture by the slider
 * wins material.
 */
export function detectDiscoveredAttack(fen: string, uci: string | undefined): MotifHit | null {
  const k = keyMove(fen, uci);
  if (!k) return null;
  const sq = k.after.sq;
  const firstPiece = (ray: readonly number[]): number => {
    for (const s of ray) if (sq[s] !== 0) return s;
    return -1;
  };
  for (let d = 0; d < 8; d++) {
    const slider = firstPiece(RAYS[k.from]![d]!);
    if (slider < 0 || slider === k.to || sq[slider]! * k.sign <= 0) continue;
    const st = typeAt(sq, slider);
    if (!(st === QUEEN || st === (d < 4 ? ROOK : BISHOP))) continue;
    const target = firstPiece(RAYS[k.from]![oppositeDir(d)]!);
    if (target < 0 || sq[target]! * k.sign >= 0) continue;
    const tt = typeAt(sq, target);
    const hit = tt === KING || (tt >= KNIGHT && (value(sq, target) > value(sq, slider) || seeCapture(sq, slider, target) > 0));
    if (!hit) continue;
    return {
      theme: 'discoveredAttack',
      squares: [sqName(k.to), sqName(slider), sqName(target)],
      detail: `Moving the ${PIECE_NAME[typeAt(k.before.sq, k.from)]} from ${sqName(k.from)} uncovers the ${pieceLabel(sq, slider)}'s attack on the ${pieceLabel(sq, target)}`,
    };
  }
  return null;
}

/**
 * Back rank: somewhere in the first 5 attacker moves of `pv` (played from `fen`, attacker to move)
 * a rook or queen gives check on the defender's back rank while the defending king stands on that
 * rank with every square directly in front of it occupied by its own pieces (at least one a pawn),
 * and either it is checkmate or the king has no legal move and the checking piece cannot be captured.
 */
export function detectBackRank(fen: string, pv: string[]): MotifHit | null {
  let chess: Chess;
  try {
    chess = new Chess(fen);
  } catch {
    return null;
  }
  const defender = chess.turn() === 'w' ? 'b' : 'w';
  const backRank = defender === 'w' ? 0 : 7;
  const dSign = signOf(defender);
  for (let i = 0; i < pv.length && i < 9; i++) {
    const m = tryMove(chess, pv[i]!);
    if (!m) return null;
    if (i % 2 === 1 || !chess.isCheck()) continue;
    const mover = m.promotion ?? m.piece;
    const to = sqIndex(m.to);
    if ((mover !== 'r' && mover !== 'q') || to >> 3 !== backRank) continue;
    const sq = parseFen(chess.fen()).sq;
    const king = sq.indexOf(dSign * KING);
    if (king < 0 || king >> 3 !== backRank) continue;
    let boxed = true;
    let pawns = 0;
    for (let f = fileOf(king) - 1; f <= fileOf(king) + 1; f++) {
      if (f < 0 || f > 7) continue;
      const p = sq[(backRank + dSign) * 8 + f]!;
      if (p * dSign <= 0) boxed = false;
      if (p === dSign * PAWN) pawns++;
    }
    if (!boxed || pawns === 0) continue;
    const mate = chess.isCheckmate();
    if (!mate) {
      const replies = chess.moves({ verbose: true });
      if (replies.some((r) => r.piece === 'k' || r.to === m.to)) continue;
    }
    return {
      theme: 'backRankMate',
      squares: [m.to, sqName(king)],
      detail: mate
        ? `${m.san} is checkmate on the back rank: the king on ${sqName(king)} is boxed in by its own pawns`
        : `${m.san} is a back-rank check: the king on ${sqName(king)} is boxed in by its own pawns and has no flight square`,
    };
  }
  return null;
}

function mateTheme(n: number): string {
  return `mateIn${Math.min(5, Math.max(1, n))}`;
}

/**
 * Mate in N straight from the engine scores: `mateBefore` > 0 is a mate the mover missed,
 * `mateAfter` > 0 a mate the move allowed. N >= 5 maps to mateIn5 ("mate in 5 or more").
 */
export function detectMateInN(ctx: Pick<MistakeContext, 'mateBefore' | 'mateAfter' | 'bestPv' | 'bestUci' | 'refutationPv'>): (MotifHit & { kind: 'missed' | 'allowed' })[] {
  const out: (MotifHit & { kind: 'missed' | 'allowed' })[] = [];
  const squaresOf = (uci: string | undefined): string[] => (uci && uci.length >= 4 ? [uci.slice(0, 2), uci.slice(2, 4)] : []);
  if (ctx.mateBefore !== null && ctx.mateBefore > 0) {
    out.push({
      theme: mateTheme(ctx.mateBefore),
      kind: 'missed',
      squares: squaresOf(ctx.bestPv[0] ?? ctx.bestUci),
      detail: `There was a forced mate in ${ctx.mateBefore} (engine)`,
    });
  }
  if (ctx.mateAfter !== null && ctx.mateAfter > 0) {
    out.push({
      theme: mateTheme(ctx.mateAfter),
      kind: 'allowed',
      squares: squaresOf(ctx.refutationPv[0]),
      detail: `The move allows a forced mate in ${ctx.mateAfter} (engine)`,
    });
  }
  return out;
}

/**
 * Missed strategic feature (HEURISTIC): compares the feature flags after the best move with those
 * after the played move. Reports, as 'missed', every flag in the mover's favour that the best move
 * would have gained and the played move did not; and, as 'allowed', every flag in the opponent's
 * favour that the played move created and the best move would not have.
 * Callers gate this on "no tactical motif fired and cp loss < STRATEGIC_MAX_CP_LOSS".
 */
export function detectMissedStrategic(fen: string, bestUci: string | undefined, playedUci: string): DetectedMotif[] {
  const best = keyMove(fen, bestUci);
  const played = keyMove(fen, playedUci);
  if (!best || !played) return [];
  const mover = parseFen(fen).turn;
  const base = extractFeatures(fen);
  const dBest = featureDeltas(base, extractFeatures(best.afterFen));
  const dPlayed = featureDeltas(base, extractFeatures(played.afterFen));
  const out: DetectedMotif[] = [];
  for (const d of dBest) {
    const p = parseFeatureDelta(d);
    if (!p || !p.gained || p.side !== mover || dPlayed.includes(d)) continue;
    out.push({
      theme: p.name,
      conceptId: FEATURE_TO_CONCEPT[p.name],
      kind: 'missed',
      squares: [sqName(best.from), sqName(best.to)],
      detail: `Heuristic: the engine's move would have gained the positional feature "${p.name}" for the mover; the played move did not`,
    });
  }
  for (const d of dPlayed) {
    const p = parseFeatureDelta(d);
    if (!p || !p.gained || p.side === mover || dBest.includes(d)) continue;
    out.push({
      theme: p.name,
      conceptId: FEATURE_TO_CONCEPT[p.name],
      kind: 'allowed',
      squares: [sqName(played.from), sqName(played.to)],
      detail: `Heuristic: the played move gave the opponent the positional feature "${p.name}"; the engine's move would not have`,
    });
  }
  return out;
}

/* ---------- orchestration ---------- */

function fenAfter(fen: string, uci: string): string | null {
  try {
    const chess = new Chess(fen);
    return tryMove(chess, uci) ? chess.fen() : null;
  } catch {
    return null;
  }
}

function withKind(hit: MotifHit | null, kind: 'missed' | 'allowed', out: DetectedMotif[]): void {
  if (!hit) return;
  const conceptId = TACTIC_THEME_TO_CONCEPT.get(hit.theme);
  if (conceptId) out.push({ ...hit, conceptId, kind });
}

/**
 * Runs every detector twice: on the best move from `fen` ('missed') and on the refutation's first
 * move from the position after the played move ('allowed'). The strategic detector only runs when
 * no tactical detector fired and the centipawn loss is below STRATEGIC_MAX_CP_LOSS.
 */
export function detectMotifs(ctx: MistakeContext): DetectedMotif[] {
  const out: DetectedMotif[] = [];
  for (const m of detectMateInN(ctx)) withKind(m, m.kind, out);

  const bestKey = ctx.bestPv[0] ?? ctx.bestUci;
  const bestPv = ctx.bestPv.length > 0 ? ctx.bestPv : ctx.bestUci ? [ctx.bestUci] : [];
  const afterPlayed = fenAfter(ctx.fen, ctx.playedUci);
  const runs: { kind: 'missed' | 'allowed'; fen: string; key: string | undefined; pv: string[] }[] = [];
  if (bestKey && bestKey !== ctx.playedUci) runs.push({ kind: 'missed', fen: ctx.fen, key: bestKey, pv: bestPv });
  if (afterPlayed) runs.push({ kind: 'allowed', fen: afterPlayed, key: ctx.refutationPv[0], pv: ctx.refutationPv });

  for (const r of runs) {
    withKind(detectBackRank(r.fen, r.pv), r.kind, out);
    let hanging = detectHangingPiece(r.fen, r.key);
    if (!hanging && r.kind === 'allowed' && !r.key) {
      // No refutation line supplied: fall back to the largest static hanging piece.
      const h = hangingPieces(r.fen)[0];
      if (h) hanging = { theme: 'hangingPiece', squares: [h.square], detail: `The piece on ${h.square} can be captured for a gain of ${h.gain} points (static exchange count)` };
    }
    withKind(hanging, r.kind, out);
    withKind(detectFork(r.fen, r.key), r.kind, out);
    withKind(detectPin(r.fen, r.key), r.kind, out);
    withKind(detectSkewer(r.fen, r.key), r.kind, out);
    withKind(detectDiscoveredAttack(r.fen, r.key), r.kind, out);
  }

  if (out.length === 0 && ctx.evalBeforeCp - ctx.evalAfterCp < STRATEGIC_MAX_CP_LOSS && bestKey && bestKey !== ctx.playedUci) {
    out.push(...detectMissedStrategic(ctx.fen, bestKey, ctx.playedUci));
  }
  return out;
}

/** Most specific first; strategic features (any other theme) rank last. */
const THEME_PRIORITY: readonly string[] = [
  'backRankMate', 'mateIn1', 'mateIn2', 'mateIn3', 'hangingPiece', 'fork', 'skewer', 'pin', 'discoveredAttack', 'mateIn4', 'mateIn5',
];

/**
 * Picks one primary motif. Kind preference: when the mover stood clearly better before
 * (>= +150 cp) and is not clearly worse after (> -150 cp) the mistake is treated as a missed
 * chance and 'missed' motifs rank first; otherwise 'allowed' motifs do. Within a kind the order
 * is THEME_PRIORITY. `unclassified` is true when no detector fired.
 */
export function classifyMistake(ctx: MistakeContext): { motifs: DetectedMotif[]; primary: DetectedMotif | null; unclassified: boolean } {
  const motifs = detectMotifs(ctx);
  const preferred = ctx.evalBeforeCp >= 150 && ctx.evalAfterCp > -150 ? 'missed' : 'allowed';
  const rank = (m: DetectedMotif): number => {
    const i = THEME_PRIORITY.indexOf(m.theme);
    return (i < 0 ? THEME_PRIORITY.length : i) + (m.kind === preferred ? 0 : 100);
  };
  let primary: DetectedMotif | null = null;
  for (const m of motifs) if (!primary || rank(m) < rank(primary)) primary = m;
  return { motifs, primary, unclassified: motifs.length === 0 };
}
