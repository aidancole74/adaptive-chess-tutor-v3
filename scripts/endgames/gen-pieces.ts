/** Rook, queen, minor-piece and fortress generators (White is the side the structure describes). */
import { F, R, between, boardOf, colourOf, dist, fenOf, near, pick, randSq, ri, sq, type Placement, type Rng, type Sq } from './board';
import { best, from, isCapture, mover, to, type Generator } from './types';
import type { TbProbeOk } from '../../src/engine/tablebase';

const fen = (pl: Placement, stm: 'w' | 'b'): string | null => fenOf(pl, stm);
/** Some legal move changes the result: the position asks a real question. */
const hasWrongMove = (p: TbProbeOk): boolean => best(p).length < p.moves.length;

/* ---------- queen vs pawn on the 7th ---------- */

const kqkp: Generator = {
  concept: 'endgames/queen/kq-vs-kp',
  property:
    'K+Q vs K+P, the pawn one step from promotion with its king next to it and the queen side\'s king at least 4 squares away; ' +
    'queen side to move. Rook and bishop pawns (expected draws) and knight and centre pawns (expected wins) are generated; the tablebase labels each.',
  buckets: { 'rb-draw': 0.3, 'rb-win': 0.2, 'nc-win': 0.35, 'nc-draw': 0.15 },
  candidate(rng) {
    const pf = ri(rng, 0, 7);
    const p = sq(pf, 1);
    const bk = near(rng, p, 1, 1);
    const wk = randSq(rng);
    const q = randSq(rng);
    if (bk < 0 || dist(wk, p) < 4) return null;
    const f = fen(
      [
        ['K', wk],
        ['Q', q],
        ['k', bk],
        ['p', p],
      ],
      'w',
    );
    const rb = [0, 2, 5, 7].includes(pf);
    return f ? { fen: f, d: { rb: rb ? 1 : 0 } } : null;
  },
  accept(c, p) {
    if (p.category === 'loss') return null;
    const cls = c.d?.rb === 1 ? 'rb' : 'nc';
    return { bucket: `${cls}-${p.category}`, playout: true };
  },
};

/* ---------- rook endings ---------- */

/** Rook square cuts the king on bk off from target t along a file or a rank (and cannot simply be taken). */
export function cuts(r: Sq, bk: Sq, t: Sq, wk: Sq): 'file' | 'rank' | null {
  if (dist(r, bk) <= 1 && dist(r, wk) > 1) return null;
  if (between(F(r), F(bk), F(t))) return 'file';
  if (between(R(r), R(bk), R(t))) return 'rank';
  return null;
}

function krpkr(rng: Rng, opts: { pawnRanks: [number, number]; wkNear: boolean }): { pl: Placement; p: Sq; wk: Sq; bk: Sq; wr: Sq; br: Sq } | null {
  const p = sq(ri(rng, 0, 7), ri(rng, opts.pawnRanks[0], opts.pawnRanks[1]));
  const wk = opts.wkNear ? near(rng, p, 1, 2) : randSq(rng);
  const bk = randSq(rng);
  const wr = randSq(rng);
  const br = randSq(rng);
  if (wk < 0) return null;
  return {
    pl: [
      ['K', wk],
      ['R', wr],
      ['P', p],
      ['k', bk],
      ['r', br],
    ],
    p,
    wk,
    bk,
    wr,
    br,
  };
}

const cuttingOff: Generator = {
  concept: 'endgames/rook/cutting-off-king',
  property:
    'K+R+P vs K+R, attacker to move and winning; at most three winning moves, every one of them a rook move to a file (rank) strictly ' +
    'between the defending king and the pawn, the rook not capturable there; before the move the rook did not cut the king off; at least 5 moves fail to win.',
  buckets: { file: 0.7, rank: 0.5 },
  probeFactor: 5,
  candidate(rng) {
    const k = krpkr(rng, { pawnRanks: [1, 4], wkNear: true });
    if (!k) return null;
    const df = Math.abs(F(k.bk) - F(k.p));
    if (df < 2 || df > 4 || R(k.bk) < R(k.p) || cuts(k.wr, k.bk, k.p, k.wk)) return null;
    const f = fen(k.pl, 'w');
    return f ? { fen: f, d: { p: k.p, bk: k.bk, wk: k.wk, wr: k.wr } } : null;
  },
  accept(c, p) {
    if (p.category !== 'win') return null;
    const b = best(p);
    const d = c.d ?? {};
    const [ps, bk, wk, wr] = [d.p ?? -1, d.bk ?? -1, d.wk ?? -1, d.wr ?? -1];
    if (b.length > 3 || p.moves.length - b.length < 5) return null;
    const kinds = b.map((m) => (from(m) === wr && !isCapture(m) ? cuts(to(m), bk, ps, wk) : null));
    if (kinds.some((x) => x === null)) return null;
    return { bucket: kinds.includes('file') ? 'file' : 'rank', playout: false };
  },
};

