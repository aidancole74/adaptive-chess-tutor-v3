/** Test doubles for the diagnosis tests: a scripted Engine (no Stockfish needed). */
import { Chess } from 'chess.js';
import { epdOf, uciOf } from '../engine/chessUtil';
import type { AnalyseOptions, Engine, EngineLine } from '../engine/stockfish';

export interface ScriptedLine {
  cp?: number;
  mate?: number;
  pv?: string[];
}

/**
 * Engine whose answers are scripted per position (EPD). Unscripted positions evaluate to 0 with the
 * first legal move as PV. Scores are side-to-move POV like the real engine. Records every call.
 */
export function scriptedEngine(script: Record<string, ScriptedLine | ScriptedLine[]> = {}): Engine & { calls: { fen: string; opts?: AnalyseOptions }[] } {
  const byEpd = new Map(Object.entries(script).map(([fen, l]) => [epdOf(fen), Array.isArray(l) ? l : [l]]));
  const calls: { fen: string; opts?: AnalyseOptions }[] = [];
  return {
    calls,
    async analyse(fen, opts) {
      calls.push({ fen, opts });
      const legal = new Chess(fen).moves({ verbose: true }).map(uciOf);
      if (legal.length === 0) return [];
      const lines = byEpd.get(epdOf(fen)) ?? [{ cp: 0 }];
      const want = opts?.multipv ?? 1;
      return lines.slice(0, want).map((l, i): EngineLine => ({
        multipv: i + 1,
        depth: opts?.depth ?? 12,
        cp: l.mate !== undefined ? null : (l.cp ?? 0),
        mate: l.mate ?? null,
        pv: l.pv ?? [legal[i] ?? legal[0]!],
      }));
    },
    async play() {
      return null;
    },
    dispose() {},
  };
}
