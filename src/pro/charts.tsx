// Small, crisp SVG charts for the professional terminal: line charts with a
// second series and a marker, a Monte Carlo fan, horizontal bars.
import { useEffect, useRef, useState, type ReactNode } from 'react';

/** the chart's width in pixels, so wide panels get a wider drawing rather than a taller one */
export function useChartWidth(fallback = 600) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const x = Math.round(e.contentRect.width);
      if (x > 50) setW(x);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

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

/** an area chart in the terminal's style: orange at the top fading to blue, an optional dashed forecast continuation and a level line */
export function AreaChart({ values, forecast = [], level, height = 170, format = (v) => v.toFixed(2) }: { values: number[]; forecast?: number[]; level?: number; height?: number; format?: (v: number) => string }) {
  const [ref, W] = useChartWidth();
  const H = height;
  const all = [...values, ...forecast, ...(level !== undefined ? [level] : [])].filter(Number.isFinite);
  if (values.length < 2 || !all.length) return <div className="pro-empty">No data</div>;
  const lo = 0;
  const hi = Math.max(...all) * 1.08;
  const n = values.length + forecast.length;
  const x = (i: number) => (i / Math.max(1, n - 1)) * (W - 52);
  const y = (v: number) => H - 12 - ((v - lo) / (hi - lo || 1)) * (H - 20);
  const line = values.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line}L${x(values.length - 1).toFixed(1)},${H - 12}L0,${H - 12}Z`;
  const fc = forecast.length ? [values[values.length - 1], ...forecast].map((v, k) => `${k ? 'L' : 'M'}${x(values.length - 1 + k).toFixed(1)},${y(v).toFixed(1)}`).join('') : '';
  const id = `ag${Math.round(Math.random() * 1e9)}`;
  const nearLevel = (v: number) => level !== undefined && Number.isFinite(level) && Math.abs(y(v) - y(level)) < 11;
  return (
    <div className="pro-chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" style={{ height: H }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ff7a1a" stopOpacity="0.95" />
            <stop offset="55%" stopColor="#c0508a" stopOpacity="0.55" />
            <stop offset="100%" stopColor="#1e6bff" stopOpacity="0.35" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={0} x2={W - 52} y1={y(hi * f)} y2={y(hi * f)} className="pro-grid" />
            {!nearLevel(hi * f) && (
              <text x={W - 48} y={y(hi * f) + 3} className="pro-tick">
                {format(hi * f)}
              </text>
            )}
          </g>
        ))}
        <path d={area} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="#ff9a3a" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
        {fc && <path d={fc} fill="none" stroke="var(--pro-head, #ffd200)" strokeWidth={1.6} strokeDasharray="4 3" vectorEffect="non-scaling-stroke" />}
        {level !== undefined && Number.isFinite(level) && (
          <>
            <line x1={0} x2={W - 52} y1={y(level)} y2={y(level)} className="pro-split" />
            <text x={W - 48} y={y(level) + 3} className="pro-tick">
              {format(level)}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}
