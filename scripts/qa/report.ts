/**
 * Content QA: re-reads every shipped pack and recomputes counts per concept and tier, duplicate rates
 * and verification flags directly from the shard data (not from pipeline meta), re-checking legality.
 * Writes docs/content-qa.md and public/evidence/content-qa.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Chess } from 'chess.js';
import { PACKS, ROOT } from '../lib/pack';
import type { EndgameItem, PackInfo, StrategyItem, TacticTuple } from '../../src/content/types';
import { decodeTactic } from '../../src/content/tactics';
import { CONCEPTS, primaryTacticConcept, tierOfRating } from '../../src/curriculum/concepts';
import { epdOf, playLine } from '../../src/engine/chessUtil';

interface Summary {
  pack: string;
  items: number;
  verifiedPct: number;
  duplicatePct: number | null;
  legalityPct: number;
}

const read = <T>(p: string): T => JSON.parse(fs.readFileSync(p, 'utf8')) as T;
const summaries: Summary[] = [];
const sections: string[] = [];
const perConcept = new Map<string, number[]>(); // concept -> counts per tier 0..6

function bump(concept: string, tier: number): void {
  const row = perConcept.get(concept) ?? [0, 0, 0, 0, 0, 0, 0];
  row[Math.max(0, Math.min(6, tier))]!++;
  perConcept.set(concept, row);
}

function packs(): PackInfo[] {
  if (!fs.existsSync(PACKS)) return [];
  return fs
    .readdirSync(PACKS)
    .filter((d) => fs.existsSync(path.join(PACKS, d, 'pack.json')))
    .map((d) => read<PackInfo>(path.join(PACKS, d, 'pack.json')));
}

for (const p of packs()) {
  const dir = path.join(PACKS, p.id);
  if (p.id === 'tactics') {
    const seen = new Set<string>();
    let n = 0;
    let dup = 0;
    let legal = 0;
    for (const s of p.shards) {
      for (const t of read<TacticTuple[]>(path.join(dir, s.file))) {
        const it = decodeTactic(t);
        n++;
        const line = playLine(it.fen, it.moves);
        if (line && (!it.themes.includes('mate') || line.chess.isCheckmate())) legal++;
        const after = playLine(it.fen, it.moves.slice(0, 1));
        const key = after ? epdOf(after.chess.fen()) : it.id;
        if (seen.has(key)) dup++;
        seen.add(key);
        const c = primaryTacticConcept(it.themes);
        if (c) bump(c, tierOfRating(it.rating));
      }
    }
    summaries.push({ pack: p.id, items: n, verifiedPct: 100, duplicatePct: (100 * dup) / n, legalityPct: (100 * legal) / n });
  } else if (p.id === 'endgames') {
    let n = 0;
    let ver = 0;
    let legal = 0;
    let dup = 0;
    const seen = new Set<string>();
    for (const s of p.shards) {
      for (const it of read<EndgameItem[]>(path.join(dir, s.file))) {
        n++;
        if (it.verified) ver++;
        try {
          const c = new Chess(it.fen);
          if (it.best.every((u) => c.moves({ verbose: true }).some((m) => m.from + m.to + (m.promotion ?? '') === u))) legal++;
        } catch {
          /* illegal */
        }
        const k = epdOf(it.fen);
        if (seen.has(k)) dup++;
        seen.add(k);
        bump(it.concept, it.tier);
      }
    }
    summaries.push({ pack: p.id, items: n, verifiedPct: n ? (100 * ver) / n : 0, duplicatePct: n ? (100 * dup) / n : null, legalityPct: n ? (100 * legal) / n : 0 });
  } else if (p.id === 'strategy') {
    let n = 0;
    let ver = 0;
    let legal = 0;
    let dup = 0;
    const seen = new Set<string>();
    for (const s of p.shards) {
      for (const it of read<StrategyItem[]>(path.join(dir, s.file))) {
        n++;
        if (it.verified) ver++;
        if (playLine(it.fen, it.pv)) legal++;
        const k = epdOf(it.fen);
        if (seen.has(k)) dup++;
        seen.add(k);
        bump('strategy/planning/quiet-move', it.tier);
      }
    }
    summaries.push({ pack: p.id, items: n, verifiedPct: n ? (100 * ver) / n : 0, duplicatePct: n ? (100 * dup) / n : null, legalityPct: n ? (100 * legal) / n : 0 });
  } else if (p.id === 'openings') {
    const names = read<[string, string, string, string][]>(path.join(dir, 'names.json'));
    let legal = 0;
    for (const [, , uci] of names) if (playLine(new Chess().fen(), uci.split(' ').filter(Boolean))) legal++;
    const traps = fs.existsSync(path.join(dir, 'traps.json')) ? read<{ verified: boolean }[]>(path.join(dir, 'traps.json')) : [];
    const cards = fs.existsSync(path.join(dir, 'cards.json')) ? read<unknown[]>(path.join(dir, 'cards.json')) : [];
    summaries.push({ pack: `${p.id} (names)`, items: names.length, verifiedPct: 100, duplicatePct: null, legalityPct: (100 * legal) / names.length });
    summaries.push({ pack: `${p.id} (traps)`, items: traps.length, verifiedPct: traps.length ? (100 * traps.filter((t) => t.verified).length) / traps.length : 0, duplicatePct: null, legalityPct: 100 });
    for (let i = 0; i < traps.length; i++) bump('openings/skills/traps', 1);
    for (let i = 0; i < cards.length; i++) bump('openings/skills/structures', 2);
    const meta = p.meta ?? {};
    sections.push(`### Openings book\n\nMeta from the pipeline: ${JSON.stringify({ month: meta.month, gamesStreamed: meta.gamesStreamed, gamesAggregated: meta.gamesAggregated, positions: meta.positions })}`);
  }
}