/** Rook on the pawn's file, behind it (towards the pawn's own first rank), with a clear path to the pawn. */
function behind(r: Sq, p: Sq, board: string[]): boolean {
  if (F(r) !== F(p) || R(r) >= R(p)) return false;
  for (let rk = R(r) + 1; rk < R(p); rk++) if ((board[sq(F(p), rk)] ?? '') !== '') return false;
  return true;
}

const rookBehind: Generator = {
  concept: 'endgames/rook/rook-behind-passed-pawn',
  property:
    'K+R+P vs K+R with the pawn on its 3rd-5th rank and neither rook behind it; a rook move to the pawn\'s file behind the pawn ' +
    '(clear path) is among the best moves, and at least one third of the legal moves do not keep the result.',
  buckets: { attacker: 0.6, defender: 0.6 },
  probeFactor: 4,
  candidate(rng) {
    const k = krpkr(rng, { pawnRanks: [2, 4], wkNear: false });
    if (!k) return null;
    const stm = rng() < 0.5 ? 'w' : 'b';
    const mine = stm === 'w' ? k.wr : k.br;
    if (F(mine) === F(k.p) || F(k.wr) === F(k.p) || F(k.br) === F(k.p)) return null;
    // Some square behind the pawn on the rook's rank must be reachable along the rank (cheap pre-check).
    if (R(mine) >= R(k.p)) return null;
    if (dist(k.bk, k.p) < 2 || dist(k.wk, k.p) < 2) return null;
    const f = fen(k.pl, stm);
    return f ? { fen: f, bucket: stm === 'w' ? 'attacker' : 'defender', d: { p: k.p, r: mine } } : null;
  },
  accept(c, p) {
    if (p.category === 'loss') return null;
    const b = best(p);
    const ps = c.d?.p ?? -1;
    const r = c.d?.r ?? -1;
    const board = boardOf(c.fen);
    const ok = b.some((m) => {
      if (from(m) !== r) return false;
      const after = [...board];
      after[to(m)] = after[r] ?? '';
      after[r] = '';
      return behind(to(m), ps, after);
    });
    if (!ok || b.length * 3 > p.moves.length * 2) return null;
    return { bucket: c.bucket ?? '', playout: true };
  },
};

const lucena: Generator = {
  concept: 'endgames/rook/lucena',
  property:
    'K+R+P vs K+R: pawn (b-g file) on its 7th rank, attacker\'s king on the queening square, defending king at least two files away ' +
    'and cut off by the attacker\'s rook on a file in between; attacker to move; tablebase: win.',
  buckets: { win: 1 },
  candidate(rng) {
    const pf = ri(rng, 1, 6);
    const p = sq(pf, 6);
    const wk = sq(pf, 7);
    const bkf = pick(rng, [pf - 4, pf - 3, pf - 2, pf + 2, pf + 3, pf + 4]);
    if (bkf < 0 || bkf > 7) return null;
    const bk = sq(bkf, ri(rng, 3, 7));
    const wrf = bkf < pf ? ri(rng, bkf + 1, pf - 1) : ri(rng, pf + 1, bkf - 1);
    const wr = sq(wrf, ri(rng, 0, 5));
    const br = randSq(rng);
    if (dist(wr, bk) <= 1) return null;
    const f = fen(
      [
        ['K', wk],
        ['R', wr],
        ['P', p],
        ['k', bk],
        ['r', br],
      ],
      'w',
    );
    return f ? { fen: f } : null;
  },
  accept(_c, p) {
    return p.category === 'win' && hasWrongMove(p) ? { bucket: 'win', playout: true } : null;
  },
};

