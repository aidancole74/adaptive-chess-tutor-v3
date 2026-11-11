/** Pawn endings: rule of the square, opposition, key squares, pawn races, outside passed pawn. */
import { F, R, dist, fenOf, near, pick, placementOf, randSq, ri, sq, uci, type Placement, type Rng, type Sq } from './board';
import { kpkBlackMoves, kpkLegal, kpkWhiteMoves, kpkWin } from './local';
import { best, from, isCapture, to, type Generator } from './types';

/* ---------- rule of the square ---------- */

/** Pawn moves still needed to promote (a pawn on its 2nd rank counts as on the 3rd: double step). */
const stepsToPromote = (p: Sq): number => 7 - Math.max(R(p), 2);

const ruleOfTheSquare: Generator = {
  concept: 'endgames/pawn/rule-of-the-square',
  property:
    'K+P vs K with the attacking king too far away to help; the tablebase result equals the square-rule prediction ' +
    '(defender inside the square: draw; outside: the pawn wins; the defender-to-move side ships only the drawing case). Winning items must have the pawn push among the winning moves.',
  buckets: { 'w-win': 0.4, 'w-draw': 0.3, 'b-draw': 0.4 },
  candidate(rng) {
    const p = sq(ri(rng, 0, 7), ri(rng, 1, 5));
    const n = stepsToPromote(p);
    const promo = sq(F(p), 7);
    const stm = rng() < 0.5 ? 'w' : 'b';
    // Inside the square: the defender reaches the queening square in time.
    const limit = stm === 'b' ? n : n - 1;
    const bk = near(rng, promo, Math.max(1, limit - 1), limit + 2);
    const wk = randSq(rng);
    if (bk < 0 || dist(wk, promo) < n + 2 || dist(wk, p) < 3 || R(wk) > R(p)) return null;
    const inside = dist(bk, promo) <= limit;
    const fen = fenOf(
      [
        ['K', wk],
        ['k', bk],
        ['P', p],
      ],
      stm,
    );
    if (!fen) return null;
    if (stm === 'b' && !inside) return null;
    const bucket = stm === 'w' ? (inside ? 'w-draw' : 'w-win') : 'b-draw';
    return { fen, bucket, d: { p } };
  },
  accept(c, pr) {
    const expected = c.bucket === 'w-win' ? 'win' : 'draw';
    if (pr.category !== expected) return null;
    const p = c.d?.p ?? -1;
    if (c.bucket === 'w-win' && !best(pr).some((m) => from(m) === p)) return null;
    // The defender must actually have to choose: some king moves leave the square.
    if (c.bucket === 'b-draw' && best(pr).length === pr.moves.length) return null;
    return { bucket: c.bucket ?? '', playout: true };
  },
};

/* ---------- opposition ---------- */

/** Direct, diagonal or distant opposition between two kings. */
export function inOpposition(a: Sq, b: Sq): boolean {
  const df = Math.abs(F(a) - F(b));
  const dr = Math.abs(R(a) - R(b));
  const even = (n: number): boolean => n === 2 || n === 4 || n === 6;
  return (df === 0 && even(dr)) || (dr === 0 && even(df)) || (df === 2 && dr === 2);
}

function kpkPlacement(rng: Rng, maxKingDist: number, files: [number, number] = [0, 7]): { wk: Sq; bk: Sq; p: Sq } | null {
  const p = sq(ri(rng, files[0], files[1]), ri(rng, 1, 5));
  const wk = near(rng, p, 1, maxKingDist);
  const bk = near(rng, p, 1, maxKingDist);
  if (wk < 0 || bk < 0) return null;
  return { wk, bk, p };
}

const kpkFen = (wk: Sq, bk: Sq, p: Sq, stm: 'w' | 'b'): string | null =>
  fenOf(
    [
      ['K', wk],
      ['k', bk],
      ['P', p],
    ],
    stm,
  );

