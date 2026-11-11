/** Basic mates: K+Q vs K and K+R vs K, White to move, with a spread of mate distances. */
import { F, R, fenOf, near, pick, randSq, sq, type Rng } from './board';
import type { Cand, Generator } from './types';

function mating(concept: string, piece: 'Q' | 'R', shortMax: number, midMax: number): Generator {
  return {
    concept,
    property: `K+${piece} vs K, side to move wins (tablebase), bucketed by DTM: short <= ${shortMax} plies, mid <= ${midMax}, long beyond`,
    buckets: { short: 0.3, mid: 0.4, long: 0.4 },
    candidate(rng: Rng): Cand | null {
      let bk = randSq(rng);
      let wk = randSq(rng);
      if (rng() < 0.45) {
        // Bias towards short mates: defending king on the edge with the attacker's king close.
        const e = pick(rng, [0, 7]);
        const o = Math.floor(rng() * 8);
        bk = rng() < 0.5 ? sq(e, o) : sq(o, e);
        wk = near(rng, bk, 2, 3);
      }
      if (wk < 0 || (F(wk) === F(bk) && R(wk) === R(bk))) return null;
      const fen = fenOf(
        [
          ['K', wk],
          ['k', bk],
          [piece, randSq(rng)],
        ],
        'w',
      );
      return fen ? { fen } : null;
    },
    accept(_c, p) {
      if (p.category !== 'win' || p.dtm === null || p.dtm < 3) return null;
      return { bucket: p.dtm <= shortMax ? 'short' : p.dtm <= midMax ? 'mid' : 'long', playout: true };
    },
  };
}

export const matingGenerators: Generator[] = [mating('endgames/mating/kqk', 'Q', 7, 13), mating('endgames/mating/krk', 'R', 11, 21)];
