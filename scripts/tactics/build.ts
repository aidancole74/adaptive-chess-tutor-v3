/**
 * Tactics pack pipeline: Lichess puzzle DB (CC0) -> public/packs/tactics/.
 *
 *   tsx scripts/tactics/build.ts [--target 60000] [--limit N] [--dry]
 *
 * Pass 1 streams the whole CSV, applies the quality filter and records, per stratification cell
 * (primary concept x 200-point rating band x solution length), a seeded hash of every PuzzleId.
 * Quotas are then water-filled: first across concepts (so rare motifs get as many puzzles as common
 * ones, up to what exists), then across the band x length cells inside each concept (so rating
 * extremes are covered). Two extra pools guarantee find-the-defense material (`defensiveMove`,
 * `equality`). Pass 2 re-reads the rows that were picked (plus spares), validates each with chess.js
 * and de-duplicates by the EPD of the position after the opponent's first move.
 *
 * Nothing here is written from memory: every shipped tuple is a row of the Lichess file.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import zlib from 'node:zlib';
import { PACKS, arg, downloadCached, ensureDir, writePack, zstLines, CACHE } from '../lib/pack';
import { epdOf, tryMove } from '../../src/engine/chessUtil';
import { META_THEMES, TACTIC_THEME_TO_CONCEPT, primaryTacticConcept } from '../../src/curriculum/concepts';
import { bandFileForKey, bandKeyForRating, bandStartForRating } from '../../src/content/tactics';
import type { TacticTuple } from '../../src/content/types';

const URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst';
const FILE = 'lichess_db_puzzle.csv.zst';
const HEADER = 'PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags';
/** Columns Lichess has appended after the ten we read; anything else fails the header check. */
const KNOWN_EXTRA_COLUMNS = ['DailyDate'];
const VERSION = '1';
const SEED = 'act-tactics-v1';
const MIN_POPULARITY = 80;
const MAX_RD = 90;
/** Spare candidates read per cell so validation failures and duplicates can be replaced. */
const OVERSAMPLE = 1.3;
const SPARE = 12;
/** Share of the target reserved for each find-the-defense pool. */
const POOL_SHARE: Record<string, number> = { defensiveMove: 0.05, equality: 0.05 };
const LENGTHS = ['oneMove', 'short', 'long', 'veryLong'] as const;
type Length = (typeof LENGTHS)[number];

/** FNV-1a (32 bit) of seed + id: the deterministic "random" order used for selection. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  const s = SEED + ':' + id;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lengthOf(themes: string[], nMoves: number): Length {
  for (const l of LENGTHS) if (themes.includes(l)) return l;
  const userMoves = Math.floor(nMoves / 2);
  return userMoves <= 1 ? 'oneMove' : userMoves === 2 ? 'short' : userMoves === 3 ? 'long' : 'veryLong';
}

/**
 * Largest integer cap c with sum(min(count, c)) <= target, then the remainder is handed out one by
 * one (in the given order) to entries that still have supply. Returns one quota per entry.
 */
function waterFill(counts: number[], target: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= target) return [...counts];
  let lo = 0;
  let hi = Math.max(0, ...counts);
  const filled = (c: number): number => counts.reduce((a, n) => a + Math.min(n, c), 0);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (filled(mid) <= target) lo = mid;
    else hi = mid - 1;
  }
  const out = counts.map((n) => Math.min(n, lo));
  let rest = target - filled(lo);
  for (let i = 0; i < counts.length && rest > 0; i++) {
    if ((counts[i] ?? 0) > lo) {
      out[i] = lo + 1;
      rest--;
    }
  }
  return out;
}

interface Cell {
  key: string;
  /** Primary concept id, or "pool/<theme>" for the defense pools. */
  group: string;
  /** Encoded (hash30 * 2^23 + row) so a numeric sort orders by hash, ties by row. */
  entries: number[];
  quota: number;
}
const ROW_BITS = 2 ** 23;
const encode = (hash: number, row: number): number => (hash >>> 2) * ROW_BITS + row;
const rowOf = (e: number): number => e % ROW_BITS;

interface Row {
  id: string;
  fen: string;
  moves: string;
  rating: number;
  rd: number;
  themes: string;
  openingTags: string;
}

