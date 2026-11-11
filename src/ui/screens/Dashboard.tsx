import { useMemo, type ReactElement } from 'react';
import { useApp } from '../store';
import type { Route } from '../App';
import { causeBreakdown, forecast, heatmap, trend } from '../../model/insights';
import { brier, confidenceModel, ece, reliabilityBins } from '../../model/calibration';
import { estimate, weakness } from '../../model/learner';
import { stageOf } from '../../curriculum/progress';
import { Bars, ReliabilityChart } from '../Charts';
import { DOMAINS } from '../../content/types';

const DOMAIN_LABEL: Record<string, string> = {
  tactics: 'Tactics', endgames: 'Endgames', openings: 'Openings', strategy: 'Strategy', calculation: 'Calculation', defense: 'Defence & conversion', time: 'Time & process', sparring: 'Sparring',
};

export function Dashboard({ go }: { go(r: Route): void }): ReactElement {
  const { learner, settings } = useApp();
  const now = Date.now();
  const heat = useMemo(() => heatmap(learner, now), [learner, now]);
  const g = estimate(learner, '', now);
  const rows = learner.history.filter((h) => h.format !== 'lesson');
  const conf = confidenceModel(rows);
  const fc = forecast(learner, now, settings.goalRating, settings.goalDate);
  const weakest = [...heat.values()]
    .flat()
    .filter((c) => c.n >= 3)
    .map((c) => ({ c, w: weakness(learner, c.def.id, now) }))
    .sort((a, b) => b.w.gap - a.w.gap)
    .slice(0, 5);

  return (
    <section className="dashboard" data-testid="dashboard">
      <div className="hero">
        <div>
          <h1>Your training</h1>
          <p data-testid="overall-rating">
            Overall estimate <strong>{Math.round(g.theta)}</strong> ± {Math.round(g.sigma)} (puzzle-rating scale) · {rows.length} exercises
          </p>
        </div>
        <button className="primary big" data-testid="dash-start" onClick={() => go('train')}>
          Start a {settings.sessionMinutes}-minute session
        </button>
      </div>

      <h2>Mastery map</h2>
      <p className="muted">Colour = mastery; opacity = certainty (faded cells are uncertain estimates). Numbers are attempts.</p>
      <div className="heatmap" data-testid="heatmap">
        {DOMAINS.map((d) => (
          <div key={d} className="heat-domain">
            <h3>{DOMAIN_LABEL[d]}</h3>
            <div className="heat-cells">
              {heat.get(d)!.map((c) => {
                const certainty = Math.max(0.25, 1 - c.sigma / 350);
                const stage = stageOf(learner, c.def.id);
                return (
                  <div
                    key={c.def.id}
                    className={`heat-cell stage-${stage}`}
                    style={{ ['--m' as string]: c.mastery, opacity: certainty }}
                    title={`${c.def.name}: ${Math.round(c.theta)} ± ${Math.round(c.sigma)}; ${c.n} attempts${c.rate !== null ? `, ${Math.round(c.rate * 100)}% solved` : ''}; ${stage}`}
                    aria-label={`${c.def.name}: estimate ${Math.round(c.theta)} plus or minus ${Math.round(c.sigma)}, ${c.n} attempts, ${stage}`}
                  >
                    <span>{c.def.name}</span>
                    <small>{c.n}</small>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <div className="grid2">
        <div className="pane">
          <h2>Biggest gaps</h2>
          {weakest.length === 0 ? (
            <p className="muted">Needs at least 3 attempts per concept. Weakness is measured as solve rate relative to opportunities, never by raw error counts.</p>
          ) : (
            <ol>
              {weakest.map(({ c, w }) => (
                <li key={c.def.id}>
                  {c.def.name}: {Math.round(w.gap)} points below your level ({Math.round((w.rate ?? 0) * 100)}% of {w.n})
                </li>
              ))}
            </ol>
          )}
        </div>
        <div className="pane">
          <Bars title="Error causes (tagged or inferred from the clock)" rows={causeBreakdown(learner).map((c) => ({ label: c.cause, value: c.n }))} />
        </div>
        <div className="pane">
          <h2>Trend</h2>
          <Bars
            title="Exercises and solve rate per week"
            rows={trend(learner, now).map((t) => ({ label: t.week === 0 ? 'this week' : `${-t.week}w ago`, value: t.attempts }))}
          />
        </div>
        <div className="pane" data-testid="calibration">
          <h2>Calibration</h2>
          <ReliabilityChart bins={reliabilityBins(rows)} title="Model predictions" />
          <p>
            Brier score {brier(rows)?.toFixed(3) ?? '—'} (0 is perfect, 0.25 is a coin flip) · ECE {ece(rows)?.toFixed(3) ?? '—'} · {rows.length} predictions
          </p>
          <p>
            Your confidence ratings:{' '}
            {conf.n === 0
              ? 'none yet.'
              : `${conf.bias! > 0.05 ? 'overconfident' : conf.bias! < -0.05 ? 'underconfident' : 'well calibrated'} (average gap ${Math.round(Math.abs(conf.bias!) * 100)} points over ${conf.n} answers).`}
          </p>
        </div>
        <div className="pane" data-testid="forecast">
          <h2>Goal forecast</h2>
          {settings.goalRating ? <p>Goal: {settings.goalRating}{settings.goalDate ? ` by ${settings.goalDate}` : ''}.</p> : <p className="muted">Set a goal rating and date in Settings.</p>}
          {fc.weeklyGain && (
            <p>
              Recent trend {fc.weeklyGain.mean >= 0 ? '+' : ''}
              {fc.weeklyGain.mean.toFixed(0)} per week (80% range {fc.weeklyGain.lo.toFixed(0)} to {fc.weeklyGain.hi.toFixed(0)}).
              {fc.projected && ` Projected at the goal date: ${Math.round(fc.projected.lo)}–${Math.round(fc.projected.hi)}.`}
            </p>
          )}
          <p className="muted">{fc.note}</p>
        </div>
      </div>
    </section>
  );
}
