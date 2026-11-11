import { DOMAINS, type Domain } from '../content/types';

export type ExplanationStyle = 'concise' | 'detailed' | 'socratic';
export type TimeControlFilter = 'all' | 'bullet' | 'blitz' | 'rapid' | 'classical';
export type BoardTheme = 'classic' | 'high-contrast' | 'blue-orange' | 'mono';

export interface Settings {
  preset: string;
  /** Session length in minutes: 5, 10, 20 or 40. */
  sessionMinutes: 5 | 10 | 20 | 40;
  weeklyTargetMinutes: number;
  /** New concepts introduced per session (0..3). */
  newConceptRate: number;
  /** 0 = practical .. 1 = theoretical: shifts endgame/opening/strategy theory share and explanation depth. */
  depth: number;
  /** 0 none, 1 nudge (highlight piece), 2 show first move. */
  hintLevel: 0 | 1 | 2;
  /** Target success band for core exercises (probabilities between 0.6 and 0.9). */
  bandLow: number;
  bandHigh: number;
  /** Focus mix; normalised by the scheduler. Default 55 / 25 / 20. */
  mixWeakness: number;
  mixReview: number;
  mixExplore: number;
  domainEnabled: Record<Domain, boolean>;
  domainWeight: Record<Domain, number>;
  /** 0..2 multiplier on recency and similarity penalties. */
  varietyStrength: number;
  /** Spaced-repetition retention target, 0.8..0.95. */
  retention: number;
  explanationStyle: ExplanationStyle;
  timeControl: TimeControlFilter;
  /** Colour for opening training. */
  openingColor: 'both' | 'white' | 'black';
  /** Sparring opponent strength relative to the learner's rating (Elo offset). */
  sparringOffset: number;
  goalRating: number | null;
  /** ISO date. */
  goalDate: string | null;
  showEval: boolean;
  notation: 'san' | 'figurine' | 'uci';
  boardTheme: BoardTheme;
  askConfidence: boolean;
  /** Feature flags. */
  llmExplanations: boolean;
  explorerToken: string;
  /** User's own Anthropic API key for optional AI explanations. Stored only on this device; never exported. */
  anthropicKey: string;
}

const allDomains = <T>(v: T): Record<Domain, T> => Object.fromEntries(DOMAINS.map((d) => [d, v])) as Record<Domain, T>;

export const DEFAULT_SETTINGS: Settings = {
  preset: 'balanced',
  sessionMinutes: 10,
  weeklyTargetMinutes: 90,
  newConceptRate: 1,
  depth: 0.4,
  hintLevel: 1,
  bandLow: 0.7,
  bandHigh: 0.8,
  mixWeakness: 55,
  mixReview: 25,
  mixExplore: 20,
  domainEnabled: allDomains(true),
  domainWeight: { tactics: 1, endgames: 0.7, openings: 0.6, strategy: 0.7, calculation: 0.5, defense: 0.4, time: 0.3, sparring: 0.3 },
  varietyStrength: 1,
  retention: 0.9,
  explanationStyle: 'concise',
  timeControl: 'all',
  openingColor: 'both',
  sparringOffset: -100,
  goalRating: null,
  goalDate: null,
  showEval: false,
  notation: 'san',
  boardTheme: 'classic',
  askConfidence: true,
  llmExplanations: false,
  explorerToken: '',
  anthropicKey: '',
};

export const PRESETS: Record<string, { label: string; description: string; patch: Partial<Settings> }> = {
  balanced: { label: 'Balanced', description: 'All domains, 70-80% target success.', patch: {} },
  'tactics-sprint': {
    label: 'Tactics sprint',
    description: 'Short, tactics-heavy sessions aimed at weaknesses.',
    patch: {
      sessionMinutes: 5,
      mixWeakness: 70,
      mixReview: 15,
      mixExplore: 15,
      domainWeight: { tactics: 1, endgames: 0.2, openings: 0.1, strategy: 0.1, calculation: 0.4, defense: 0.2, time: 0.3, sparring: 0 },
    },
  },
  'deep-study': {
    label: 'Deep study',
    description: 'Long sessions, harder band, theoretical depth, detailed explanations.',
    patch: { sessionMinutes: 40, bandLow: 0.6, bandHigh: 0.72, depth: 0.85, explanationStyle: 'detailed', newConceptRate: 2 },
  },
  'confidence-builder': {
    label: 'Confidence builder',
    description: 'Easier band, more review, fewer new concepts.',
    patch: { bandLow: 0.8, bandHigh: 0.9, mixWeakness: 35, mixReview: 45, mixExplore: 20, newConceptRate: 0 },
  },
  'endgame-school': {
    label: 'Endgame school',
    description: 'Endgame technique with high retention.',
    patch: {
      retention: 0.93,
      depth: 0.7,
      domainWeight: { tactics: 0.4, endgames: 1, openings: 0.1, strategy: 0.3, calculation: 0.3, defense: 0.4, time: 0.1, sparring: 0.3 },
    },
  },
};

export function applyPreset(base: Settings, preset: string): Settings {
  const p = PRESETS[preset];
  if (!p) return base;
  return { ...DEFAULT_SETTINGS, ...keepPersonal(base), ...p.patch, preset };
}

/** Presets change training behaviour, not personal display / goal choices. */
function keepPersonal(s: Settings): Partial<Settings> {
  const { boardTheme, notation, showEval, goalRating, goalDate, timeControl, openingColor, explorerToken, anthropicKey, llmExplanations, weeklyTargetMinutes, domainEnabled } = s;
  return { boardTheme, notation, showEval, goalRating, goalDate, timeControl, openingColor, explorerToken, anthropicKey, llmExplanations, weeklyTargetMinutes, domainEnabled };
}

/** Clamp user-entered values to the supported ranges. */
export function sanitizeSettings(s: Settings): Settings {
  const c = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));
  const bandLow = c(s.bandLow, 0.6, 0.88);
  const bandHigh = c(Math.max(s.bandHigh, bandLow + 0.02), 0.62, 0.9);
  return {
    ...s,
    bandLow,
    bandHigh,
    retention: c(s.retention, 0.8, 0.95),
    varietyStrength: c(s.varietyStrength, 0, 2),
    newConceptRate: Math.round(c(s.newConceptRate, 0, 3)),
    depth: c(s.depth, 0, 1),
    mixWeakness: c(s.mixWeakness, 0, 100),
    mixReview: c(s.mixReview, 0, 100),
    mixExplore: c(s.mixExplore, 0, 100),
  };
}
