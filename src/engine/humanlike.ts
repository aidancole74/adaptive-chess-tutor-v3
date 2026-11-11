/**
 * Human-likeness model (M14 fallback; no Maia/ONNX): a rating-conditioned softmax over Stockfish MultiPV.
 * P(move) ∝ exp(-cpLoss / T(rating)), with temperature falling as rating rises.
 * T(r) = 25 + 260 * exp(-(r - 600) / 550): ~285 cp at 600, ~135 cp at 1200, ~60 cp at 1800, ~35 cp at 2400.
 * These constants are assumptions (not fitted to human games) and are documented in docs/DECISIONS.md.
 */
import { scoreCp, type EngineLine } from './stockfish';

export function temperature(rating: number): number {
  return 25 + 260 * Math.exp(-(rating - 600) / 550);
}

export function moveProbabilities(lines: EngineLine[], rating: number): { uci: string; p: number; cpLoss: number }[] {
  const usable = lines.filter((l) => l.pv.length > 0);
  if (usable.length === 0) return [];
  const best = Math.max(...usable.map(scoreCp));
  const t = temperature(rating);
  const w = usable.map((l) => {
    const loss = Math.min(2000, best - scoreCp(l));
    return { uci: l.pv[0]!, cpLoss: loss, w: Math.exp(-loss / t) };
  });
  const z = w.reduce((a, b) => a + b.w, 0);
  return w.map((x) => ({ uci: x.uci, cpLoss: x.cpLoss, p: x.w / z }));
}

export function pickHumanMove(lines: EngineLine[], rating: number, rng: () => number): string | null {
  const probs = moveProbabilities(lines, rating);
  let u = rng();
  for (const m of probs) {
    u -= m.p;
    if (u <= 0) return m.uci;
  }
  return probs[probs.length - 1]?.uci ?? null;
}
