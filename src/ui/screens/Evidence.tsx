import { useEffect, useState, type ReactElement } from 'react';
import { useApp } from '../store';
import { brier, ece, reliabilityBins } from '../../model/calibration';
import { ReliabilityChart } from '../Charts';

interface SimRow {
  policy: string;
  [metric: string]: number | string;
}
interface SimFile {
  generatedAt: string;
  config: Record<string, unknown>;
  metrics: { key: string; label: string; better: 'lower' | 'higher' }[];
  rows: SimRow[];
  verdict: string[];
}
interface QaFile {
  generatedAt: string;
  summary: { pack: string; items: number; verifiedPct: number; duplicatePct: number | null }[];
}

export default function Evidence(): ReactElement {
  const { learner } = useApp();
  const [sim, setSim] = useState<SimFile | null | undefined>(undefined);
  const [qa, setQa] = useState<QaFile | null | undefined>(undefined);
  useEffect(() => {
    const base = import.meta.env.BASE_URL;
    void fetch(`${base}evidence/sim.json`).then((r) => (r.ok ? r.json() : null)).then(setSim, () => setSim(null));
    void fetch(`${base}evidence/content-qa.json`).then((r) => (r.ok ? r.json() : null)).then(setQa, () => setQa(null));
  }, []);
  const rows = learner.history.filter((h) => h.format !== 'lesson');
  return (
    <section className="evidence" data-testid="evidence">
      <h1>Evidence</h1>
      <p>Does the adaptive scheduler actually help? These results come from <code>npm run sim</code>: simulated learners with hidden skills and forgetting, trained by this scheduler and by simple baselines. They are reported as they came out, including where the scheduler loses.</p>
      {sim === undefined && <p>Loading…</p>}
      {sim === null && <p className="muted">No simulation results are bundled with this build.</p>}
      {sim && (
        <>
          <table className="sim" data-testid="sim-table">
            <thead>
              <tr>
                <th>Policy</th>
                {sim.metrics.map((m) => (
                  <th key={m.key}>
                    {m.label} <small>({m.better} is better)</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sim.rows.map((r) => (
                <tr key={r.policy}>
                  <td>{r.policy}</td>
                  {sim.metrics.map((m) => (
                    <td key={m.key}>{typeof r[m.key] === 'number' ? (r[m.key] as number).toFixed(3) : String(r[m.key] ?? '')}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ul>
            {sim.verdict.map((v, i) => (
              <li key={i}>{v}</li>
            ))}
          </ul>
          <p className="muted">Generated {sim.generatedAt}. Configuration: {JSON.stringify(sim.config)}</p>
        </>
      )}
      <h2>Your own calibration</h2>
      <ReliabilityChart bins={reliabilityBins(rows)} title="Your predictions" />
      <p>
        Brier {brier(rows)?.toFixed(3) ?? '—'} · ECE {ece(rows)?.toFixed(3) ?? '—'} over {rows.length} exercises.
      </p>
      <h2>Content quality</h2>
      {qa ? (
        <table>
          <thead>
            <tr>
              <th>Pack</th>
              <th>Items</th>
              <th>Verified</th>
              <th>Duplicates</th>
            </tr>
          </thead>
          <tbody>
            {qa.summary.map((s) => (
              <tr key={s.pack}>
                <td>{s.pack}</td>
                <td>{s.items.toLocaleString('en')}</td>
                <td>{s.verifiedPct.toFixed(1)}%</td>
                <td>{s.duplicatePct === null ? '—' : `${s.duplicatePct.toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">No content QA report bundled.</p>
      )}
    </section>
  );
}