const philidor: Generator = {
  concept: 'endgames/rook/philidor',
  property:
    'K+R+P vs K+R: defending king on the pawn\'s queening square, pawn and attacking king not beyond the 5th rank; defender to move; ' +
    'tablebase: exact draw, and at most half of the defender\'s legal moves hold.',
  buckets: { 'third-rank': 0.7, other: 0.5 },
  probeFactor: 4,
  candidate(rng) {
    const pf = ri(rng, 0, 7);
    const p = sq(pf, ri(rng, 1, 4));
    const bk = sq(pf, 7);
    const wk = sq(ri(rng, 0, 7), ri(rng, 0, 4));
    const wr = randSq(rng);
    const br = sq(ri(rng, 0, 7), ri(rng, 5, 7));
    if (dist(wk, p) > 2) return null;
    const f = fen(
      [
        ['K', wk],
        ['R', wr],
        ['P', p],
        ['k', bk],
        ['r', br],
      ],
      'b',
    );
    return f ? { fen: f } : null;
  },
  accept(c, p) {
    if (p.category !== 'draw') return null;
    const b = best(p);
    if (b.length * 2 > p.moves.length) return null;
    // Defender's rook on the attacker's 6th rank (Philidor's defence) among the holding moves.
    const third = b.some((m) => mover(c.fen, m) === 'R' && R(to(m)) === 5);
    return { bucket: third ? 'third-rank' : 'other', playout: true };
  },
};

/* ---------- minor pieces ---------- */

const wrongBishop: Generator = {
  concept: 'endgames/minor/wrong-bishop',
  property:
    'K+B+rook pawn vs K, defending king within 3 squares of the queening corner. "wrong" = bishop does not control the queening square. ' +
    'Both bishop colours are generated; the tablebase labels the result.',
  buckets: { 'wrong-draw': 0.45, 'right-win': 0.35, 'wrong-win': 0.15, 'right-draw': 0.1 },
  candidate(rng) {
    const pf = pick(rng, [0, 7]);
    const p = sq(pf, ri(rng, 1, 5));
    const corner = sq(pf, 7);
    const bk = near(rng, corner, 0, 3);
    const wk = randSq(rng);
    const b = randSq(rng);
    if (bk < 0) return null;
    const stm = rng() < 0.5 ? 'w' : 'b';
    const f = fen(
      [
        ['K', wk],
        ['B', b],
        ['P', p],
        ['k', bk],
      ],
      stm,
    );
    const wrong = colourOf(b) !== colourOf(corner);
    return f ? { fen: f, d: { wrong: wrong ? 1 : 0 } } : null;
  },
  accept(c, p) {
    const white = c.fen.split(' ')[1] === 'w';
    const res = white ? p.category : p.category === 'win' ? 'loss' : p.category === 'loss' ? 'win' : 'draw';
    if (p.category === 'loss' || res === 'loss') return null;
    return { bucket: `${c.d?.wrong === 1 ? 'wrong' : 'right'}-${res}`, playout: true };
  },
};

function pawns(rng: Rng, white: number, black: number): Placement | null {
  const pl: Placement = [];
  for (let i = 0; i < white; i++) pl.push(['P', sq(ri(rng, 0, 7), ri(rng, 1, 5))]);
  for (let i = 0; i < black; i++) pl.push(['p', sq(ri(rng, 0, 7), ri(rng, 2, 6))]);
  return pl;
}

function bishops(concept: string, same: boolean): Generator {
  return {
    concept,
    property: `K+B+P(s) vs K+B(+P), ${same ? 'same' : 'opposite'}-coloured bishops, <= 7 pieces, attacker (more pawns) to move; at least one legal move changes the tablebase result.`,
    buckets: { win: 0.55, draw: 0.55 },
    probeFactor: 3,
    candidate(rng) {
      const wp = ri(rng, 1, 2);
      const bp = ri(rng, 0, wp - 1);
      const pl = pawns(rng, wp, bp);
      if (!pl) return null;
      const wb = randSq(rng);
      const bb = randSq(rng);
      if ((colourOf(wb) === colourOf(bb)) !== same) return null;
      pl.push(['K', randSq(rng)], ['k', randSq(rng)], ['B', wb], ['b', bb]);
      const f = fen(pl, 'w');
      return f ? { fen: f } : null;
    },
    accept(_c, p) {
      if (p.category === 'loss' || !hasWrongMove(p)) return null;
      return { bucket: p.category, playout: p.category === 'draw' || p.dtm !== null };
    },
  };
}