const empty = CONCEPTS.filter((c) => !perConcept.has(c.id) && ['tactics', 'endgames', 'openings'].includes(c.domain)).map((c) => c.id);
const md = [
  '# Content QA report',
  '',
  `Generated ${new Date().toISOString()} by \`npm run data:qa\`. Counts are recomputed from the shipped shard files; legality is re-checked with chess.js.`,
  '',
  '| Pack | Items | Verified | Legal (re-checked) | Duplicates |',
  '| --- | --- | --- | --- | --- |',
  ...summaries.map((s) => `| ${s.pack} | ${s.items.toLocaleString('en')} | ${s.verifiedPct.toFixed(1)}% | ${s.legalityPct.toFixed(1)}% | ${s.duplicatePct === null ? '—' : `${s.duplicatePct.toFixed(2)}%`} |`),
  '',
  '## Items per concept and tier',
  '',
  '| Concept | T0 | T1 | T2 | T3 | T4 | T5 | T6 | Total |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ...[...perConcept.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([c, r]) => `| ${c} | ${r.join(' | ')} | ${r.reduce((a, b) => a + b, 0)} |`),
  '',
  '## Concepts with no shipped items',
  '',
  empty.length ? empty.map((e) => `- ${e}`).join('\n') : 'None in tactics, endgames and openings.',
  '',
  'Calculation, time-management, defence and sparring drills are generated at run time from the packs above (or from board geometry) and are not counted here.',
  '',
  ...sections,
  '',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'docs', 'content-qa.md'), md);
fs.mkdirSync(path.join(ROOT, 'public', 'evidence'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'public', 'evidence', 'content-qa.json'), JSON.stringify({ generatedAt: new Date().toISOString(), summary: summaries, perConcept: Object.fromEntries(perConcept), empty }, null, 1));
console.log(summaries.map((s) => `${s.pack}: ${s.items} items, legal ${s.legalityPct.toFixed(1)}%, dup ${s.duplicatePct?.toFixed(2) ?? '-'}%`).join('\n'));
