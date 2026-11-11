/** Names stage: lichess-org/chess-openings (CC0) TSVs -> OpeningNameTuple[] (every line replayed with chess.js). */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import type { OpeningNameTuple } from '../../src/content/types';
import { epdOf, uciOf } from '../../src/engine/chessUtil';
import { downloadCached, ensureDir } from '../lib/pack';
import { OPENINGS_CACHE } from './book';
import { sanTokens } from './pgn';

export const NAMES_SOURCE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master/';

export interface NamesMeta {
  count: number;
  failed: number;
  failedExamples: string[];
  rows: number;
}

/** Replays a "1. e4 e5 2. Nf3" style line; null when any move is illegal or the line is empty. */
export function replayPgnLine(pgn: string): { uci: string[]; epd: string } | null {
  const sans = sanTokens(pgn);
  if (sans.length === 0) return null;
  const chess = new Chess();
  const uci: string[] = [];
  for (const san of sans) {
    try {
      uci.push(uciOf(chess.move(san)));
    } catch {
      return null;
    }
  }
  return { uci, epd: epdOf(chess.fen()) };
}

export function parseNamesTsv(tsv: string): { tuples: OpeningNameTuple[]; failed: string[]; rows: number } {
  const tuples: OpeningNameTuple[] = [];
  const failed: string[] = [];
  let rows = 0;
  for (const raw of tsv.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line) continue;
    const [eco, name, pgn] = line.split('\t');
    if (!eco || !name || !pgn || eco === 'eco') continue;
    rows++;
    const r = replayPgnLine(pgn);
    if (!r) failed.push(`${eco} ${name}`);
    else tuples.push([eco, name, r.uci.join(' '), r.epd]);
  }
  return { tuples, failed, rows };
}

export async function runNamesStage(): Promise<NamesMeta> {
  ensureDir(OPENINGS_CACHE);
  const tuples: OpeningNameTuple[] = [];
  const failed: string[] = [];
  let rows = 0;
  for (const v of ['a', 'b', 'c', 'd', 'e']) {
    const file = await downloadCached(`${NAMES_SOURCE}${v}.tsv`, `chess-openings-${v}.tsv`);
    const r = parseNamesTsv(fs.readFileSync(file, 'utf8'));
    if (r.rows === 0) throw new Error(`chess-openings ${v}.tsv is empty or malformed (delete .cache/chess-openings-${v}.tsv* and retry)`);
    tuples.push(...r.tuples);
    failed.push(...r.failed);
    rows += r.rows;
  }
  const meta: NamesMeta = { count: tuples.length, failed: failed.length, failedExamples: failed.slice(0, 10), rows };
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'names.json'), JSON.stringify(tuples));
  fs.writeFileSync(path.join(OPENINGS_CACHE, 'names-meta.json'), JSON.stringify(meta, null, 1));
  console.log(`[names] ${meta.count} named lines from ${rows} rows, ${meta.failed} failed to replay`);
  return meta;
}
