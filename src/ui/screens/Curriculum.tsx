import type { ReactElement } from 'react';
import { useApp } from '../store';
import { CONCEPTS, TIER_LABELS, conceptName } from '../../curriculum/concepts';
import { canUnlock, gateOpen, stageOf } from '../../curriculum/progress';
import { mastery } from '../../model/learner';
import { getPool } from '../../content/registry';

const STAGE_LABEL: Record<string, string> = {
  locked: 'Locked', lesson: 'Lesson next', supported: 'Supported practice', unsupported: 'Practice', check: 'Mastery check', mastered: 'Mastered',
};

export default function Curriculum(): ReactElement {
  const { learner } = useApp();
  const now = Date.now();
  const gate = gateOpen(learner, now);
  const available = new Set(getPool().concepts());
  const tiers = [0, 1, 2, 3, 4, 5, 6];
  return (
    <section className="curriculum" data-testid="curriculum">
      <h1>Curriculum map</h1>
      <p>
        Concepts unlock when their prerequisites reach {Math.round(60)}% mastery with a confident estimate. Mastery fades without review and sends a concept back to a mastery check.
        Basic-blunder gate for tier 3+:{' '}
        <strong data-testid="gate">
          {gate.open ? 'open' : 'closed'}
          {gate.rate !== null ? ` (${Math.round(gate.rate * 100)}% misses on hanging pieces / mate in 1 over the last ${gate.n})` : gate.provisional ? ' (provisional: strong overall estimate)' : ' (needs at least 8 basic exercises)'}
        </strong>
        .
      </p>
      {tiers.map((t) => {
        const defs = CONCEPTS.filter((c) => c.tier === t);
        if (defs.length === 0) return null;
        return (
          <div key={t} className="tier">
            <h2>
              Tier {t} <small>({TIER_LABELS[t]})</small>
            </h2>
            <ul className="concepts">
              {defs.map((d) => {
                const stage = stageOf(learner, d.id);
                const m = mastery(learner, d.id, now);
                const blockers = stage === 'locked' ? canUnlock(learner, d, now).blockers : [];
                return (
                  <li key={d.id} className={`concept stage-${stage}`} data-testid={`concept-${d.id}`}>
                    <strong>{d.name}</strong> <span className="badge">{STAGE_LABEL[stage]}</span> <span className="muted">mastery {Math.round(m.value * 100)}% ± {Math.round(m.sigma)}</span>
                    {!available.has(d.id) && <span className="muted"> · no content loaded yet</span>}
                    {d.prereqs.length > 0 && <div className="muted">Needs: {d.prereqs.map((p) => `${conceptName(p.id)}${p.type === 'recommends' ? ' (recommended)' : ''}`).join(', ')}</div>}
                    {blockers.length > 0 && <div className="blockers">{blockers.join(' · ')}</div>}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
