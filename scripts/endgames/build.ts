/**
 * npm run data:endgames [-- --per 80] [--concept endgames/rook/lucena]
 *
 * Procedural endgame positions verified by the Lichess tablebase -> public/packs/endgames/.
 * Every candidate: random placement under the generator's structural constraints, a random colour
 * flip / file mirror, legal per chess.js with the side not to move not in check, <= 7 pieces, game
 * not over; then a tablebase probe (cached in .cache/tablebase/<sha1(fen)>.json). Kept only when the
 * probe is exact (no cursed / blessed / maybe / unknown anywhere in it), the side to move is not lost
 * (a lost side has no 'best move' to find), and the generator's defining
 * property holds. All shipped claims come from the probe.
 *
 * Tier heuristic (documented here and in the pack meta):
 *   tier = concept tier
 *        + 1 if exactly one move keeps the result
 *        - 1 if three or more moves keep it and the side to move wins
 *        + 1 if winning with DTM > 40 plies, - 1 if winning with DTM <= 6 plies
 *   clamped to [concept tier - 1, concept tier + 1] and to [0, 6].
 * Play-out target: wins with DTM -> ceil(1.5 * ceil(dtm / 2)) full moves; draws -> 20 moves held;
 * null for wins without DTM (6-7 pieces) or when the generator marks the item as unsuitable.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { EndgameItem } from '../../src/content/types';
import { CONCEPT_BY_ID } from '../../src/curriculum/concepts';
import { pieceCount } from '../../src/engine/chessUtil';
import { createTablebase, type TbCache, type TbProbeOk } from '../../src/engine/tablebase';
import { arg, CACHE, ensureDir, writePack } from '../lib/pack';
import { canonicalKey, hashStr, legalStart, mulberry32, xfFen, xfUci, type Xf } from './board';
import { matingGenerators } from './gen-mating';
import { pawnGenerators } from './gen-pawn';
import { pieceGenerators } from './gen-pieces';
import { zugzwangGenerators } from './gen-zugzwang';
import type { Ctx, Generator } from './types';

export const PACK_VERSION = '1';
export const DRAW_HOLD_MOVES = 20;
const CANDIDATE_ATTEMPTS = 400_000;

export const GENERATORS: Generator[] = [...matingGenerators, ...pawnGenerators, ...zugzwangGenerators, ...pieceGenerators];

/** Concepts shipped with zero items because their defining property could not be verified programmatically. */
export const UNVERIFIED: Record<string, string> = {
  'endgames/pawn/triangulation':
    'unverified: no generated position could be shown (tablebase DTM-optimal line returning to the same placement with the defender to move) ' +
    'within the request budget; 200 probed candidates from the first local filter were all refuted (a direct pawn capture was faster), ' +
    'the corrected local filter (tempo loss = fastest plan) produced no candidates. Shipped empty; zugzwang ships instead.',
};

