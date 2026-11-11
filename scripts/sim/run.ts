/** `npm run sim`: runs every policy on the same simulated learners and writes docs/sim-results.md + public/evidence/sim.json. */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, arg } from '../lib/pack';
import { FORGET_HALF_LIFE_DAYS, GAIN, HEADROOM, runPolicy, type PolicyName, type PolicyResult, type SimConfig } from './sim';

const cfg: SimConfig = {
  learners: Number(arg('learners', '24')),
  days: Number(arg('days', '30')),
  sessionMinutes: Number(arg('minutes', '10')) as SimConfig['sessionMinutes'],
  retentionGapDays: Number(arg('gap', '21')),
  seed: Number(arg('seed', '1')),
  concepts: Number(arg('concepts', '40')),
};
const policies: PolicyName[] = ['adaptive', 'adaptive-no-curriculum', 'random', 'weakest-only', 'fixed-curriculum'];
const metrics: { key: keyof PolicyResult; label: string; better: 'lower' | 'higher' }[] = [
  { key: 'rmseEstimate', label: 'Estimate RMSE, all concepts', better: 'lower' },
  { key: 'rmsePractised', label: 'Estimate RMSE, practised concepts', better: 'lower' },
  { key: 'brier', label: 'Brier score', better: 'lower' },
  { key: 'ece', label: 'Calibration error (ECE)', better: 'lower' },
  { key: 'maxStreak', label: 'Max same-concept streak', better: 'lower' },
  { key: 'conceptEntropy', label: 'Concept entropy (0-1)', better: 'higher' },
  { key: 'distinctPerSession', label: 'Distinct concepts per session', better: 'higher' },
  { key: 'meanGain', label: 'Mean hidden-skill gain', better: 'higher' },
  { key: 'retention', label: `Retention: P(solve tier item) after ${cfg.retentionGapDays} idle days`, better: 'higher' },
  { key: 'meanP', label: 'Mean true success probability', better: 'higher' },
];

const t = Date.now();
const results: PolicyResult[] = [];
for (const p of policies) {
  const r = runPolicy(p, cfg);
  results.push(r);
  console.log(`[sim] ${p.padEnd(24)} rmse ${r.rmseEstimate.toFixed(0)} brier ${r.brier.toFixed(3)} streak ${r.maxStreak} entropy ${r.conceptEntropy.toFixed(2)} gain ${r.meanGain.toFixed(1)} retention ${r.retention.toFixed(3)}`);
}

const fmt = (v: number): string => (Number.isNaN(v) ? '—' : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(3));
const winner = (m: (typeof metrics)[number]): PolicyName => {
  const sorted = [...results].sort((a, b) => ((a[m.key] as number) - (b[m.key] as number)) * (m.better === 'lower' ? 1 : -1));
  return sorted[0]!.policy;
};
const verdict: string[] = [];
const adaptive = results.find((r) => r.policy === 'adaptive')!;
for (const m of metrics) {
  const w = winner(m);
  const a = adaptive[m.key] as number;
  const best = results.find((r) => r.policy === w)![m.key] as number;
  verdict.push(w === 'adaptive' ? `${m.label}: the adaptive scheduler is best (${fmt(a)}).` : `${m.label}: ${w} is best (${fmt(best)}); adaptive scores ${fmt(a)}.`);
}

const md = [
  '# Simulation results',
  '',
  `Generated ${new Date().toISOString()} by \`npm run sim\` in ${((Date.now() - t) / 1000).toFixed(1)} s.`,
  '',
  `Setup: ${cfg.learners} simulated learners, ${cfg.days} daily ${cfg.sessionMinutes}-minute sessions, ${cfg.concepts} concepts across domains, seed ${cfg.seed}. Every policy sees the same learners. Hidden skill per concept = global + domain + concept offsets; each attempt adds ${GAIN} rating points with diminishing returns over a ${HEADROOM}-point headroom, regardless of success; skills decay toward the start with a ${FORGET_HALF_LIFE_DAYS}-day half-life. These are assumptions, chosen not to favour any particular target success band.`,
  '',
  'Policies: **adaptive** = this scheduler with the curriculum (concepts unlock over time); **adaptive-no-curriculum** = the same scheduler with every concept open; **random** = uniform concept and item; **weakest-only** = always the lowest-estimated concept at 50% predicted success; **fixed-curriculum** = concepts in tier order, 12 attempts each.',
  '',
  `| Metric | ${policies.join(' | ')} |`,
  `| --- | ${policies.map(() => '---').join(' | ')} |`,
  ...metrics.map((m) => `| ${m.label} (${m.better} is better) | ${results.map((r) => fmt(r[m.key] as number)).join(' | ')} |`),
  '',
  '## Verdict per metric',
  '',
  ...verdict.map((v) => `- ${v}`),
  '',
  '## Caveats',
  '',
  '- The learning model is a simplification; real learners may benefit more (or less) from practice near a target success rate. Gains here come only from how practice is allocated across concepts and time.',
  '- The adaptive policy with the curriculum deliberately starts with few concepts open, which raises its estimation error on concepts it has not reached yet; compare the "practised concepts" row.',
  '- Estimation error is measured against the hidden skill at the end of the run.',
  '',
].join('\n');

fs.writeFileSync(path.join(ROOT, 'docs', 'sim-results.md'), md);
fs.mkdirSync(path.join(ROOT, 'public', 'evidence'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'public', 'evidence', 'sim.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), config: cfg, metrics, rows: results, verdict }, null, 1),
);
console.log('[sim] wrote docs/sim-results.md and public/evidence/sim.json');
