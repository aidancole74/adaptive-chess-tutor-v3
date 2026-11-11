/** Local persistence (IndexedDB via Dexie). Nothing leaves the device; export/import is plain JSON. */
import Dexie, { type Table } from 'dexie';
import type { LearnerState } from './types';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from './settings';

export interface KvRow {
  key: string;
  value: unknown;
}

/** An imported game, stored with its analysis so reviews are instant on return. */
export interface StoredGame {
  id: string;
  source: 'lichess' | 'chesscom' | 'pgn';
  importedAt: number;
  /** Serialised ImportedGame (src/importers/types.ts). */
  game: unknown;
  /** Serialised GameAnalysis (src/diagnosis/types.ts), when analysed. */
  analysis?: unknown;
}

export interface CacheRow {
  key: string;
  value: unknown;
  t: number;
}

export class TutorDb extends Dexie {
  kv!: Table<KvRow, string>;
  games!: Table<StoredGame, string>;
  /** Engine evaluations keyed by EPD|depth. */
  evals!: Table<CacheRow, string>;
  /** Tablebase probes keyed by FEN. */
  tablebase!: Table<CacheRow, string>;

  constructor(name = 'adaptive-chess-tutor') {
    super(name);
    this.version(1).stores({ kv: 'key', games: 'id, importedAt', evals: 'key, t', tablebase: 'key, t' });
  }
}

let db: TutorDb | null = null;
export function getDb(): TutorDb {
  db ??= new TutorDb();
  return db;
}

export async function loadKv<T>(key: string): Promise<T | undefined> {
  return (await getDb().kv.get(key))?.value as T | undefined;
}
export async function saveKv(key: string, value: unknown): Promise<void> {
  await getDb().kv.put({ key, value });
}

/** Async cache adapter (engine evals, tablebase probes). */
export function tableCache(table: 'evals' | 'tablebase'): { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> } {
  return {
    async get(key) {
      try {
        return (await getDb()[table].get(key))?.value;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        await getDb()[table].put({ key, value, t: Date.now() });
      } catch {
        /* storage full or unavailable: caching is best-effort */
      }
    },
  };
}

export const EXPORT_FORMAT = 'adaptive-chess-tutor-export';

export interface ExportFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  learner: LearnerState;
  settings: Settings;
  repertoire?: unknown;
  games: StoredGame[];
}

export function buildExport(learner: LearnerState, settings: Settings, games: StoredGame[], repertoire?: unknown): ExportFile {
  // Secrets never leave the device, even in a user-initiated export.
  const safe: Settings = { ...settings, explorerToken: '', anthropicKey: '' };
  return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), learner, settings: safe, repertoire, games };
}

/** Validate an import. Returns an error string instead of throwing so the UI can show it. */
export function parseImport(text: string): { ok: true; data: ExportFile } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Not valid JSON.' };
  }
  const o = raw as Partial<ExportFile> | null;
  if (!o || o.format !== EXPORT_FORMAT) return { ok: false, error: 'This is not an Adaptive Chess Tutor export file.' };
  if (o.version !== 1) return { ok: false, error: `Unsupported export version ${String(o.version)}.` };
  const l = o.learner;
  if (!l || l.version !== 1 || typeof l.nodes !== 'object' || !l.nodes.global || !Array.isArray(l.history)) {
    return { ok: false, error: 'The learner data in this file is incomplete.' };
  }
  const settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...(o.settings ?? {}) });
  return {
    ok: true,
    data: { format: EXPORT_FORMAT, version: 1, exportedAt: o.exportedAt ?? '', learner: l, settings, repertoire: o.repertoire, games: Array.isArray(o.games) ? o.games : [] },
  };
}
