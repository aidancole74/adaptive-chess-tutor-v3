/**
 * TEST FIXTURES ONLY. Builds small book shards by replaying move lists with chess.js. The statistics passed in by
 * tests are SYNTHETIC (made up to exercise the mechanics) and are never shipped as content.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { epdOf, uciOf } from '../engine/chessUtil';
import type { BookBand, BookShard, OpeningNameTuple } from './types';

/** result: '1-0' | '1/2' | '0-1'; `count` copies of the game. */
export interface SyntheticGame {
  sans: string[];
  result: '1-0' | '1/2' | '0-1';
  count: number;
}

export function syntheticShard(band: BookBand, games: SyntheticGame[]): BookShard {
  const shard: BookShard = { band, games: 0, positions: {} };
  for (const g of games) {
    shard.games += g.count;
    const chess = new Chess();
    for (const san of g.sans) {
      const epd = epdOf(chess.fen());
      const uci = uciOf(chess.move(san));
      const pos = (shard.positions[epd] ??= {});
      const st = (pos[uci] ??= [0, 0, 0, 0]);
      st[0] += g.count;
      if (g.result === '1-0') st[1] += g.count;
      else if (g.result === '1/2') st[2] += g.count;
      else st[3] += g.count;
    }
  }
  return shard;
}

export function nameTuple(eco: string, name: string, sans: string[]): OpeningNameTuple {
  const chess = new Chess();
  const uci = sans.map((s) => uciOf(chess.move(s)));
  return [eco, name, uci.join(' '), epdOf(chess.fen())];
}

export function ucis(sans: string[]): string[] {
  const chess = new Chess();
  return sans.map((s) => uciOf(chess.move(s)));
}

const PACK_DIR = path.resolve(import.meta.dirname, '..', '..', 'public', 'packs', 'openings');

/** Reads a shard of the real generated pack, or null when the pack has not been built. */
export function realPackFile<T>(file: string): T | null {
  const f = path.join(PACK_DIR, file);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : null;
}
