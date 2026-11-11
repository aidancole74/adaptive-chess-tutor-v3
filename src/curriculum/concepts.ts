/**
 * Concept taxonomy and typed prerequisite DAG.
 * Ids are "domain/skill/concept". Tactics concepts use Lichess theme names as the leaf.
 * Tiers: 0 (<800) .. 6 (2200+). This file is curriculum design, not chess content:
 * every position served for a concept still comes from a verified pack.
 */
import type { Domain } from '../content/types';

export type PrereqType = 'requires' | 'recommends';

export interface ConceptDef {
  id: string;
  domain: Domain;
  skill: string;
  name: string;
  tier: number;
  prereqs: { id: string; type: PrereqType }[];
  /** Memorised content uses the FSRS model rather than the rating model for scheduling reviews. */
  memory?: boolean;
  /** Basic-blunder concepts feed the gate for advanced material. */
  basic?: boolean;
  /** Behind the basic-blunder gate. */
  gated?: boolean;
}

export const TIER_BOUNDS = [800, 1100, 1400, 1700, 1950, 2200];
/** Difficulty prior (rating scale) for generated content of each tier. */
export const TIER_MID = [650, 950, 1250, 1550, 1825, 2075, 2350];
export const TIER_LABELS = ['<800', '800-1099', '1100-1399', '1400-1699', '1700-1949', '1950-2199', '2200+'];

export function tierOfRating(r: number): number {
  let t = 0;
  for (const b of TIER_BOUNDS) if (r >= b) t++;
  return t;
}

type P = string | [string, PrereqType];
const defs: ConceptDef[] = [];
function add(id: string, name: string, tier: number, prereqs: P[] = [], extra: Partial<ConceptDef> = {}): void {
  const [domain, skill] = id.split('/') as [Domain, string];
  defs.push({
    id,
    domain,
    skill: `${domain}/${skill}`,
    name,
    tier,
    prereqs: prereqs.map((p) => (typeof p === 'string' ? { id: p, type: 'requires' as const } : { id: p[0], type: p[1] })),
    gated: tier >= 3,
    ...extra,
  });
}
const T = 'tactics';

