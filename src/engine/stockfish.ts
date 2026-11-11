/**
 * Stockfish client: single-threaded lite WASM build in a classic Web Worker (no threads, no SharedArrayBuffer).
 * One job at a time through a queue; results cached by FEN + depth + MultiPV.
 */
import { epdOf } from './chessUtil';

export interface EngineLine {
  multipv: number;
  depth: number;
  /** Centipawns from the side to move's point of view (null when mate). */
  cp: number | null;
  mate: number | null;
  pv: string[];
}

export interface AnalyseOptions {
  depth?: number;
  movetimeMs?: number;
  multipv?: number;
  searchmoves?: string[];
  onProgress?: (lines: EngineLine[]) => void;
}

export interface Engine {
  analyse(fen: string, opts?: AnalyseOptions): Promise<EngineLine[]>;
  /** Limited-strength move for sparring (UCI_LimitStrength / UCI_Elo, falling back to Skill Level). */
  play(fen: string, opts: { elo: number; movetimeMs?: number }): Promise<string | null>;
  dispose(): void;
}

/** Mate scores folded to large centipawn values so lines can be compared. */
export function scoreCp(l: Pick<EngineLine, 'cp' | 'mate'>): number {
  if (l.mate !== null) return l.mate > 0 ? 100_000 - l.mate * 100 : -100_000 - l.mate * 100;
  return l.cp ?? 0;
}

export function parseInfo(line: string): EngineLine | null {
  if (!line.startsWith('info') || !line.includes(' pv ')) return null;
  if (/ (upperbound|lowerbound)/.test(line)) return null;
  const num = (re: RegExp): number | null => {
    const m = re.exec(line);
    return m ? Number(m[1]) : null;
  };
  return {
    multipv: num(/ multipv (\d+)/) ?? 1,
    depth: num(/ depth (\d+)/) ?? 0,
    cp: num(/ score cp (-?\d+)/),
    mate: num(/ score mate (-?\d+)/),
    pv: line.slice(line.indexOf(' pv ') + 4).trim().split(/\s+/),
  };
}

type Job = { run: () => Promise<void> };

export function createEngine(workerUrl = `${import.meta.env.BASE_URL}engine/stockfish.js`): Engine {
  let worker: Worker | null = null;
  let ready: Promise<void> | null = null;
  let listener: ((line: string) => void) | null = null;
  const queue: Job[] = [];
  let busy = false;
  const cache = new Map<string, EngineLine[]>();
  let limited = false;

  const send = (cmd: string): void => worker?.postMessage(cmd);
  const until = (pred: (l: string) => boolean, each?: (l: string) => void): Promise<void> =>
    new Promise((resolve) => {
      listener = (l) => {
        each?.(l);
        if (pred(l)) {
          listener = null;
          resolve();
        }
      };
    });

  const boot = (): Promise<void> => {
    if (ready) return ready;
    ready = (async () => {
      worker = new Worker(workerUrl);
      worker.onmessage = (ev: MessageEvent) => {
        const data = typeof ev.data === 'string' ? ev.data : String(ev.data);
        for (const l of data.split('\n')) listener?.(l);
      };
      const ok = until((l) => l.startsWith('uciok'));
      send('uci');
      await ok;
      send('setoption name Hash value 32');
      const r = until((l) => l.startsWith('readyok'));
      send('isready');
      await r;
    })();
    return ready;
  };

  const pump = (): void => {
    if (busy) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    void job.run().finally(() => {
      busy = false;
      pump();
    });
  };
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push({ run: () => fn().then(resolve, reject) });
      pump();
    });

  const setLimited = (elo: number | null): void => {
    if (elo === null) {
      if (limited) {
        send('setoption name UCI_LimitStrength value false');
        send('setoption name Skill Level value 20');
      }
      limited = false;
      return;
    }
    limited = true;
    send('setoption name UCI_LimitStrength value true');
    send(`setoption name UCI_Elo value ${Math.round(Math.min(3190, Math.max(1320, elo)))}`);
    // Below the UCI_Elo floor, Skill Level weakens the engine further.
    send(`setoption name Skill Level value ${elo < 1320 ? Math.max(0, Math.round((elo - 600) / 90)) : 20}`);
  };

  return {
    analyse(fen, opts = {}) {
      const depth = opts.depth ?? 12;
      const multipv = opts.multipv ?? 1;
      const key = `${epdOf(fen)}|${depth}|${multipv}|${opts.movetimeMs ?? 0}|${opts.searchmoves?.join(',') ?? ''}`;
      const hit = cache.get(key);
      if (hit) return Promise.resolve(hit);
      return enqueue(async () => {
        await boot();
        setLimited(null);
        const lines = new Map<number, EngineLine>();
        send(`setoption name MultiPV value ${multipv}`);
        send(`position fen ${fen}`);
        const done = until(
          (l) => l.startsWith('bestmove'),
          (l) => {
            const info = parseInfo(l);
            if (!info) return;
            lines.set(info.multipv, info);
            opts.onProgress?.([...lines.values()].sort((a, b) => a.multipv - b.multipv));
          },
        );
        const sm = opts.searchmoves?.length ? ` searchmoves ${opts.searchmoves.join(' ')}` : '';
        send(opts.movetimeMs ? `go movetime ${opts.movetimeMs}${sm}` : `go depth ${depth}${sm}`);
        await done;
        const out = [...lines.values()].sort((a, b) => a.multipv - b.multipv);
        if (cache.size > 5000) cache.clear();
        cache.set(key, out);
        return out;
      });
    },
    play(fen, opts) {
      return enqueue(async () => {
        await boot();
        setLimited(opts.elo);
        send('setoption name MultiPV value 1');
        send(`position fen ${fen}`);
        let best: string | null = null;
        const done = until((l) => {
          if (!l.startsWith('bestmove')) return false;
          const m = l.split(/\s+/)[1];
          best = m && m !== '(none)' ? m : null;
          return true;
        });
        send(`go movetime ${opts.movetimeMs ?? 400}`);
        await done;
        return best;
      });
    },
    dispose() {
      worker?.terminate();
      worker = null;
      ready = null;
    },
  };
}

let shared: Engine | null = null;
export function getEngine(): Engine {
  shared ??= createEngine();
  return shared;
}