const opposition: Generator = {
  concept: 'endgames/pawn/opposition',
  property:
    'K+P vs K where exactly one move keeps the result (attacker: only winning move; defender: only drawing move), ' +
    'that move is a king move, and after it the kings stand in direct, diagonal or distant opposition.',
  buckets: { att: 0.55, def: 0.55 },
  candidate(rng) {
    for (let i = 0; i < 400; i++) {
      const k = kpkPlacement(rng, 3);
      if (!k) continue;
      const { wk, bk, p } = k;
      if (rng() < 0.5) {
        if (!kpkLegal('w', wk, bk, p)) continue;
        const wins = kpkWhiteMoves(wk, bk, p).filter((m) => m.whiteWins);
        const m = wins[0];
        if (wins.length !== 1 || !m || m.pawn || !inOpposition(m.to, bk)) continue;
        const fen = kpkFen(wk, bk, p, 'w');
        if (fen) return { fen, bucket: 'att', move: uci(m.from, m.to) };
      } else {
        if (!kpkLegal('b', wk, bk, p)) continue;
        const ms = kpkBlackMoves(wk, bk, p);
        const draws = ms.filter((m) => !m.whiteWins);
        const m = draws[0];
        if (ms.length < 2 || draws.length !== 1 || !m || m.capture || !inOpposition(m.to, wk)) continue;
        const fen = kpkFen(wk, bk, p, 'b');
        if (fen) return { fen, bucket: 'def', move: uci(m.from, m.to) };
      }
    }
    return null;
  },
  accept(c, pr) {
    if (pr.category !== (c.bucket === 'att' ? 'win' : 'draw')) return null;
    const b = best(pr);
    if (b.length !== 1 || b[0]?.uci !== c.move || pr.moves.length < 2) return null;
    return { bucket: c.bucket ?? '', playout: true };
  },
};

/* ---------- key squares ---------- */

/** Structural key squares of a white non-rook pawn (used as the test; the tablebase decides the result). */
export function keySquares(p: Sq): Sq[] {
  const out: Sq[] = [];
  const ranks = R(p) <= 3 ? [R(p) + 2] : [R(p) + 1, R(p) + 2];
  for (const r of ranks) for (const f of [F(p) - 1, F(p), F(p) + 1]) if (r <= 7 && f >= 0 && f <= 7) out.push(sq(f, r));
  return out;
}
const keyDist = (s: Sq, keys: Sq[]): number => Math.min(...keys.map((k) => dist(s, k)));

const keySquaresGen: Generator = {
  concept: 'endgames/pawn/key-squares',
  property:
    'K+P (non-rook pawn) vs K, attacker to move and winning; no pawn move wins, at most two king moves win, ' +
    'and a winning king move lands on a key square of the pawn or gets strictly closer to one.',
  buckets: { only: 0.6, two: 0.5 },
  candidate(rng) {
    for (let i = 0; i < 400; i++) {
      const k = kpkPlacement(rng, 3, [1, 6]);
      if (!k) continue;
      const { wk, bk, p } = k;
      if (!kpkLegal('w', wk, bk, p)) continue;
      const keys = keySquares(p);
      if (keys.includes(wk)) continue;
      const wins = kpkWhiteMoves(wk, bk, p).filter((m) => m.whiteWins);
      if (wins.length < 1 || wins.length > 2 || wins.some((m) => m.pawn)) continue;
      if (!wins.some((m) => keyDist(m.to, keys) < keyDist(wk, keys))) continue;
      const fen = kpkFen(wk, bk, p, 'w');
      if (fen) return { fen, bucket: wins.length === 1 ? 'only' : 'two', d: { p, wk } };
    }
    return null;
  },
  accept(c, pr) {
    if (pr.category !== 'win') return null;
    const p = c.d?.p ?? -1;
    const wk = c.d?.wk ?? -1;
    const keys = keySquares(p);
    const b = best(pr);
    if (b.length > 2 || b.some((m) => from(m) === p)) return null;
    if (!b.some((m) => keyDist(to(m), keys) < keyDist(wk, keys))) return null;
    return { bucket: b.length === 1 ? 'only' : 'two', playout: true };
  },
};

/* ---------- pawn race ---------- */