// ---- Tactics (leaf = Lichess theme name) ----
add(`${T}/basics/hangingPiece`, 'Hanging piece', 0, [], { basic: true });
add(`${T}/basics/mateIn1`, 'Mate in 1', 0, [], { basic: true });
add(`${T}/double-attack/fork`, 'Fork', 1, [`${T}/basics/hangingPiece`]);
add(`${T}/double-attack/pin`, 'Pin', 1, [`${T}/basics/hangingPiece`]);
add(`${T}/double-attack/skewer`, 'Skewer', 1, [`${T}/double-attack/pin`]);
add(`${T}/double-attack/discoveredAttack`, 'Discovered attack', 2, [`${T}/double-attack/fork`]);
add(`${T}/double-attack/doubleCheck`, 'Double check', 2, [`${T}/double-attack/discoveredAttack`]);
add(`${T}/double-attack/xRayAttack`, 'X-ray attack', 3, [`${T}/double-attack/skewer`]);
add(`${T}/mating/backRankMate`, 'Back-rank mate', 1, [`${T}/basics/mateIn1`]);
add(`${T}/mating/mateIn2`, 'Mate in 2', 1, [`${T}/basics/mateIn1`]);
add(`${T}/mating/mateIn3`, 'Mate in 3', 2, [`${T}/mating/mateIn2`]);
add(`${T}/mating/mateIn4`, 'Mate in 4', 3, [`${T}/mating/mateIn3`]);
add(`${T}/mating/mateIn5`, 'Mate in 5 or more', 4, [`${T}/mating/mateIn4`]);
add(`${T}/mating/smotheredMate`, 'Smothered mate', 2, [`${T}/mating/mateIn2`]);
add(`${T}/mating/anastasiaMate`, "Anastasia's mate", 3, [`${T}/mating/mateIn2`]);
add(`${T}/mating/arabianMate`, 'Arabian mate', 3, [`${T}/mating/mateIn2`]);
add(`${T}/mating/bodenMate`, "Boden's mate", 3, [`${T}/mating/mateIn2`]);
add(`${T}/mating/doubleBishopMate`, 'Double-bishop mate', 3, [`${T}/mating/mateIn2`]);
add(`${T}/mating/dovetailMate`, 'Dovetail mate', 3, [`${T}/mating/mateIn2`]);
add(`${T}/mating/hookMate`, 'Hook mate', 3, [`${T}/mating/mateIn2`]);
add(`${T}/removing-defender/capturingDefender`, 'Capture the defender', 2, [`${T}/double-attack/fork`]);
add(`${T}/removing-defender/deflection`, 'Deflection', 2, [`${T}/double-attack/fork`, [`${T}/mating/backRankMate`, 'recommends']]);
add(`${T}/removing-defender/attraction`, 'Attraction', 2, [`${T}/double-attack/fork`]);
add(`${T}/removing-defender/clearance`, 'Clearance', 3, [`${T}/removing-defender/deflection`]);
add(`${T}/removing-defender/interference`, 'Interference', 3, [`${T}/removing-defender/deflection`]);
add(`${T}/removing-defender/intermezzo`, 'Intermezzo', 3, [`${T}/removing-defender/capturingDefender`]);
add(`${T}/pawns/promotion`, 'Promotion', 1, [`${T}/basics/hangingPiece`]);
add(`${T}/pawns/advancedPawn`, 'Advanced pawn', 2, [`${T}/pawns/promotion`]);
add(`${T}/pawns/underPromotion`, 'Underpromotion', 4, [`${T}/pawns/promotion`]);
add(`${T}/attack/sacrifice`, 'Sacrifice', 2, [`${T}/mating/mateIn2`]);
add(`${T}/attack/exposedKing`, 'Exposed king', 2, [`${T}/mating/mateIn2`]);
add(`${T}/attack/attackingF2F7`, 'Attacking f2/f7', 2, [`${T}/double-attack/fork`]);
add(`${T}/attack/kingsideAttack`, 'Kingside attack', 2, [`${T}/attack/exposedKing`]);
add(`${T}/attack/queensideAttack`, 'Queenside attack', 3, [`${T}/attack/kingsideAttack`]);
add(`${T}/subtle/trappedPiece`, 'Trapped piece', 2, [`${T}/basics/hangingPiece`]);
add(`${T}/subtle/defensiveMove`, 'Defensive move', 3, [`${T}/double-attack/fork`, `${T}/double-attack/pin`]);
add(`${T}/subtle/quietMove`, 'Quiet move', 4, [`${T}/attack/sacrifice`]);
add(`${T}/subtle/zugzwang`, 'Zugzwang', 4, [`${T}/subtle/quietMove`]);
add(`${T}/awareness/noTactic`, 'Is there a tactic here?', 2, [`${T}/double-attack/fork`, `${T}/double-attack/pin`]);

// ---- Endgames ----
const E = 'endgames';
add(`${E}/mating/kqk`, 'King and queen vs king', 0, [`${T}/basics/mateIn1`], { memory: true });
add(`${E}/mating/krk`, 'King and rook vs king', 1, [`${E}/mating/kqk`], { memory: true });
add(`${E}/pawn/rule-of-the-square`, 'Rule of the square', 1, []);
add(`${E}/pawn/opposition`, 'KPK and the opposition', 1, [`${E}/pawn/rule-of-the-square`], { memory: true });
add(`${E}/pawn/key-squares`, 'Key squares', 2, [`${E}/pawn/opposition`], { memory: true });
add(`${E}/pawn/pawn-race`, 'Pawn races', 2, [`${E}/pawn/rule-of-the-square`]);
add(`${E}/pawn/outside-passed-pawn`, 'Outside passed pawn', 3, [`${E}/pawn/key-squares`]);
add(`${E}/pawn/triangulation`, 'Triangulation', 4, [`${E}/pawn/key-squares`]);
add(`${E}/pawn/zugzwang`, 'Endgame zugzwang', 4, [`${E}/pawn/opposition`]);
add(`${E}/queen/kq-vs-kp`, 'Queen vs pawn on the 7th', 3, [`${E}/mating/kqk`], { memory: true });
add(`${E}/rook/cutting-off-king`, 'Cutting off the king', 2, [`${E}/mating/krk`]);
add(`${E}/rook/rook-behind-passed-pawn`, 'Rook behind the passed pawn', 3, [`${E}/rook/cutting-off-king`]);
add(`${E}/rook/lucena`, 'Lucena position', 3, [`${E}/rook/cutting-off-king`], { memory: true });
add(`${E}/rook/philidor`, 'Philidor position', 3, [`${E}/rook/cutting-off-king`], { memory: true });
add(`${E}/minor/wrong-bishop`, 'Wrong-bishop draws', 3, [`${E}/pawn/key-squares`], { memory: true });
add(`${E}/minor/same-color-bishops`, 'Same-colour bishop endings', 4, [`${E}/minor/wrong-bishop`]);
add(`${E}/minor/opposite-color-bishops`, 'Opposite-colour bishop endings', 4, [`${E}/minor/wrong-bishop`]);
add(`${E}/minor/knight-vs-bishop`, 'Knight vs bishop', 4, [`${E}/pawn/key-squares`]);
add(`${E}/drawing/fortress`, 'Fortresses', 5, [`${E}/minor/wrong-bishop`, `${E}/queen/kq-vs-kp`]);