function inc(m: Record<string, number>, k: string, by = 1): void {
  m[k] = (m[k] ?? 0) + by;
}
function sortedRecord(m: Record<string, number>, byCount = false): Record<string, number> {
  const e = Object.entries(m);
  e.sort(byCount ? (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]) : (a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(e);
}

/** downloadCached marks a file done even after an interrupted stream, so check the size ourselves. */
async function fetchSource(): Promise<{ file: string; bytes: number; expectedBytes: number | null }> {
  let expected: number | null = null;
  try {
    const head = await fetch(URL, { method: 'HEAD' });
    const len = Number(head.headers.get('content-length'));
    if (head.ok && Number.isFinite(len) && len > 0) expected = len;
  } catch (e) {
    console.warn(`[tactics] HEAD failed (${(e as Error).message}); cannot verify the download size`);
  }
  const done = path.join(CACHE, FILE + '.done');
  for (let round = 0; round < 40; round++) {
    const file = await downloadCached(URL, FILE);
    const bytes = fs.statSync(file).size;
    if (expected === null || bytes === expected) return { file, bytes, expectedBytes: expected };
    if (bytes > expected) {
      console.warn(`[tactics] cached file is larger than the remote (${bytes} > ${expected}); re-downloading`);
      fs.rmSync(file, { force: true });
    } else {
      console.warn(`[tactics] download incomplete (${bytes} of ${expected} bytes); resuming`);
    }
    fs.rmSync(done, { force: true });
  }
  throw new Error('could not download the complete puzzle file');
}

/**
 * Line iterator for the puzzle file. Lichess publishes it in the pzstd layout: many independent zstd
 * frames, each preceded by a 12-byte skippable frame holding the size of the frame that follows.
 * Node's streaming decompressor stops at the first skippable frame (zstLines yields nothing), so the
 * frames are decoded one by one here. Files without that layout fall back to zstLines.
 */
async function* puzzleLines(file: string): AsyncGenerator<string> {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(12);
    const isPzstd = (pos: number): boolean =>
      fs.readSync(fd, head, 0, 12, pos) === 12 && head.readUInt32LE(0) === 0x184d2a50 && head.readUInt32LE(4) === 4;
    if (!isPzstd(0)) {
      yield* zstLines(file);
      return;
    }
    let pos = 0;
    let rest: Buffer = Buffer.alloc(0);
    while (pos < size) {
      if (!isPzstd(pos)) throw new Error(`unexpected data at byte ${pos} of ${file}`);
      const n = head.readUInt32LE(8);
      const frame = Buffer.alloc(n);
      if (fs.readSync(fd, frame, 0, n, pos + 12) !== n) throw new Error(`truncated frame at byte ${pos} of ${file}`);
      pos += 12 + n;
      const data = Buffer.concat([rest, zlib.zstdDecompressSync(frame)]);
      const cut = data.lastIndexOf(0x0a);
      if (cut < 0) {
        rest = data;
        continue;
      }
      rest = data.subarray(cut + 1);
      for (const line of data.toString('utf8', 0, cut).split('\n')) yield line.endsWith('\r') ? line.slice(0, -1) : line;
    }
    if (rest.length) yield rest.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

type Validation = { ok: true; epd: string } | { ok: false; reason: string };

function validate(r: Row): Validation {
  let chess: Chess;
  try {
    chess = new Chess(r.fen);
  } catch {
    return { ok: false, reason: 'badFen' };
  }
  const moves = r.moves.split(' ');
  if (moves.length < 2) return { ok: false, reason: 'tooFewMoves' };
  if (moves.length % 2 !== 0) return { ok: false, reason: 'oddMoveCount' };
  let epd = '';
  for (let i = 0; i < moves.length; i++) {
    if (!tryMove(chess, moves[i] ?? '')) return { ok: false, reason: 'illegalMove' };
    if (i === 0) epd = epdOf(chess.fen());
  }
  if (r.themes.split(' ').includes('mate') && !chess.isCheckmate()) return { ok: false, reason: 'mateThemeNotMate' };
  return { ok: true, epd };
}

async function main(): Promise<void> {
  const target = Number(arg('target', '60000'));
  const limit = Number(arg('limit', '0'));
  const dry = arg('dry') !== undefined;
  if (!Number.isFinite(target) || target <= 0) throw new Error('--target must be a positive number');

  const src = await fetchSource();
  console.log(`[tactics] source ${src.file} (${(src.bytes / 1e6).toFixed(1)} MB)`);

  /* ---------- pass 1: filter, count, hash ---------- */
  const cells = new Map<string, Cell>();
  const cellOf = (group: string, band: number, len: Length): Cell => {
    const key = `${group}|${band}|${len}`;
    let c = cells.get(key);
    if (!c) cells.set(key, (c = { key, group, entries: [], quota: 0 }));
    return c;
  };
  const themeCounts: Record<string, number> = {};
  const unmappedThemeCounts: Record<string, number> = {};
  const availableConceptCounts: Record<string, number> = {};
  let rowsRead = 0;
  let rowsAfterFilter = 0;
  let malformedRows = 0;
  let skippedNoConcept = 0;
  let headerSeen = false;
  let header = '';
  let columns = 10;

  const parse = (line: string): (Row & { popularity: number }) | null => {
    const f = line.split(',');
    if (f.length !== columns) return null;
    const rating = Number(f[3]);
    const rd = Number(f[4]);
    const popularity = Number(f[5]);
    if (!f[0] || !f[1] || !f[2] || !Number.isFinite(rating) || !Number.isFinite(rd) || !Number.isFinite(popularity)) return null;
    return { id: f[0], fen: f[1], moves: f[2], rating, rd, popularity, themes: f[7] ?? '', openingTags: f[9] ?? '' };
  };
  const keep = (r: { popularity: number; rd: number }): boolean => r.popularity >= MIN_POPULARITY && r.rd <= MAX_RD;

  for await (const line of puzzleLines(src.file)) {
    if (!headerSeen) {
      header = line.trim();
      const extra = header.startsWith(HEADER + ',') ? header.slice(HEADER.length + 1).split(',') : [];
      if (header !== HEADER && !(extra.length && extra.every((c) => KNOWN_EXTRA_COLUMNS.includes(c)))) {
        throw new Error(`unexpected CSV header: ${line.slice(0, 200)}`);
      }
      columns = header.split(',').length;
      headerSeen = true;
      continue;
    }
    if (!line) continue;
    const row = rowsRead++;
    if (limit && rowsRead > limit) {
      rowsRead--;
      break;
    }
    if (row >= ROW_BITS) throw new Error('more rows than the row encoding supports');
    const r = parse(line);
    if (!r) {
      malformedRows++;
      continue;
    }
    if (!keep(r)) continue;
    rowsAfterFilter++;
    const themes = r.themes.split(' ').filter(Boolean);
    for (const t of themes) {
      inc(themeCounts, t);
      if (!META_THEMES.has(t) && !TACTIC_THEME_TO_CONCEPT.has(t)) inc(unmappedThemeCounts, t);
    }
    const concept = primaryTacticConcept(themes);
    if (!concept) {
      skippedNoConcept++;
      continue;
    }
    inc(availableConceptCounts, concept);
    const band = bandStartForRating(r.rating);
    const len = lengthOf(themes, r.moves.split(' ').length);
    const e = encode(hashId(r.id), row);
    cellOf(concept, band, len).entries.push(e);
    for (const pool of Object.keys(POOL_SHARE)) if (themes.includes(pool)) cellOf(`pool/${pool}`, band, len).entries.push(e);
    if (rowsRead % 1_000_000 === 0) console.log(`[tactics] pass 1: ${rowsRead} rows`);
  }
  if (!headerSeen) throw new Error('empty puzzle file');
  console.log(`[tactics] pass 1 done: ${rowsRead} rows, ${rowsAfterFilter} after filter, ${skippedNoConcept} without a mapped concept`);

  /* ---------- quotas ---------- */
  const groups = new Map<string, Cell[]>();
  for (const c of [...cells.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    c.entries.sort((a, b) => a - b);
    const g = groups.get(c.group);
    if (g) g.push(c);
    else groups.set(c.group, [c]);
  }
  const supply = (g: Cell[]): number => g.reduce((a, c) => a + c.entries.length, 0);
  const poolGroups = [...groups.keys()].filter((g) => g.startsWith('pool/')).sort();
  const conceptGroups = [...groups.keys()].filter((g) => !g.startsWith('pool/')).sort();
  let poolTotal = 0;
  for (const g of poolGroups) {
    const cs = groups.get(g) ?? [];
    const want = Math.min(supply(cs), Math.round(target * (POOL_SHARE[g.slice(5)] ?? 0)));
    poolTotal += want;
    waterFill(cs.map((c) => c.entries.length), want).forEach((q, i) => ((cs[i] as Cell).quota = q));
  }
  // Pool puzzles are often picked by their concept cell as well, so raise the concept budget until the
  // union of all picks reaches the target (a few rounds; the overlap is known before any row is loaded).
  const conceptSupply = conceptGroups.map((g) => supply(groups.get(g) ?? []));
  const maxConceptBudget = conceptSupply.reduce((a, b) => a + b, 0);
  let conceptBudget = Math.min(maxConceptBudget, Math.max(0, target - poolTotal));
  for (let round = 0; round < 8; round++) {
    const conceptQuota = waterFill(conceptSupply, conceptBudget);
    conceptGroups.forEach((g, gi) => {
      const cs = groups.get(g) ?? [];
      waterFill(cs.map((c) => c.entries.length), conceptQuota[gi] ?? 0).forEach((q, i) => ((cs[i] as Cell).quota = q));
    });
    const union = new Set<number>();
    for (const c of cells.values()) for (let i = 0; i < c.quota; i++) union.add(rowOf(c.entries[i] as number));
    const deficit = target - union.size;
    if (deficit <= 0 || conceptBudget >= maxConceptBudget) break;
    conceptBudget = Math.min(maxConceptBudget, conceptBudget + deficit);
  }

  /* ---------- pass 2: load the picked rows (plus spares) ---------- */
  const wanted = new Set<number>();
  for (const c of cells.values()) {
    if (!c.quota) continue;
    const n = Math.min(c.entries.length, Math.ceil(c.quota * OVERSAMPLE) + SPARE);
    for (let i = 0; i < n; i++) wanted.add(rowOf(c.entries[i] as number));
  }
  const rows = new Map<number, Row>();
  {
    let row = -1;
    let first = true;
    for await (const line of puzzleLines(src.file)) {
      if (first) {
        first = false;
        continue;
      }
      if (!line) continue;
      row++;
      if (limit && row >= limit) break;
      if (!wanted.has(row)) continue;
      const r = parse(line);
      if (!r || !keep(r)) throw new Error(`row ${row} changed between passes`);
      rows.set(row, { id: r.id, fen: r.fen, moves: r.moves, rating: r.rating, rd: r.rd, themes: r.themes, openingTags: r.openingTags });
      if (rows.size === wanted.size) break;
    }
  }
  if (rows.size !== wanted.size) throw new Error(`pass 2 found ${rows.size} of ${wanted.size} rows`);
  console.log(`[tactics] pass 2 done: ${rows.size} candidate rows loaded`);

  /* ---------- validate, de-duplicate, select ---------- */
  const validated = new Map<number, Validation>();
  const failReasons: Record<string, number> = {};
  const selected = new Map<number, Row>();
  const epds = new Set<string>();
  const dupRows = new Set<number>();
  const shortfall: Record<string, number> = {};
  // Concept cells first, then the defense pools (rows already selected count towards a pool quota).
  for (const g of [...conceptGroups, ...poolGroups]) {
    for (const c of groups.get(g) ?? []) {
      let got = 0;
      const n = Math.min(c.entries.length, Math.ceil(c.quota * OVERSAMPLE) + SPARE);
      for (let i = 0; i < n && got < c.quota; i++) {
        const row = rowOf(c.entries[i] as number);
        if (selected.has(row)) {
          got++;
          continue;
        }
        if (dupRows.has(row)) continue;
        const r = rows.get(row);
        if (!r) continue;
        let v = validated.get(row);
        if (!v) {
          v = validate(r);
          validated.set(row, v);
          if (!v.ok) inc(failReasons, v.reason);
        }
        if (!v.ok) continue;
        if (epds.has(v.epd)) {
          dupRows.add(row);
          continue;
        }
        epds.add(v.epd);
        selected.set(row, r);
        got++;
      }
      if (got < c.quota) inc(shortfall, c.group, c.quota - got);
    }
  }
  const nValidated = validated.size;
  const nPassed = [...validated.values()].filter((v) => v.ok).length;
  const validationPassRate = nValidated ? nPassed / nValidated : 1;
  const duplicateRate = nPassed ? dupRows.size / nPassed : 0;

  /* ---------- shards + meta ---------- */
  const byBand = new Map<string, TacticTuple[]>();
  const conceptCounts: Record<string, number> = {};
  const conceptTierCounts: Record<string, Record<string, number>> = {};
  const themeConceptCounts: Record<string, number> = {};
  const lengthCounts: Record<string, number> = {};
  const bandCounts: Record<string, number> = {};
  const selectedThemeCounts: Record<string, number> = {};
  const defensePool: Record<string, number> = { defensiveMove: 0, equality: 0, either: 0 };
  for (const r of selected.values()) {
    const themes = r.themes.split(' ').filter(Boolean);
    const concept = primaryTacticConcept(themes);
    if (!concept) throw new Error(`selected puzzle ${r.id} has no concept`);
    const band = bandKeyForRating(r.rating);
    const list = byBand.get(band);
    const tuple: TacticTuple = [r.id, r.fen, r.moves, r.rating, r.rd, r.themes, r.openingTags];
    if (list) list.push(tuple);
    else byBand.set(band, [tuple]);
    inc(conceptCounts, concept);
    inc((conceptTierCounts[concept] ??= {}), band);
    inc(lengthCounts, lengthOf(themes, r.moves.split(' ').length));
    inc(bandCounts, band);
    for (const t of themes) {
      inc(selectedThemeCounts, t);
      const cid = TACTIC_THEME_TO_CONCEPT.get(t);
      if (cid) inc(themeConceptCounts, cid);
    }
    const d = themes.includes('defensiveMove');
    const q = themes.includes('equality');
    if (d) inc(defensePool, 'defensiveMove');
    if (q) inc(defensePool, 'equality');
    if (d || q) inc(defensePool, 'either');
  }
  // Concepts that exist in the registry but received nothing are reported explicitly as 0.
  for (const id of TACTIC_THEME_TO_CONCEPT.values()) {
    conceptCounts[id] ??= 0;
    themeConceptCounts[id] ??= 0;
    availableConceptCounts[id] ??= 0;
  }
  const bandNum = (a: [string, unknown], b: [string, unknown]): number => Number(a[0]) - Number(b[0]);
  const shards = [...byBand.entries()].sort(bandNum).map(([key, data]) => {
    data.sort((a, b) => a[3] - b[3] || a[0].localeCompare(b[0]));
    return { file: bandFileForKey(key), key, count: data.length, data };
  });
  const meta = {
    rowsRead,
    rowsAfterFilter,
    selected: selected.size,
    validationPassRate,
    duplicateRate,
    unmappedThemeCounts: sortedRecord(unmappedThemeCounts, true),
    conceptCounts: sortedRecord(conceptCounts),
    conceptTierCounts: Object.fromEntries(
      Object.entries(conceptTierCounts)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([k, v]) => [k, Object.fromEntries(Object.entries(v).sort(bandNum))]),
    ),
    lengthCounts: Object.fromEntries(LENGTHS.map((l) => [l, lengthCounts[l] ?? 0])),
    bandCounts: Object.fromEntries(Object.entries(bandCounts).sort(bandNum)),
    // Extra detail for the QA report.
    filter: { minPopularity: MIN_POPULARITY, maxRatingDeviation: MAX_RD },
    target,
    limit: limit || null,
    seed: SEED,
    malformedRows,
    skippedNoConcept,
    validated: nValidated,
    validationFailures: sortedRecord(failReasons, true),
    duplicatesDropped: dupRows.size,
    quotaShortfall: sortedRecord(shortfall),
    /** Puzzles carrying each mapped theme at all (primary or secondary). */
    themeConceptCounts: sortedRecord(themeConceptCounts),
    /** Filtered source rows per primary concept (the supply the quotas were drawn from). */
    availableConceptCounts: sortedRecord(availableConceptCounts),
    defensePool,
    selectedThemeCounts: sortedRecord(selectedThemeCounts, true),
    sourceHeader: header,
    sourceBytes: src.bytes,
    sourceExpectedBytes: src.expectedBytes,
  };
  console.log(
    `[tactics] selected ${selected.size} (target ${target}); validated ${nValidated}, pass rate ${(validationPassRate * 100).toFixed(3)}%, duplicates ${dupRows.size} (${(duplicateRate * 100).toFixed(3)}%)`,
  );
  if (dry) {
    console.log(JSON.stringify(meta, null, 1));
    return;
  }
  if (limit) console.warn(`[tactics] WARNING: --limit ${limit} was used; this pack is a partial test build`);
  writePack('tactics', 'tactics', { version: VERSION, license: 'CC0-1.0', source: URL, meta }, shards);
  const dir = ensureDir(path.join(PACKS, 'tactics'));
  fs.writeFileSync(
    path.join(dir, 'themes.json'),
    JSON.stringify({ source: URL, filter: meta.filter, rowsAfterFilter, themes: sortedRecord(themeCounts, true) }, null, 1),
  );
  console.log(`[tactics] wrote ${Object.keys(themeCounts).length} themes to themes.json`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