const pawnRace: Generator = {
  concept: 'endgames/pawn/pawn-race',
  property:
    'K+P vs K+P, passed pawns at least two files apart, each king outside the square of the enemy pawn and off both pawn paths, ' +
    'pawns within one tempo of each other; the tablebase labels the race (win / draw; lost races are dropped). The pawn push is among the best moves.',
  buckets: { win: 0.6, draw: 0.5 },
  candidate(rng) {
    const wp = sq(ri(rng, 0, 7), ri(rng, 1, 5));
    const bp = sq(ri(rng, 0, 7), ri(rng, 2, 6));
    if (Math.abs(F(wp) - F(bp)) < 2) return null;
    const nw = stepsToPromote(wp);
    const nb = Math.min(R(bp), 5);
    if (Math.abs(nw - nb) > 1) return null;
    const wk = randSq(rng);
    const bk = randSq(rng);
    // White moves first: the black king needs dist <= nw - 1 to catch; the white king needs dist <= nb.
    if (dist(bk, sq(F(wp), 7)) < nw + 1 || dist(wk, sq(F(bp), 0)) < nb + 2) return null;
    if ((F(wk) === F(wp) && R(wk) > R(wp)) || (F(bk) === F(wp) && R(bk) > R(wp))) return null;
    if ((F(wk) === F(bp) && R(wk) < R(bp)) || (F(bk) === F(bp) && R(bk) < R(bp))) return null;
    const fen = fenOf(
      [
        ['K', wk],
        ['k', bk],
        ['P', wp],
        ['p', bp],
      ],
      'w',
    );
    return fen ? { fen, d: { wp } } : null;
  },
  accept(c, pr) {
    const wp = c.d?.wp ?? -1;
    if (pr.category === 'loss' || !best(pr).some((m) => from(m) === wp)) return null;
    return { bucket: pr.category, playout: pr.category === 'win' };
  },
};

/* ---------- outside passed pawn ---------- */

const outsidePasser: Generator = {
  concept: 'endgames/pawn/outside-passed-pawn',
  property:
    'Pawn ending (5 or 7 pieces): the side to move has a passed pawn on the a/b (or g/h) file at least three files from every other pawn, ' +
    'the defending king is inside its square, equal pawns on the other wing; the tablebase says win, no winning first move is a capture, ' +
    'and the same position without the passed pawn is NOT a win (second probe).',
  buckets: { p5: 0.75, p7: 0.35 },
  probeFactor: 4,
  candidate(rng) {
    const passer = sq(ri(rng, 0, 1), ri(rng, 1, 4));
    const pairs = rng() < 0.7 ? 1 : 2;
    const pl: Placement = [['P', passer]];
    for (let i = 0; i < pairs; i++) {
      const f = ri(rng, 4, 7);
      const r1 = ri(rng, 1, 3);
      const f2 = f + pick(rng, [-1, 0, 0, 1]);
      if (f2 < 4 || f2 > 7) return null;
      pl.push(['P', sq(f, r1)], ['p', sq(f2, ri(rng, r1 + 1, 6))]);
    }
    const wk = sq(ri(rng, 2, 7), ri(rng, 0, 7));
    const bk = sq(ri(rng, 2, 7), ri(rng, 0, 7));
    if (dist(bk, sq(F(passer), 7)) > stepsToPromote(passer) - 1) return null;
    pl.push(['K', wk], ['k', bk]);
    const fen = fenOf(pl, 'w');
    return fen ? { fen, bucket: pairs === 1 ? 'p5' : 'p7', d: { passer } } : null;
  },
  async accept(c, pr, ctx) {
    if (pr.category !== 'win' || best(pr).some(isCapture)) return null;
    const passer = c.d?.passer ?? -1;
    const without = fenOf(
      placementOf(c.fen).filter(([, s]) => s !== passer),
      'w',
    );
    if (!without) return null;
    const q = await ctx.probe(without);
    if (!q || q.category === 'win') return null;
    return { bucket: c.bucket ?? '', playout: true };
  },
};

export const pawnGenerators: Generator[] = [ruleOfTheSquare, opposition, keySquaresGen, pawnRace, outsidePasser];
export { kpkWin };