const knightVsBishop: Generator = {
  concept: 'endgames/minor/knight-vs-bishop',
  property: 'K+N+P vs K+B or K+B+P vs K+N, pawn side to move; at least one legal move changes the tablebase result.',
  buckets: { 'N-win': 0.3, 'N-draw': 0.25, 'B-win': 0.3, 'B-draw': 0.25 },
  candidate(rng) {
    const knight = rng() < 0.5;
    const f = fen(
      [
        ['K', randSq(rng)],
        ['k', randSq(rng)],
        ['P', sq(ri(rng, 0, 7), ri(rng, 2, 5))],
        [knight ? 'N' : 'B', randSq(rng)],
        [knight ? 'b' : 'n', randSq(rng)],
      ],
      'w',
    );
    return f ? { fen: f, d: { knight: knight ? 1 : 0 } } : null;
  },
  accept(c, p) {
    if (p.category === 'loss' || !hasWrongMove(p)) return null;
    return { bucket: `${c.d?.knight === 1 ? 'N' : 'B'}-${p.category}`, playout: true };
  },
};

/* ---------- fortress ---------- */

const PTS: Record<string, number> = { Q: 9, R: 5, B: 3, N: 3, P: 1 };
const FORTRESS_SETS: { att: string[]; def: string[]; w: number }[] = [
  { att: ['Q'], def: ['R', 'P'], w: 3 },
  { att: ['Q'], def: ['B', 'P'], w: 2 },
  { att: ['Q'], def: ['N', 'P'], w: 2 },
  { att: ['Q', 'P'], def: ['R', 'P'], w: 1 },
  { att: ['R', 'B'], def: ['P'], w: 1 },
];

const fortress: Generator = {
  concept: 'endgames/drawing/fortress',
  property:
    'Defender to move, down at least a rook\'s worth of material (or facing a queen with rook + pawn): Q vs R+P, Q vs B+P, Q vs N+P, ' +
    'Q+P vs R+P, R+B vs P; defender pieces and pawn placed near the defending king; tablebase: exact draw; no legal defender move captures ' +
    'and no attacker piece is capturable (the draw is not a one-move tactic).',
  buckets: { QRP: 0.45, QBP: 0.3, QNP: 0.3, QPRP: 0.2, RBP: 0.2 },
  probeFactor: 4,
  candidate(rng) {
    const total = FORTRESS_SETS.reduce((a, s) => a + s.w, 0);
    let x = rng() * total;
    const set = FORTRESS_SETS.find((s) => (x -= s.w) < 0) ?? FORTRESS_SETS[0];
    if (!set) return null;
    // Defender is Black here (to move); the attacker is White.
    const bk = randSq(rng);
    const pl: Placement = [['k', bk]];
    for (const p of set.def) {
      const s = p === 'P' ? sq(ri(rng, 0, 7), ri(rng, 1, 6)) : near(rng, bk, 1, 2);
      if (s < 0) return null;
      pl.push([p.toLowerCase(), s]);
    }
    pl.push(['K', near(rng, bk, 2, 5)]);
    for (const p of set.att) pl.push([p, p === 'P' ? sq(ri(rng, 0, 7), ri(rng, 1, 5)) : randSq(rng)]);
    if (pl.some(([, s]) => s < 0)) return null;
    const att = set.att.reduce((a, p) => a + (PTS[p] ?? 0), 0);
    const def = set.def.reduce((a, p) => a + (PTS[p] ?? 0), 0);
    const qVsRp = set.att.includes('Q') && set.def.includes('R');
    if (att - def < 5 && !qVsRp) return null;
    const f = fen(pl, 'b');
    return f ? { fen: f, bucket: set.att.join('') + set.def.join('') } : null;
  },
  accept(c, p) {
    if (p.category !== 'draw' || p.moves.some(isCapture)) return null;
    return { bucket: c.bucket ?? '', playout: true };
  },
};

export const pieceGenerators: Generator[] = [
  kqkp,
  cuttingOff,
  rookBehind,
  lucena,
  philidor,
  wrongBishop,
  bishops('endgames/minor/same-color-bishops', true),
  bishops('endgames/minor/opposite-color-bishops', false),
  knightVsBishop,
  fortress,
];