// ---- Openings ----
const O = 'openings';
add(`${O}/repertoire/white-lines`, 'Repertoire lines as White', 1, [], { memory: true });
add(`${O}/repertoire/black-lines`, 'Repertoire lines as Black', 1, [], { memory: true });
add(`${O}/skills/deviation`, 'Opponent left book', 2, [[`${O}/repertoire/white-lines`, 'recommends']]);
add(`${O}/skills/traps`, 'Opening traps', 1, []);
add(`${O}/skills/structures`, 'Structures and typical plans', 2, [], { memory: true });

// ---- Strategy ----
const S = 'strategy';
add(`${S}/development/development`, 'Development', 1, []);
add(`${S}/king/king-safety`, 'King safety', 1, [`${S}/development/development`]);
add(`${S}/pieces/activity`, 'Piece activity', 2, [`${S}/development/development`]);
add(`${S}/files/open-file`, 'Open files', 2, [`${S}/pieces/activity`]);
add(`${S}/files/semi-open-file`, 'Semi-open files', 3, [`${S}/files/open-file`]);
add(`${S}/pawns/passed`, 'Passed pawns', 2, []);
add(`${S}/pawns/isolated`, 'Isolated pawns', 2, []);
add(`${S}/pawns/doubled`, 'Doubled pawns', 2, []);
add(`${S}/pawns/backward`, 'Backward pawns', 3, [`${S}/pawns/isolated`]);
add(`${S}/pawns/iqp`, 'Isolated queen pawn', 4, [`${S}/pawns/isolated`, `${S}/pieces/activity`]);
add(`${S}/pawns/hanging-pawns`, 'Hanging pawns', 4, [`${S}/pawns/iqp`]);
add(`${S}/pawns/carlsbad`, 'Carlsbad structure', 5, [`${S}/pawns/backward`, `${S}/files/semi-open-file`]);
add(`${S}/pawns/maroczy`, 'Maroczy bind', 5, [`${S}/space/space`]);
add(`${S}/squares/outpost`, 'Outposts', 3, [`${S}/pieces/activity`]);
add(`${S}/squares/weak-squares`, 'Weak squares', 3, [`${S}/squares/outpost`]);
add(`${S}/pieces/bishop-pair`, 'Bishop pair', 3, [`${S}/pieces/activity`]);
add(`${S}/pieces/good-bad-bishop`, 'Good vs bad bishop', 3, [`${S}/pieces/activity`]);
add(`${S}/space/space`, 'Space', 3, [`${S}/pieces/activity`]);
add(`${S}/planning/quiet-move`, 'Best move in a quiet position', 2, [`${S}/pieces/activity`]);
add(`${S}/planning/choose-plan`, 'Choosing a plan', 3, [`${S}/planning/quiet-move`]);
add(`${S}/planning/evaluate-trade`, 'Evaluating trades', 3, [`${S}/planning/quiet-move`]);
add(`${S}/planning/who-is-better`, 'Who is better and why', 3, [`${S}/planning/quiet-move`]);

