import type { Domain } from '../content/types';
import type { ErrorCause, ExerciseFormat, SimilarityKey } from '../exercises/types';

/** One node of the hierarchy (global > domain > skill > concept) or a context offset node. */
export interface NodeState {
  /** Own (unpooled) estimate on the rating scale. Context nodes store an offset around 0. */
  theta: number;
  sigma: number;
  /** Epoch ms of the last observation; null = never observed. */
  lastSeen: number | null;
  /** Opportunities and summed scores: weakness is always relative to opportunities. */
  n: number;
  solved: number;
}

export type MemoryPhase = 'new' | 'learning' | 'review';

/** FSRS-style memory state for memorised content (opening nodes, technique, cards). */
export interface MemoryState {
  conceptId: string;
  /** Days until recall probability falls to 90%. */
  stability: number;
  /** 1 (easy) .. 10 (hard). */
  difficulty: number;
  lastReview: number;
  due: number;
  reps: number;
  lapses: number;
  phase: MemoryPhase;
}

export interface AttemptRecord {
  t: number;
  exerciseId: string;
  itemId: string;
  domain: Domain;
  conceptId: string;
  format: ExerciseFormat;
  difficulty: number;
  /** Predicted probability of success before the attempt. */
  p: number;
  score: number;
  solved: boolean;
  timeMs: number;
  hintsUsed: number;
  confidence?: number;
  cause?: ErrorCause;
  sim: SimilarityKey;
  /** Scheduler slot category, kept for the evidence page. */
  slot?: string;
  sessionId?: string;
}

export type CurriculumStage = 'locked' | 'lesson' | 'supported' | 'unsupported' | 'check' | 'mastered';

export interface CurriculumState {
  stage: CurriculumStage;
  /** Successes accumulated in the current stage. */
  progress: number;
  /** Attempts in the current stage (mastery checks need a pass rate). */
  attempts: number;
  unlockedAt: number | null;
  masteredAt: number | null;
}

export interface LearnerState {
  version: 1;
  createdAt: number;
  /** Keys: "global", domain, "domain/skill", concept id, and context nodes "ctx:phase:endgame", "ctx:color:w", "ctx:tc:blitz". */
  nodes: Record<string, NodeState>;
  memory: Record<string, MemoryState>;
  /** Learned difficulty offsets for generated content, keyed by `${format}|${conceptId}`. */
  itemOffsets: Record<string, { offset: number; n: number }>;
  history: AttemptRecord[];
  /** Error-cause counts per concept ("*" = all). */
  causes: Record<string, Partial<Record<ErrorCause, number>>>;
  curriculum: Record<string, CurriculumState>;
  /** Whether the placement test or an import has seeded the global rating. */
  seeded: boolean;
}

export const HISTORY_CAP = 6000;
