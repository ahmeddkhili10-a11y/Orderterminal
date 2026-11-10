// The volatility and candle-forecasting screens:
//
//   GV    GARCH volatility — each coin's fitted GARCH model, a heat calendar of
//         forecast volatility for the coming hours (the coin's hour-of-day
//         pattern on top of GARCH's mean reversion), and the conditional
//         volatility with its forecast
//   FCST  Candle forecast — the next candle as a ghost (its odds of closing up,
//         its expected high and low), how good the models have been out of
//         sample, and which inputs matter
import { useEffect, useMemo, useState } from 'react';
import { fmtPrice } from '../core/format';
import type { Kline, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { candleForecast, type CandleReport } from '../lab/candles';
import { fitModel, forecastPath, garchVar, horizonVol, hourProfile, newsImpact, valueAtRisk, type GarchFit } from '../lab/garch';
import { useSettings } from '../store/settings';
import { Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { AreaChart, Bars, LineChart, useChartWidth } from './charts';
import { USES } from './botUses';
import { UseInBot } from './UseInBot';
import { BOARD_VENUES, useBoardVenue, useKlines } from './data';

const venueOpts = () => [{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))];
const pct = (x: number, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');

interface CoinVol {
  coin: string;
  fit: GarchFit;
  /** annualised conditional volatility of each bar */
  sigAnn: number[];
  /** annualised forecast for each of the next hours, with the hour-of-day pattern */
  hours: { t: number; ann: number; ratio: number }[];
  nowAnn: number;
  longAnn: number;
  dayAnn: number;
  weekAnn: number;
  var99: number;
}

function analyse(coin: string, k: Kline[], ahead: number, model: GarchConfig['model'] = 'best'): CoinVol | null {
  if (k.length < 300) return null;
  const lr = k.slice(1).map((x, i) => Math.log(x.close / k[i].close));
  const fit = fitModel(lr, model === 'best' ? undefined : model);
  if (!fit) return null;
  const bpy = 24 * 365;
  const h = garchVar(fit, lr);
  const last = lr[lr.length - 1] - fit.mu;
  const h1 = fit.omega + (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last + fit.beta * h[h.length - 1];
  const prof = hourProfile(
    k.slice(1).map((x) => x.time),
    lr,
  );
  const path = forecastPath(fit, h1, ahead);
  const t0 = k[k.length - 1].time + 3_600_000;
  const longAnn = Math.sqrt(fit.longRun * bpy);
  return {
    coin,
    fit,
    sigAnn: Array.from(h, (v) => Math.sqrt(v * bpy)),
    hours: path.map((v, i) => {
      const t = t0 + i * 3_600_000;
      const ann = Math.sqrt(v * (prof[new Date(t).getUTCHours()] || 1) * bpy);
      return { t, ann, ratio: ann / longAnn };
    }),
    nowAnn: Math.sqrt(h1 * bpy),
    longAnn,
    dayAnn: (horizonVol(fit, h1, 24) * Math.sqrt(bpy)) / Math.sqrt(24),
    weekAnn: (horizonVol(fit, h1, 168) * Math.sqrt(bpy)) / Math.sqrt(168),
    var99: valueAtRisk(fit, h1, 24, 0.99),
  };
}

/** blue calm, orange and red hot, yellow extreme — relative to the coin's own long-run volatility */
const heat = (r: number) => (!Number.isFinite(r) ? 'h-none' : r < 0.75 ? 'h-0' : r < 0.95 ? 'h-1' : r < 1.15 ? 'h-2' : r < 1.4 ? 'h-3' : r < 1.8 ? 'h-4' : 'h-5');

export interface GarchConfig {
  venue: VenueId | 'auto';
  coins: string;
  ahead: number;
  /** best of all four by BIC, or force plain GARCH or GJR-GARCH (the leverage effect) */
  model?: 'best' | 'garch' | 'gjr';
}
export const GARCH_DEFAULTS: GarchConfig = { venue: 'auto', coins: 'BTC ETH SOL BNB XRP DOGE AVAX LINK ADA SUI', ahead: 48, model: 'best' };

export function GarchPanel({ config: c, setConfig }: PanelProps<GarchConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const coins = c.coins.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 14);
  const k = useKlines(venue, coins, '1h', 1000);
  const [text, setText] = useState(c.coins);
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => coins.map((b) => (k.data[b] ? analyse(b, k.data[b], c.ahead, c.model ?? 'best') : null)).filter(Boolean) as CoinVol[], [k.data, c.ahead, c.model, coins.join()]);
  const pick = rows.find((r) => r.coin === sel) ?? rows[0];
  const hours = rows[0]?.hours ?? [];
  return (
    <div className="pro-panel">
      <Toolbar>
        <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => setConfig({ coins: text })} style={{ width: 220 }} title="Coins, separated by spaces" />
        <Select value={c.ahead} options={[24, 48, 72].map((n) => ({ value: n, label: `next ${n} h` }))} onChange={(ahead) => setConfig({ ahead })} />
        <Select
          value={c.model ?? 'best'}
          options={[
            { value: 'best' as const, label: 'best model (BIC)' },
            { value: 'gjr' as const, label: 'GJR-GARCH' },
            { value: 'garch' as const, label: 'GARCH' },
          ]}
          onChange={(model) => setConfig({ model })}
        />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="GV" options={USES.garch()} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'fitting…' : `${(c.model ?? 'best') === 'best' ? 'GARCH / GJR-GARCH · normal or t · best by BIC' : (c.model === 'gjr' ? 'GJR-GARCH' : 'GARCH') + ' · normal or t by BIC'} · 1000 hourly bars`}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rows.length ? (
          <div className="pro-empty">{k.loading ? 'Loading candles and fitting the models…' : 'Not enough candles for these coins on this venue (300+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">FORECAST VOLATILITY — NEXT {c.ahead} HOURS (UTC), AGAINST EACH COIN'S LONG RUN</div>
            <div className="gv-cal" style={{ gridTemplateColumns: `64px repeat(${hours.length}, minmax(9px, 1fr))` }}>
              <span />
              {hours.map((h, i) => (
                <span key={h.t} className="gv-hh">
                  {i % 3 === 0 ? String(new Date(h.t).getUTCHours()).padStart(2, '0') : ''}
                </span>
              ))}
              {rows.map((r) => (
                <div key={r.coin} className="gv-row" style={{ display: 'contents' }}>
                  <button className={`gv-coin${pick?.coin === r.coin ? ' on' : ''}`} onClick={() => setSel(r.coin)}>
                    {r.coin}
                  </button>
                  {r.hours.map((h) => (
                    <i key={h.t} className={`gv-cell ${heat(h.ratio)}`} title={`${r.coin} ${new Date(h.t).toISOString().slice(5, 16).replace('T', ' ')} UTC — ${pct(h.ann)} a year (${h.ratio.toFixed(2)}× long run)`} />
                  ))}
                </div>
              ))}
            </div>
            <div className="gv-legend mono">
              <i className="gv-cell h-0" /> calm &lt;0.75× <i className="gv-cell h-1" /> <i className="gv-cell h-2" /> normal <i className="gv-cell h-3" /> <i className="gv-cell h-4" /> hot <i className="gv-cell h-5" /> extreme &gt;1.8× long run
            </div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th className="l">MODEL</th>
                  <th>α</th>
                  <th>β</th>
                  <th title="Asymmetry: extra response to falls (GJR)">γ</th>
                  <th title="Student-t degrees of freedom: lower = fatter tails">ν</th>
                  <th title="α + β + γ/2: how long shocks last">PERSIST</th>
                  <th title="Hours for a volatility shock to halve">HALF-LIFE</th>
                  <th>σ NOW</th>
                  <th>LONG RUN</th>
                  <th>1 DAY</th>
                  <th>7 DAYS</th>
                  <th title="Value at risk, 1 day, 99 %">VaR 99</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setSel(r.coin)}>
                    <td className="l b">{r.coin}</td>
                    <td className="l muted">
                      {r.fit.kind === 'gjr' ? 'GJR' : 'GARCH'}-{r.fit.dist === 't' && r.fit.nu < 100 ? 't' : 'n'}
                    </td>
                    <td className="mono">{r.fit.alpha.toFixed(3)}</td>
                    <td className="mono">{r.fit.beta.toFixed(3)}</td>
                    <td className="mono">{r.fit.kind === 'gjr' ? r.fit.gamma.toFixed(3) : '—'}</td>
                    <td className="mono">{Number.isFinite(r.fit.nu) && r.fit.nu < 100 ? r.fit.nu.toFixed(1) : '∞'}</td>
                    <td className="mono">{r.fit.persistence.toFixed(3)}</td>
                    <td className="mono">{Number.isFinite(r.fit.halfLife) ? `${r.fit.halfLife.toFixed(0)}h` : '∞'}</td>
                    <td className={`mono ${r.nowAnn > r.longAnn * 1.15 ? 'down' : r.nowAnn < r.longAnn * 0.85 ? 'up' : ''}`}>{pct(r.nowAnn)}</td>
                    <td className="mono muted">{pct(r.longAnn)}</td>
                    <td className="mono">{pct(r.dayAnn)}</td>
                    <td className="mono">{pct(r.weekAnn)}</td>
                    <td className="mono down">{pct(r.var99, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pick && (
              <>
                <div className="pro-section">
                  {pick.coin} — CONDITIONAL VOLATILITY (ANNUALISED), FORECAST DASHED, LONG RUN RULED
                </div>
                <AreaChart values={pick.sigAnn.slice(-500)} forecast={pick.hours.map((h) => h.ann)} level={pick.longAnn} format={(v) => `${(v * 100).toFixed(0)}%`} />
                <div className="pro-section">
                  {pick.coin} — NEWS-IMPACT CURVE: NEXT HOUR'S VOLATILITY AFTER A SHOCK OF −5 TO +5 σ ({pick.fit.kind === 'gjr' ? `GJR: falls add γ = ${pick.fit.gamma.toFixed(3)}` : 'symmetric GARCH'})
                </div>
                <LineChart
                  log={false}
                  height={130}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  series={[
                    { values: Array.from({ length: 41 }, (_, i) => Math.sqrt(newsImpact(pick.fit, ((i - 20) / 4) * Math.sqrt(pick.fit.longRun)) * 24 * 365)), color: 'var(--pro-head, #ffd200)', width: 1.8 },
                    { values: Array.from({ length: 41 }, () => pick.longAnn), color: 'var(--muted)', width: 1, dash: '3 3' },
                  ]}
                  labels={
                    <>
                      left: a fall, right: a rise, middle: no news · <span className="muted">dashed: the long run</span> — an asymmetric curve is the leverage effect (Engle & Ng 1993; Glosten, Jagannathan & Runkle 1993)
                    </>
                  }
                />
                <div className="lab-line muted">
                  GARCH forecasts revert to the long run at the speed of the persistence ({pick.fit.persistence.toFixed(3)} an hour: half of a shock is gone in about {Number.isFinite(pick.fit.halfLife) ? `${pick.fit.halfLife.toFixed(0)} hours` : 'forever'}). The hour-of-day pattern rides on top. Feeds the Strategy Lab: GARCH volatility is an input to every learned model and the meta-labeller, scales the volatility-adjusted momentum rule, sets GARCH stops, gates the GARCH regime filter, and drives the simulated worlds every leading strategy must beat.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------- FCST ----------

export interface ForecastConfig {
  venue: VenueId | 'auto';
  interval: '1h' | '4h' | '1d';
}
export const FCST_DEFAULTS: ForecastConfig = { venue: 'auto', interval: '1h' };

function CandleChart({ bars, next }: { bars: Kline[]; next: CandleReport['next'] }) {
  const [ref, W] = useChartWidth();
  const H = 260;
  const show = bars.slice(-48);
  const all = [...show.flatMap((b) => [b.high, b.low]), ...(next ? [next.high, next.low] : [])];
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const n = show.length + 2;
  const cw = (W - 60) / n;
  const y = (v: number) => 8 + (1 - (v - lo) / (hi - lo || 1)) * (H - 20);
  const candle = (b: { open: number; high: number; low: number; close: number }, i: number, ghost = false) => {
    const up = b.close >= b.open;
    const x = i * cw + cw / 2;
    return (
      <g key={i} className={`fc-candle ${up ? 'up' : 'down'}${ghost ? ' ghost' : ''}`}>
        <line x1={x} x2={x} y1={y(b.high)} y2={y(b.low)} />
        <rect x={x - cw * 0.35} width={cw * 0.7} y={y(Math.max(b.open, b.close))} height={Math.max(1, Math.abs(y(b.open) - y(b.close)))} />
      </g>
    );
  };
  return (
    <div className="pro-chart" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" style={{ height: H }}>
        {[lo, (lo + hi) / 2, hi].map((v, i) => (
          <g key={i}>
            <line x1={0} x2={W - 60} y1={y(v)} y2={y(v)} className="pro-grid" />
            <text x={W - 56} y={y(v) + 3} className="pro-tick">
              {fmtPrice(v)}
            </text>
          </g>
        ))}
        {show.map((b, i) => candle(b, i))}
        {next && (
          <>
            <rect x={show.length * cw} width={cw * 2} y={y(next.high)} height={Math.max(1, y(next.low) - y(next.high))} className="fc-band" />
            {candle(next, show.length + 0.5, true)}
          </>
        )}
      </svg>
    </div>
  );
}

export function CandleForecastPanel({ config: c, setConfig }: PanelProps<ForecastConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const base = useSettings((s) => s.base);
  const k = useKlines(venue, [base], c.interval, 1000);
  const bars = k.data[base] ?? [];
  const [rep, setRep] = useState<CandleReport | null>(null);
  const [busy, setBusy] = useState(false);
  const tfH = c.interval === '1h' ? 1 : c.interval === '4h' ? 4 : 24;
  useEffect(() => {
    if (bars.length < 400) {
      setRep(null);
      return;
    }
    setBusy(true);
    // fit after the frame is drawn (a forest and a permutation test take a moment)
    const t = setTimeout(() => {
      try {
        setRep(candleForecast({ coin: base, tfH, bars: bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })), funding: null }));
      } catch {
        setRep(null);
      }
      setBusy(false);
    }, 30);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars.length, bars[bars.length - 1]?.time, base, tfH]);
  const e = rep?.eval;
  const nx = rep?.next;
  const imp = e ? [...e.importance].sort((a, b) => b.dir - a.dir).slice(0, 8) : [];
  const impR = e ? [...e.importance].sort((a, b) => b.range - a.range).slice(0, 8) : [];
  return (
    <div className="pro-panel">
      <Toolbar>
        <b className="pro-title">{base} — next candle</b>
        <Select value={c.interval} options={[{ value: '1h', label: '1 hour' }, { value: '4h', label: '4 hours' }, { value: '1d', label: '1 day' }]} onChange={(interval) => setConfig({ interval })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="FCST" options={USES.candle()} />
        <Spacer />
        <span className="pro-status">{busy || k.loading ? 'fitting…' : 'forest + ridge on candle shapes, GARCH, momentum · 70/30 split'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rep ? (
          <div className="pro-empty">{k.loading || busy ? 'Loading candles and fitting the models…' : 'Not enough candles (400+ needed).'}</div>
        ) : (
          <>
            <div className="fc-head">
              <CandleChart bars={bars} next={nx ?? null} />
              {nx && (
                <div className="fc-numbers">
                  <div className={`fc-odds ${nx.pUp >= 0.5 ? 'up' : 'down'}`}>
                    <small>P(NEXT CANDLE CLOSES UP)</small>
                    <b className="mono">{pct(nx.pUp)}</b>
                  </div>
                  <table className="pro-table compact">
                    <tbody>
                      <tr>
                        <td className="l">Opens</td>
                        <td className="mono">{fmtPrice(nx.open)}</td>
                      </tr>
                      <tr>
                        <td className="l">Expected high</td>
                        <td className="mono up">{fmtPrice(nx.high)}</td>
                      </tr>
                      <tr>
                        <td className="l">Expected low</td>
                        <td className="mono down">{fmtPrice(nx.low)}</td>
                      </tr>
                      <tr>
                        <td className="l">Central close</td>
                        <td className="mono">{fmtPrice(nx.close)}</td>
                      </tr>
                      <tr>
                        <td className="l">GARCH σ (next bar)</td>
                        <td className="mono">{pct(nx.sigma, 2)}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {e && (
              <>
                <div className="pro-section">HOW GOOD IT HAS BEEN — {e.n} CANDLES IT NEVER SAW</div>
                <div className="lab-kv mono">
                  <span>direction right {pct(e.hit, 1)} (base rate {pct(e.base, 1)})</span>
                  <span className={e.skill > 0 ? 'up' : 'down'}>Brier skill {(e.skill * 100).toFixed(1)}%</span>
                  <span>
                    range error: model {(e.rangeMae.model * 100).toFixed(3)}% · GARCH {(e.rangeMae.garch * 100).toFixed(3)}% · last candle {(e.rangeMae.naive * 100).toFixed(3)}%
                  </span>
                </div>
                <div className="lab-line muted">
                  {e.skill <= 0.005
                    ? 'The direction of the next candle is close to a coin toss here — as most research finds. The range is where forecasting pays: volatility clusters, so how far the next candle reaches is predictable.'
                    : 'The direction model beats the base rate here; treat it as a tilt, not a certainty.'}{' '}
                  {e.rangeMae.model < e.rangeMae.naive ? `The range model is ${((1 - e.rangeMae.model / e.rangeMae.naive) * 100).toFixed(0)}% closer than last candle's range.` : ''}
                </div>
                <div className="lab-grid2">
                  <div>
                    <div className="pro-section">WHAT MATTERS FOR DIRECTION (rise in Brier when shuffled)</div>
                    <Bars rows={imp.map((r) => ({ label: r.feature, value: r.dir, tone: r.dir > 0 ? 'up' : 'down' }))} format={(v) => v.toExponential(1)} />
                  </div>
                  <div>
                    <div className="pro-section">WHAT MATTERS FOR THE RANGE (rise in error when shuffled)</div>
                    <Bars rows={impR.map((r) => ({ label: r.feature, value: r.range, tone: r.range > 0 ? 'up' : 'down' }))} format={(v) => `${(v * 1e4).toFixed(2)}bp`} />
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
