/** Shared pipeline helpers: pack writing, cache dir, resumable downloads, zstd line streaming, Stockfish in Node. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import type { Domain, PackInfo, PackShard } from '../../src/content/types';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');
export const CACHE = path.join(ROOT, '.cache');
export const PACKS = path.join(ROOT, 'public', 'packs');

export function ensureDir(d: string): string {
  fs.mkdirSync(d, { recursive: true });
  return d;
}

export function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0) return process.argv[i + 1] ?? 'true';
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : def;
}

export function writePack(
  id: string,
  domain: Domain,
  info: { version: string; license: string; source: string; meta?: Record<string, unknown> },
  shards: { file: string; key: string; count: number; data: unknown }[],
): PackInfo {
  const dir = ensureDir(path.join(PACKS, id));
  const out: PackShard[] = [];
  for (const s of shards) {
    const json = JSON.stringify(s.data);
    fs.writeFileSync(path.join(dir, s.file), json);
    out.push({ file: s.file, key: s.key, count: s.count, bytes: Buffer.byteLength(json) });
  }
  const pack: PackInfo = {
    id,
    domain,
    version: info.version,
    license: info.license,
    source: info.source,
    generatedAt: new Date().toISOString(),
    count: out.reduce((a, s) => a + s.count, 0),
    shards: out,
    meta: info.meta,
  };
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify(pack, null, 1));
  console.log(`[pack] ${id}: ${pack.count} items in ${out.length} shards, ${(out.reduce((a, s) => a + s.bytes, 0) / 1e6).toFixed(2)} MB`);
  return pack;
}

/** Download to .cache with resume (HTTP Range) and retries. Returns the local path. */
export async function downloadCached(url: string, name: string, opts: { maxBytes?: number } = {}): Promise<string> {
  ensureDir(CACHE);
  const dest = path.join(CACHE, name);
  const done = dest + '.done';
  if (fs.existsSync(done)) return dest;
  for (let attempt = 0; attempt < 30; attempt++) {
    const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    if (opts.maxBytes && have >= opts.maxBytes) break;
    try {
      const res = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (res.status === 416) break;
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const append = res.status === 206;
      const ws = fs.createWriteStream(dest, { flags: append ? 'a' : 'w' });
      let got = append ? have : 0;
      let last = Date.now();
      const reader = res.body.getReader();
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        ws.write(value);
        got += value.byteLength;
        if (Date.now() - last > 15000) {
          console.log(`[download] ${name}: ${(got / 1e6).toFixed(0)} MB`);
          last = Date.now();
        }
        if (opts.maxBytes && got >= opts.maxBytes) {
          await reader.cancel();
          break;
        }
      }
      await new Promise<void>((r) => ws.end(r));
      fs.writeFileSync(done, new Date().toISOString());
      return dest;
    } catch (e) {
      console.warn(`[download] ${name} attempt ${attempt + 1} failed: ${(e as Error).message}; retrying`);
      await new Promise((r) => setTimeout(r, 3000 + attempt * 2000));
    }
  }
  fs.writeFileSync(done, new Date().toISOString());
  return dest;
}

/** Async line iterator over a (possibly truncated) .zst file. Truncation at the end is tolerated. */
export async function* zstLines(file: string): AsyncGenerator<string> {
  const dec = zlib.createZstdDecompress();
  const src = fs.createReadStream(file);
  src.pipe(dec);
  dec.on('error', () => {
    /* truncated final frame: stop quietly */
  });
  const rl = readline.createInterface({ input: dec as unknown as Readable, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } catch {
    /* truncated stream */
  } finally {
    src.destroy();
  }
}

/** Async line iterator over a remote .zst URL, decompressing while downloading (stop early by breaking the loop). */
export async function* zstUrlLines(url: string): AsyncGenerator<string> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const dec = zlib.createZstdDecompress();
  const src = Readable.fromWeb(res.body as never);
  src.on('error', (e) => dec.destroy(e));
  src.pipe(dec);
  const rl = readline.createInterface({ input: dec as unknown as Readable, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    src.destroy();
    dec.destroy();
  }
}

/* ---------- Stockfish (single-threaded lite WASM) in Node ---------- */

export interface SfLine {
  multipv: number;
  depth: number;
  cp: number | null;
  mate: number | null;
  pv: string[];
}

export class NodeStockfish {
  private engine: { processCommand(cmd: string): void; terminate(): void; listener?: (l: string) => void };
  private waiters: ((line: string) => boolean)[] = [];

  constructor() {
    const require = createRequire(import.meta.url);
    const init = require('stockfish') as (kind: string, cb: (line: string) => void) => NodeStockfish['engine'];
    this.engine = init('lite-single', (line: string) => this.onLine(line));
  }

  private onLine(line: string): void {
    for (const part of String(line).split('\n')) this.waiters = this.waiters.filter((w) => !w(part));
  }

  private waitFor(pred: (l: string) => boolean, collect?: (l: string) => void): Promise<void> {
    return new Promise((resolve) => {
      this.waiters.push((l) => {
        collect?.(l);
        if (pred(l)) {
          resolve();
          return true;
        }
        return false;
      });
    });
  }

  async init(options: Record<string, string | number> = {}): Promise<void> {
    const ready = this.waitFor((l) => l.startsWith('uciok'));
    this.engine.processCommand('uci');
    await ready;
    for (const [k, v] of Object.entries({ Hash: 64, ...options })) this.engine.processCommand(`setoption name ${k} value ${v}`);
    const ok = this.waitFor((l) => l.startsWith('readyok'));
    this.engine.processCommand('isready');
    await ok;
  }

  /** Analyse a FEN. Scores are from the side to move's point of view. */
  async analyse(fen: string, opts: { depth: number; multipv?: number; searchmoves?: string[] }): Promise<SfLine[]> {
    const lines = new Map<number, SfLine>();
    this.engine.processCommand(`setoption name MultiPV value ${opts.multipv ?? 1}`);
    this.engine.processCommand(`position fen ${fen}`);
    const done = this.waitFor(
      (l) => l.startsWith('bestmove'),
      (l) => {
        if (!l.startsWith('info') || !l.includes(' pv ')) return;
        const depth = Number(/ depth (\d+)/.exec(l)?.[1] ?? 0);
        const mpv = Number(/ multipv (\d+)/.exec(l)?.[1] ?? 1);
        const cp = / score cp (-?\d+)/.exec(l);
        const mate = / score mate (-?\d+)/.exec(l);
        if (/ (upperbound|lowerbound)/.test(l)) return;
        const pv = l.slice(l.indexOf(' pv ') + 4).trim().split(/\s+/);
        lines.set(mpv, { multipv: mpv, depth, cp: cp ? Number(cp[1]) : null, mate: mate ? Number(mate[1]) : null, pv });
      },
    );
    const sm = opts.searchmoves?.length ? ` searchmoves ${opts.searchmoves.join(' ')}` : '';
    this.engine.processCommand(`go depth ${opts.depth}${sm}`);
    await done;
    return [...lines.values()].sort((a, b) => a.multipv - b.multipv);
  }

  newGame(): void {
    this.engine.processCommand('ucinewgame');
  }

  quit(): void {
    try {
      this.engine.terminate();
    } catch {
      /* ignore */
    }
  }
}

/** Mate scores folded to large centipawn values for comparisons. */
export function cpOf(l: Pick<SfLine, 'cp' | 'mate'>): number {
  if (l.mate !== null) return l.mate > 0 ? 100000 - l.mate * 100 : -100000 - l.mate * 100;
  return l.cp ?? 0;
}