const TB_DIR = path.join(CACHE, 'tablebase');
const fileCache: TbCache = {
  get(key) {
    try {
      const f = path.join(TB_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
      return Promise.resolve(fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as { fen: string; raw: unknown }).raw : undefined);
    } catch {
      return Promise.resolve(undefined);
    }
  },
  set(key, value) {
    ensureDir(TB_DIR);
    const f = path.join(TB_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
    fs.writeFileSync(f, JSON.stringify({ fen: key, raw: value }));
    return Promise.resolve();
  },
};

export function tierFor(conceptTier: number, p: TbProbeOk, nBest: number): number {
  let t = conceptTier;
  if (nBest === 1) t += 1;
  else if (nBest >= 3 && p.category === 'win') t -= 1;
  if (p.category === 'win' && p.dtm !== null) {
    if (p.dtm > 40) t += 1;
    else if (p.dtm <= 6) t -= 1;
  }
  t = Math.max(conceptTier - 1, Math.min(conceptTier + 1, t));
  return Math.max(0, Math.min(6, t));
}

export function playoutTargetFor(p: TbProbeOk, suitable: boolean): number | null {
  if (!suitable) return null;
  if (p.category === 'draw') return DRAW_HOLD_MOVES;
  if (p.category === 'win' && p.dtm !== null && p.dtm > 0) return Math.ceil(1.5 * Math.ceil(p.dtm / 2));
  return null;
}

/** The probe seen in the generator's white frame (moves' UCI transformed back; SAN left as shipped, used only for "x"). */
function toFrame(p: TbProbeOk, frameFen: string, xf: Xf): TbProbeOk {
  return { ...p, fen: frameFen, moves: p.moves.map((m) => ({ ...m, uci: xfUci(m.uci, xf) })) };
}

const fullyExact = (p: TbProbeOk): boolean => p.exact && p.moves.every((m) => m.exact);

interface ConceptStats {
  candidates: number;
  probed: number;
  probeErrors: number;
  inexact: number;
  propertyFailed: number;
  bucketFull: number;
  kept: number;
  onlyMove: number;
  wins: number;
  draws: number;
  losses: number;
  duplicates: number;
  tierCounts: Record<string, number>;
  buckets: Record<string, number>;
  extraProbes: number;
  property: string;
  verificationPassRate: number;
}

async function main(): Promise<void> {
  const per = Number(arg('per', '80'));
  const only = arg('concept');
  const gens = only ? GENERATORS.filter((g) => g.concept === only) : GENERATORS;
  if (gens.length === 0) throw new Error(`unknown concept ${only ?? ''}`);
  const tb = createTablebase({ cache: fileCache, minIntervalMs: 700 });
  const shards: { file: string; key: string; count: number; data: EndgameItem[] }[] = [];
  const meta: Record<string, ConceptStats> = {};
  const zero: Record<string, string> = {};
  let dupTotal = 0;
  const t0 = Date.now();

  for (const [concept, why] of Object.entries(UNVERIFIED)) {
    if (only && only !== concept) continue;
    zero[concept] = why;
    shards.push({ file: `${concept.split('/').pop() ?? 'x'}.json`, key: concept, count: 0, data: [] });
  }

  for (const g of gens) {
    const def = CONCEPT_BY_ID.get(g.concept);
    if (!def) throw new Error(`concept ${g.concept} missing from concepts.ts`);
    const rng = mulberry32(hashStr(g.concept));
    const budget = Math.ceil(per * (g.probeFactor ?? 3));
    const caps = Object.fromEntries(Object.entries(g.buckets).map(([k, v]) => [k, Math.max(1, Math.round(v * per))]));
    const st: ConceptStats = {
      candidates: 0,
      probed: 0,
      probeErrors: 0,
      inexact: 0,
      propertyFailed: 0,
      bucketFull: 0,
      kept: 0,
      onlyMove: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      duplicates: 0,
      tierCounts: {},
      buckets: {},
      extraProbes: 0,
      property: g.property,
      verificationPassRate: 0,
    };
    const seen = new Set<string>();
    const items: EndgameItem[] = [];
    const req0 = tb.stats().requests;
    const full = (b: string | undefined): boolean => b !== undefined && (st.buckets[b] ?? 0) >= (caps[b] ?? 0);

    for (let attempt = 0; attempt < CANDIDATE_ATTEMPTS && items.length < per && st.probed < budget; attempt++) {
      const c = g.candidate(rng);
      if (!c) continue;
      if (c.bucket !== undefined && !(c.bucket in caps)) throw new Error(`${g.concept}: unknown bucket ${c.bucket}`);
      if (full(c.bucket)) continue;
      const xf: Xf = { flip: rng() < 0.5, mirror: rng() < 0.5 };
      let shipFen: string;
      try {
        shipFen = xfFen(c.fen, xf);
      } catch {
        continue;
      }
      if (pieceCount(shipFen) > 7 || !legalStart(shipFen)) continue;
      st.candidates++;
      const key = canonicalKey(shipFen);
      if (seen.has(key)) {
        st.duplicates++;
        continue;
      }
      seen.add(key);
      st.probed++;
      let p = await tb.probe(shipFen);
      // Network trouble is not a verdict: back off and retry the same candidate without spending budget.
      for (let tries = 0; p.status === 'offline' && tries < 40; tries++) {
        console.warn(`[endgames] offline (${p.message}); retry ${tries + 1} in 30 s`);
        await new Promise((res) => setTimeout(res, 30_000));
        p = await tb.probe(shipFen);
      }
      if (p.status === 'offline') throw new Error('tablebase offline for 20 minutes; rerun later (responses so far are cached)');
      if (p.status !== 'ok') {
        st.probeErrors++;
        continue;
      }
      if (!fullyExact(p) || p.moves.length === 0 || p.category === 'loss') {
        st.inexact++;
        continue;
      }
      const ctx: Ctx = {
        rng,
        probe: async (frameFen) => {
          st.extraProbes++;
          let f: string;
          try {
            f = xfFen(frameFen, xf);
          } catch {
            return null;
          }
          if (!legalStart(f)) return null;
          const q = await tb.probe(f);
          return q.status === 'ok' && fullyExact(q) ? toFrame(q, frameFen, xf) : null;
        },
      };
      const v = await g.accept(c, toFrame(p, c.fen, xf), ctx);
      if (!v) {
        st.propertyFailed++;
        continue;
      }
      if (!(v.bucket in caps)) throw new Error(`${g.concept}: unknown bucket ${v.bucket}`);
      if (full(v.bucket)) {
        st.bucketFull++;
        continue;
      }
      const bestList = p.moves.filter((m) => m.category === p.category).map((m) => m.uci);
      if (bestList.length === 0) {
        st.propertyFailed++;
        continue;
      }
      const tier = tierFor(def.tier, p, bestList.length);
      const item: EndgameItem = {
        id: `eg-${g.concept.split('/').pop() ?? 'x'}-${crypto.createHash('sha1').update(shipFen).digest('hex').slice(0, 10)}`,
        concept: g.concept,
        fen: shipFen,
        category: p.category,
        dtm: p.dtm,
        dtz: p.dtz,
        moves: p.moves.map((m) => ({ uci: m.uci, san: m.san, category: m.category, dtm: m.dtm })),
        best: bestList,
        onlyMove: bestList.length === 1,
        tier,
        playoutTarget: playoutTargetFor(p, v.playout),
        verified: true,
      };
      items.push(item);
      st.kept++;
      st.buckets[v.bucket] = (st.buckets[v.bucket] ?? 0) + 1;
      st.tierCounts[String(tier)] = (st.tierCounts[String(tier)] ?? 0) + 1;
      if (item.onlyMove) st.onlyMove++;
      if (p.category === 'win') st.wins++;
      else if (p.category === 'draw') st.draws++;
      else st.losses++;
      if (st.probed % 25 === 0 || items.length % 20 === 0) {
        console.log(`[endgames] ${g.concept}: kept ${items.length}/${per}, probed ${st.probed}/${budget}, requests ${tb.stats().requests}`);
      }
    }
    st.verificationPassRate = st.probed ? Number((st.kept / st.probed).toFixed(3)) : 0;
    dupTotal += st.duplicates;
    meta[g.concept] = st;
    if (items.length === 0) zero[g.concept] = `no candidate satisfied the verified property within ${budget} probes (${st.probed} probed)`;
    console.log(
      `[endgames] ${g.concept}: ${items.length} kept (buckets ${JSON.stringify(st.buckets)}), ${st.probed} probed, ` +
        `${st.extraProbes} extra probes, ${tb.stats().requests - req0} network requests, ${((Date.now() - t0) / 60000).toFixed(1)} min elapsed`,
    );
    shards.push({ file: `${g.concept.split('/').pop() ?? 'x'}.json`, key: g.concept, count: items.length, data: items });
  }

  if (only) {
    console.log('[endgames] --concept given: pack not written (build all concepts to write the pack)');
    console.log(JSON.stringify(meta[only], null, 1));
    return;
  }
  const probed = Object.values(meta).reduce((a, s) => a + s.probed, 0);
  const kept = Object.values(meta).reduce((a, s) => a + s.kept, 0);
  writePack(
    'endgames',
    'endgames',
    {
      version: PACK_VERSION,
      license: 'Positions generated procedurally; results from the Lichess tablebase API (tablebase.lichess.ovh, Syzygy/Gaviota)',
      source: 'scripts/endgames/build.ts',
      meta: {
        perConcept: meta,
        verificationPassRate: probed ? Number((kept / probed).toFixed(3)) : 0,
        duplicatesRemoved: dupTotal,
        zeroItemConcepts: zero,
        requests: tb.stats(),
        tierHeuristic:
          'concept tier +1 if only move, -1 if >=3 winning moves, +1 if DTM>40 plies, -1 if DTM<=6; clamped to concept tier +-1 and 0..6',
        playoutRule: `wins with DTM: ceil(1.5*ceil(dtm/2)) full moves; draws: hold ${DRAW_HOLD_MOVES} moves; else null`,
      },
    },
    shards,
  );
  console.log(`[endgames] done: ${kept} items, ${probed} probed, requests ${JSON.stringify(tb.stats())}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
