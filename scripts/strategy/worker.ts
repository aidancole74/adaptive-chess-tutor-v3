/**
 * Strategy worker process: analyses every task with index % of === shard from the task file, skipping keys
 * already present in any checkpoint (.cache/strategy-w*.ndjson), and appends one result line per task to
 * .cache/strategy-w<shard>.ndjson. Started by scripts/strategy/build.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { arg, CACHE, NodeStockfish } from '../lib/pack';
import { analyseTask, type Task } from './analyse';

export function checkpointFiles(): string[] {
  if (!fs.existsSync(CACHE)) return [];
  return fs
    .readdirSync(CACHE)
    .filter((f) => /^strategy-w\d+\.ndjson$/.test(f))
    .map((f) => path.join(CACHE, f));
}

export function doneKeys(): Set<string> {
  const done = new Set<string>();
  for (const f of checkpointFiles()) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        done.add((JSON.parse(line) as { key: string }).key);
      } catch {
        /* partial last line after a kill */
      }
    }
  }
  return done;
}

async function main(): Promise<void> {
  const shard = Number(arg('shard', '0'));
  const of = Number(arg('of', '1'));
  const depth = Number(arg('depth', '14'));
  const taskFile = arg('tasks', path.join(CACHE, 'strategy-tasks.json'))!;
  const tasks = JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Task[];
  const done = doneKeys();
  const mine = tasks.filter((t, i) => i % of === shard && !done.has(t.key));
  const out = path.join(CACHE, `strategy-w${shard}.ndjson`);
  const sf = new NodeStockfish();
  await sf.init({ Hash: 32 });
  let n = 0;
  let kept = 0;
  const t0 = Date.now();
  for (const task of mine) {
    const res = await analyseTask(sf, task, depth);
    fs.appendFileSync(out, JSON.stringify(res) + '\n');
    n++;
    if ('item' in res) kept++;
    if (n % 100 === 0) {
      console.log(`[strategy w${shard}] ${n}/${mine.length} analysed, ${kept} kept, ${((Date.now() - t0) / n).toFixed(0)} ms/pos`);
    }
  }
  sf.quit();
  console.log(`[strategy w${shard}] done: ${n} analysed, ${kept} kept`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