// ---- Calculation and visualisation ----
const C = 'calculation';
add(`${C}/visualization/coordinates`, 'Board coordinates', 0, []);
add(`${C}/visualization/square-color`, 'Square colours', 0, []);
add(`${C}/visualization/knight-moves`, 'Knight-move visualisation', 1, [`${C}/visualization/coordinates`]);
add(`${C}/candidates/checks-captures-threats`, 'Checks, captures and threats', 1, [`${T}/basics/hangingPiece`]);
add(`${C}/forced/depth-2`, 'Forced lines: 2 moves deep', 1, [`${T}/mating/mateIn2`]);
add(`${C}/forced/depth-3`, 'Forced lines: 3 moves deep', 2, [`${C}/forced/depth-2`]);
add(`${C}/forced/depth-4`, 'Forced lines: 4+ moves deep', 4, [`${C}/forced/depth-3`]);
add(`${C}/visualization/hidden-board`, 'Hidden-board solving', 3, [`${C}/forced/depth-2`, `${C}/visualization/knight-moves`]);
add(`${C}/visualization/blindfold`, 'Blindfold solving', 4, [`${C}/visualization/hidden-board`]);

// ---- Defence and conversion ----
const D = 'defense';
add(`${D}/conversion/convert-winning`, 'Converting a winning position', 2, [`${T}/double-attack/fork`, `${E}/mating/krk`]);
add(`${D}/holding/hold-worse`, 'Holding a worse position', 3, [`${T}/subtle/defensiveMove`]);

// ---- Time management and process ----
const M = 'time';
add(`${M}/process/blunder-check`, 'Blunder-check routine', 0, []);
add(`${M}/process/timed-drill`, 'Speed-accuracy drills', 1, [`${M}/process/blunder-check`]);

// ---- Sparring ----
add('sparring/play/targeted', 'Targeted sparring', 2, [`${D}/conversion/convert-winning`], { gated: false });

export const CONCEPTS: readonly ConceptDef[] = defs;
export const CONCEPT_BY_ID: ReadonlyMap<string, ConceptDef> = new Map(defs.map((d) => [d.id, d]));

export function conceptName(id: string): string {
  return CONCEPT_BY_ID.get(id)?.name ?? id.split('/').pop() ?? id;
}
export function skillOf(id: string): string {
  const [d, s] = id.split('/');
  return `${d}/${s}`;
}
export function domainOf(id: string): Domain {
  return id.split('/')[0] as Domain;
}

/** Lichess theme -> tactics concept id (only motif themes; meta themes such as "short" or "crushing" map to nothing). */
export const TACTIC_THEME_TO_CONCEPT: ReadonlyMap<string, string> = new Map(
  defs.filter((d) => d.domain === 'tactics' && d.id !== `${T}/awareness/noTactic`).map((d) => [d.id.split('/')[2]!, d.id]),
);

/** Lichess themes that describe length, phase, outcome or provenance rather than a motif. */
export const META_THEMES = new Set([
  'oneMove', 'short', 'long', 'veryLong', 'mate', 'crushing', 'advantage', 'equality',
  'opening', 'middlegame', 'endgame', 'master', 'masterVsMaster', 'superGM',
  'rookEndgame', 'pawnEndgame', 'queenEndgame', 'bishopEndgame', 'knightEndgame', 'queenRookEndgame',
  'enPassant', 'castling',
]);

/**
 * Primary concept for a puzzle: the most specific known motif among its themes.
 * Specificity order = later tiers first, then the fixed order of the registry (stable).
 */
export function primaryTacticConcept(themes: string[]): string | null {
  let best: ConceptDef | null = null;
  for (const th of themes) {
    const id = TACTIC_THEME_TO_CONCEPT.get(th);
    if (!id) continue;
    const def = CONCEPT_BY_ID.get(id)!;
    if (!best || specificity(def) > specificity(best)) best = def;
  }
  return best?.id ?? null;
}
// Generic mate-in-N and broad attack labels are less specific than named motifs.
const GENERIC = new Set(['mateIn1', 'mateIn2', 'mateIn3', 'mateIn4', 'mateIn5', 'sacrifice', 'kingsideAttack', 'queensideAttack', 'exposedKing', 'advancedPawn', 'defensiveMove', 'quietMove']);
function specificity(d: ConceptDef): number {
  const leaf = d.id.split('/')[2]!;
  return (GENERIC.has(leaf) ? 0 : 100) + d.tier;
}
