/** Calibration of the model's predictions and of the user's own confidence ratings. */
import type { AttemptRecord } from './types';

type Row = Pick<AttemptRecord, 'p' | 'solved' | 'confidence'>;

/** Mean squared error of predicted probabilities (0 = perfect, 0.25 = always saying 50%). */
export function brier(rows: Row[]): number | null {
  if (rows.length === 0) return null;
  let s = 0;
  for (const r of rows) s += (r.p - (r.solved ? 1 : 0)) ** 2;
  return s / rows.length;
}

export interface ReliabilityBin {
  lo: number;
  hi: number;
  n: number;
  meanP: number;
  rate: number;
}

export function reliabilityBins(rows: Row[], bins = 10): ReliabilityBin[] {
  const out: ReliabilityBin[] = [];
  for (let i = 0; i < bins; i++) out.push({ lo: i / bins, hi: (i + 1) / bins, n: 0, meanP: 0, rate: 0 });
  for (const r of rows) {
    const b = out[Math.min(bins - 1, Math.floor(r.p * bins))]!;
    b.n++;
    b.meanP += r.p;
    b.rate += r.solved ? 1 : 0;
  }
  for (const b of out) {
    if (b.n > 0) {
      b.meanP /= b.n;
      b.rate /= b.n;
    }
  }
  return out;
}

/** Expected calibration error: bin-size-weighted |predicted - observed|. */
export function ece(rows: Row[], bins = 10): number | null {
  if (rows.length === 0) return null;
  let e = 0;
  for (const b of reliabilityBins(rows, bins)) e += (b.n / rows.length) * Math.abs(b.meanP - b.rate);
  return e;
}

/** What a 1..5 confidence rating nominally claims. */
export const CONFIDENCE_NOMINAL = [0.2, 0.4, 0.6, 0.8, 0.95];
const PRIOR_STRENGTH = 4;

export interface ConfidenceLevel {
  level: number;
  n: number;
  /** Observed solve rate at this confidence (null when unused). */
  rate: number | null;
  nominal: number;
  /** Posterior mean success probability: the nominal claim shrunk toward what actually happened. */
  calibrated: number;
}

/** Confidence-calibration model: per level, a Beta posterior centred on the nominal claim. */
export function confidenceModel(rows: Row[]): { levels: ConfidenceLevel[]; bias: number | null; n: number } {
  const levels: ConfidenceLevel[] = CONFIDENCE_NOMINAL.map((nominal, i) => ({ level: i + 1, n: 0, rate: null, nominal, calibrated: nominal }));
  const solved = [0, 0, 0, 0, 0];
  let total = 0;
  for (const r of rows) {
    if (r.confidence === undefined || r.confidence < 1 || r.confidence > 5) continue;
    const i = Math.round(r.confidence) - 1;
    levels[i]!.n++;
    solved[i]! += r.solved ? 1 : 0;
    total++;
  }
  let bias = 0;
  for (const [i, l] of levels.entries()) {
    if (l.n > 0) {
      l.rate = solved[i]! / l.n;
      bias += (l.n / total) * (l.nominal - l.rate);
    }
    l.calibrated = (l.nominal * PRIOR_STRENGTH + solved[i]!) / (PRIOR_STRENGTH + l.n);
  }
  // bias > 0 = overconfident (claims more than delivered)
  return { levels, bias: total > 0 ? bias : null, n: total };
}
