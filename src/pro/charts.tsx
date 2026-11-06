// Small, crisp SVG charts for the professional terminal: line charts with a
// second series and a marker, a Monte Carlo fan, horizontal bars.
import type { ReactNode } from 'react';

const path = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');

export function LineChart({ series, height = 160, marker, log = true, labels }: { series: { values: number[]; color: string; width?: number; dash?: string }[]; height?: number; marker?: number; log?: boolean; labels?: ReactNode }) {
  const W = 600;
  const H = height;
  const all = series.flatMap((s) => s.values).filter((v) => Number.isFinite(v) && (!log || v > 0));
  if (!all.length) return <div className="pro-empty">No data</div>;
  const f = (v: number) => (log ? Math.log(v) : v);
  const lo = Math.min(...all.map(f));
  const hi = Math.max(...all.map(f));
  const pad = (hi - lo) * 0.08 || 1;
  const y = (v: number) => H - 14 - ((f(v) - lo + pad) / (hi - lo + 2 * pad)) * (H - 24);
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i: number) => (i / Math.max(1, n - 1)) * (W - 48);
  const ticks = [lo, (lo + hi) / 2, hi].map((t) => (log ? Math.exp(t) : t));
  return (
    <div className="pro-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={0} x2={W - 48} y1={y(t)} y2={y(t)} className="pro-grid" />
            <text x={W - 44} y={y(t) + 3} className="pro-tick">
              {log ? `${t.toFixed(2)}×` : t.toFixed(2)}
            </text>
          </g>
        ))}
        {marker !== undefined && marker > 0 && <line x1={x(marker)} x2={x(marker)} y1={0} y2={H - 10} className="pro-split" />}
        {series.map((s, k) => (
          <path key={k} d={path(s.values.map((v, i) => [x(i), y(v)]))} fill="none" stroke={s.color} strokeWidth={s.width ?? 1.4} strokeDasharray={s.dash} vectorEffect="non-scaling-stroke" />
        ))}
      </svg>
      {labels && <div className="pro-chart-legend">{labels}</div>}
    </div>
  );
}

/** Monte Carlo fan: 5–95 and 25–75 percentile bands, median line */
export function Fan({ fan, height = 140 }: { fan: number[][]; height?: number }) {
  const W = 600;
  const H = height;
  if (fan.length < 2) return <div className="pro-empty">Too few trades to simulate</div>;
  const all = fan.flat().filter((v) => v > 0);
  const lo = Math.log(Math.min(...all));
  const hi = Math.log(Math.max(...all));
  const y = (v: number) => H - 12 - ((Math.log(Math.max(v, 1e-9)) - lo) / (hi - lo || 1)) * (H - 22);
  const x = (i: number) => (i / (fan.length - 1)) * (W - 48);
  const band = (a: number, b: number) => path([...fan.map((p, i) => [x(i), y(p[a])] as [number, number]), ...fan.map((p, i) => [x(i), y(p[b])] as [number, number]).reverse()]) + 'Z';
  return (
    <div className="pro-chart">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
        <line x1={0} x2={W - 48} y1={y(1)} y2={y(1)} className="pro-grid" />
        <text x={W - 44} y={y(1) + 3} className="pro-tick">
          1.00×
        </text>
        <path d={band(0, 4)} className="pro-fan-outer" />
        <path d={band(1, 3)} className="pro-fan-inner" />
        <path d={path(fan.map((p, i) => [x(i), y(p[2])]))} fill="none" className="pro-fan-mid" vectorEffect="non-scaling-stroke" />
        <text x={W - 44} y={y(fan[fan.length - 1][4]) + 3} className="pro-tick">
          {fan[fan.length - 1][4].toFixed(2)}×
        </text>
        <text x={W - 44} y={y(fan[fan.length - 1][0]) + 3} className="pro-tick">
          {fan[fan.length - 1][0].toFixed(2)}×
        </text>
      </svg>
    </div>
  );
}

export function Bars({ rows, max, format = (v) => v.toFixed(2) }: { rows: { label: string; value: number; tone?: 'up' | 'down' }[]; max?: number; format?: (v: number) => string }) {
  const m = max ?? Math.max(1e-9, ...rows.map((r) => Math.abs(r.value)));
  return (
    <div className="pro-bars">
      {rows.map((r) => (
        <div key={r.label} className="pro-bar-row">
          <span className="pro-bar-label">{r.label}</span>
          <span className="pro-bar-track">
            <i className={r.tone ?? (r.value >= 0 ? 'up' : 'down')} style={{ width: `${Math.min(100, (Math.abs(r.value) / m) * 100)}%` }} />
          </span>
          <span className="pro-bar-val mono">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}
