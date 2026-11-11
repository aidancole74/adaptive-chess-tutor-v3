/** Small dependency-free SVG charts with text alternatives. */
import type { ReactElement } from 'react';
import type { ReliabilityBin } from '../model/calibration';

export function ReliabilityChart({ bins, title }: { bins: ReliabilityBin[]; title: string }): ReactElement {
  const W = 260;
  const H = 260;
  const pad = 30;
  const x = (p: number): number => pad + p * (W - 2 * pad);
  const y = (p: number): number => H - pad - p * (H - 2 * pad);
  const used = bins.filter((b) => b.n > 0);
  const maxN = Math.max(1, ...used.map((b) => b.n));
  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}. ${used.map((b) => `predicted ${Math.round(b.meanP * 100)}%, actual ${Math.round(b.rate * 100)}% over ${b.n}`).join('; ') || 'no data yet'}`}>
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} className="diag" />
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(0)} className="axis" />
        <line x1={x(0)} y1={y(0)} x2={x(0)} y2={y(1)} className="axis" />
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <text x={x(t)} y={H - 10} textAnchor="middle" className="tick">{Math.round(t * 100)}%</text>
            <text x={8} y={y(t) + 4} className="tick">{Math.round(t * 100)}</text>
          </g>
        ))}
        {used.map((b, i) => (
          <circle key={i} cx={x(b.meanP)} cy={y(b.rate)} r={3 + 6 * Math.sqrt(b.n / maxN)} className="dot" />
        ))}
      </svg>
      <figcaption>{title}: predicted (x) vs actual (y); on the diagonal = well calibrated.</figcaption>
    </figure>
  );
}

export function Bars({ rows, title, format = (v: number) => String(v) }: { rows: { label: string; value: number }[]; title: string; format?: (v: number) => string }): ReactElement {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure className="bars" aria-label={title}>
      <figcaption>{title}</figcaption>
      {rows.map((r) => (
        <div key={r.label} className="bar-row">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track">
            <span className="bar-fill" style={{ width: `${(100 * r.value) / max}%` }} />
          </span>
          <span className="bar-value">{format(r.value)}</span>
        </div>
      ))}
    </figure>
  );
}
