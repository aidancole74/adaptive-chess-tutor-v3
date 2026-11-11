/** Wires domain providers into the single app pool. */
import { createPool, type AppPool, type Provider } from './pool';
import { createTacticsProvider, type TacticsProvider } from './providers/tactics';
import { createOpeningsProvider, type OpeningsProvider } from './providers/openings';
import { buildLessonCard } from '../curriculum/lessons';
import { createCalculationProvider } from './providers/calculation';
import { loadKv } from '../model/db';
import type { Repertoire } from './repertoire';

import { createProcessProvider, type ProcessProvider } from './providers/process';

let process: ProcessProvider | null = null;
export function getProcess(): ProcessProvider {
  process ??= createProcessProvider(getTactics);
  return process;
}

import { createEndgamesProvider, type EndgamesProvider } from './providers/endgames';

let endgames: EndgamesProvider | null = null;
export function getEndgames(): EndgamesProvider {
  endgames ??= createEndgamesProvider();
  return endgames;
}

import { createStrategyProvider, type StrategyProvider } from './providers/strategy';

let strategy: StrategyProvider | null = null;
export function getStrategy(): StrategyProvider {
  strategy ??= createStrategyProvider((items) => {
    getTactics().setQuiet(items);
    getProcess().setStrategy(items);
  });
  return strategy;
}

let pool: AppPool | null = null;
let tactics: TacticsProvider | null = null;
let openings: OpeningsProvider | null = null;
const extra: Provider[] = [];

export function getTactics(): TacticsProvider {
  tactics ??= createTacticsProvider();
  return tactics;
}

export function getOpenings(): OpeningsProvider {
  openings ??= createOpeningsProvider(() => loadKv<{ w?: Repertoire; b?: Repertoire }>('repertoire'));
  return openings;
}

/** Register an additional provider before or after the pool exists. */
export function registerProvider(p: Provider): void {
  if (extra.some((e) => e.id === p.id)) return;
  extra.push(p);
  if (pool) pool.providers.push(p);
}

export function getPool(): AppPool {
  if (!pool) {
    pool = createPool([getTactics(), createCalculationProvider(getTactics), getOpenings(), getProcess(), getEndgames(), getStrategy(), ...extra]);
    pool.setLessonBuilder((conceptId, p) => buildLessonCard(conceptId, p));
  }
  return pool;
}
