// The QUANT desk (F4): quantitative-finance tools that open beside any
// instrument, each a window or a table:
//
//   VAR   value at risk and expected shortfall — five methods, any horizon,
//         a portfolio line, and each method backtested (Kupiec, Christoffersen)
//   DHG   delta hedging — Black–Scholes greeks for an option on the coin, the
//         hedge to hold, a strike ladder, and a delta-hedging backtest by
//         hedge frequency (the volatility risk premium in money)
//   VTGT  volatility targeting and sizing — five range estimators, EWMA and
//         GARCH, the position each implies, a vol-targeted buy-and-hold
//         against plain buy-and-hold, and a Kelly calculator
//   MOM   momentum — time-series momentum over a week to six months, scaled
//         by volatility, trend t-statistics, the Kalman slope, a composite
//         signal and the cross-sectional rank
//   REGM  regimes — Hurst exponent, variance ratio, Ornstein–Uhlenbeck
//         half-life and s-score, and a two-state hidden Markov model
//
// The same models feed the Strategy Lab (rules, filters, features, sizing).
import { useMemo, useState } from 'react';
import { fmtPrice } from '../core/format';
import type { Kline, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { fitModel, garchVar, horizonVol, valueAtRisk, type GarchFit } from '../lab/garch';
import {
  blackScholes,
  deltaHedge,
  fitHmm2,
  hmmDuration,
  hmmFilter,
  hurstRS,
  kalmanTrend,
  kellyBet,
  moments4,
  ouRolling,
  trendT,
  VAR_METHODS,
  varBacktest,
  varCornishFisher,
  varForecasts,
  varGarch,
  varHistorical,
  varianceRatio,
  varNormal,
  volEstimate,
  VOL_KINDS,
  type OptType,
  type VarMethod,
  type VarResult,
} from '../lab/quant';
import { useSettings } from '../store/settings';
import { NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { AreaChart, Bars, LineChart } from './charts';
import { alignedReturns, BOARD_VENUES, useBoardVenue, useKlines } from './data';

const venueOpts = () => [{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))];
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const usd = (x: number) => (Number.isFinite(x) ? `${x < 0 ? '−' : ''}$${Math.abs(Math.round(x)).toLocaleString('en-US')}` : '—');
const coinsOf = (s: string) => s.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 12);
const logR = (k: Kline[]) => k.slice(1).map((x, i) => Math.log(x.close / k[i].close));
const HOURS_A_YEAR = 24 * 365;
const DEFAULT_COINS = 'BTC ETH SOL BNB XRP DOGE AVAX LINK';

/** overlapping h-bar sums */
const agg = (r: number[], h: number) => {
  if (h <= 1) return r;
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < r.length; i++) {
    s += r[i];
    if (i >= h) s -= r[i - h];
    if (i >= h - 1) out.push(s);
  }
  return out;
};

function CoinsInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  return <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && onCommit(text)} style={{ width: 200 }} title="Coins, separated by spaces" />;
}

function useVenue(v: VenueId | 'auto') {
  const board = useBoardVenue();
  return v === 'auto' ? board : v;
}

// ======================================================================
// VAR — value at risk and expected shortfall
// ======================================================================

export interface VarConfig {
  venue: VenueId | 'auto';
  coins: string;
  conf: number;
  horizon: number;
  position: number;
}
export const VAR_DEFAULTS: VarConfig = { venue: 'auto', coins: DEFAULT_COINS, conf: 0.99, horizon: 24, position: 10000 };

interface CoinVar {
  coin: string;
  r: number[];
  fit: GarchFit | null;
  by: Record<VarMethod, VarResult>;
}

function coinVar(coin: string, k: Kline[], conf: number, h: number): CoinVar | null {
  if (k.length < 300) return null;
  const r = logR(k);
  const fit = fitModel(r);
  const a = agg(r, h);
  const m1 = moments4(r);
  const ma = moments4(a);
  let ew = NaN;
  for (const x of r) ew = Number.isFinite(ew) ? 0.94 * ew + 0.06 * x * x : x * x;
  const z = varNormal(0, 1, conf);
  const by = {
    historical: varHistorical(a, conf),
    normal: varNormal(m1.m * h, m1.s * Math.sqrt(h), conf),
    cornishFisher: varCornishFisher(ma.m, ma.s, ma.skew, ma.kurt, conf),
    ewma: { var: z.var * Math.sqrt(ew * h), es: z.es * Math.sqrt(ew * h) },
    garch: { var: NaN, es: NaN },
  } as Record<VarMethod, VarResult>;
  if (fit) {
    const hv = garchVar(fit, r);
    const last = r[r.length - 1] - fit.mu;
    const h1 = fit.omega + (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last + fit.beta * hv[hv.length - 1];
    const one = varGarch(fit, h1, conf);
    const v = valueAtRisk(fit, h1, h, conf);
    by.garch = { var: v, es: one.var > 0 ? (v * one.es) / one.var : v };
  }
  return { coin, r, fit, by };
}

export function VarPanel({ config: c, setConfig }: PanelProps<VarConfig>) {
  const venue = useVenue(c.venue);
  const base = useSettings((s) => s.base);
  const coins = coinsOf(c.coins);
  const k = useKlines(venue, coins, '1h', 1000);
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => coins.map((b) => (k.data[b] ? coinVar(b, k.data[b], c.conf, c.horizon) : null)).filter((x): x is CoinVar => !!x), [k.data, c.conf, c.horizon, coins.join()]);
  const pick = rows.find((r) => r.coin === sel) ?? rows.find((r) => r.coin === base) ?? rows[0];
  // the equal-weight portfolio of the coins
  const port = useMemo(() => {
    const al = alignedReturns(Object.fromEntries(rows.map((r) => [r.coin, k.data[r.coin]])));
    if (al.bases.length < 2) return null;
    const pr = al.rets[0].map((_, t) => al.rets.reduce((s, x) => s + x[t], 0) / al.rets.length);
    const a = agg(pr, c.horizon);
    const mm = moments4(a);
    return { hist: varHistorical(a, c.conf), cf: varCornishFisher(mm.m, mm.s, mm.skew, mm.kurt, c.conf), n: al.bases.length };
  }, [rows, c.horizon, c.conf]);
  // each method's one-hour forecasts over the last 500 hours, against what happened
  const bt = useMemo(() => {
    if (!pick) return [];
    const n = pick.r.length;
    const from = Math.max(300, n - 500);
    return VAR_METHODS.map((m) => {
      const f = varForecasts(pick.r, from, c.conf, m.id, 300, pick.fit);
      return { m, f, t: varBacktest(pick.r.slice(from), Array.from(f.slice(from)), c.conf) };
    });
  }, [pick, c.conf]);
  const best = bt.filter((x) => x.t).sort((a, b) => b.t!.ccP - a.t!.ccP)[0];
  const hz = c.horizon === 1 ? '1 hour' : c.horizon === 24 ? '1 day' : '1 week';
  const sumStand = port ? rows.reduce((s, r) => s + r.by.historical.var, 0) / rows.length : NaN;
  return (
    <div className="pro-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <Select value={c.conf} options={[0.95, 0.99, 0.995].map((v) => ({ value: v, label: `${(v * 100).toFixed(1).replace('.0', '')} %` }))} onChange={(conf) => setConfig({ conf })} />
        <Select value={c.horizon} options={[1, 24, 168].map((v) => ({ value: v, label: v === 1 ? '1 hour' : v === 24 ? '1 day' : '1 week' }))} onChange={(horizon) => setConfig({ horizon })} />
        <NumberInput value={c.position} step={1000} min={100} width={90} onChange={(position) => setConfig({ position })} title="Position size in dollars" suffix="$" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : `1000 hourly bars · loss over ${hz} not exceeded ${(c.conf * 100).toFixed(1).replace('.0', '')} % of the time`}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rows.length ? (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : 'Not enough candles for these coins (300+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">
              VALUE AT RISK, {hz.toUpperCase()} — % OF THE POSITION, AND IN DOLLARS ON {usd(c.position)} (EXPECTED SHORTFALL ON HOVER)
            </div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  {VAR_METHODS.map((m) => (
                    <th key={m.id}>{m.name.toUpperCase()}</th>
                  ))}
                  <th title="Expected shortfall (GARCH): the mean loss on the days worse than the VaR">ES (GARCH)</th>
                  <th>$ VaR (GARCH)</th>
                  <th className="l">MODEL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setSel(r.coin)}>
                    <td className="l b">{r.coin}</td>
                    {VAR_METHODS.map((m) => (
                      <td key={m.id} className="mono" title={`expected shortfall ${pct(r.by[m.id].es, 2)}`}>
                        {pct(r.by[m.id].var, 2)}
                      </td>
                    ))}
                    <td className="mono down">{pct(r.by.garch.es, 2)}</td>
                    <td className="mono down">{usd(r.by.garch.var * c.position)}</td>
                    <td className="l muted">{r.fit ? `${r.fit.kind === 'gjr' ? 'GJR' : 'GARCH'}-${r.fit.dist === 't' && r.fit.nu < 100 ? `t(${r.fit.nu.toFixed(1)})` : 'n'}` : '—'}</td>
                  </tr>
                ))}
                {port && (
                  <tr className="q-total">
                    <td className="l b">EQUAL-WEIGHT</td>
                    <td className="mono">{pct(port.hist.var, 2)}</td>
                    <td className="mono muted">—</td>
                    <td className="mono">{pct(port.cf.var, 2)}</td>
                    <td className="mono muted">—</td>
                    <td className="mono muted">—</td>
                    <td className="mono">{pct(port.hist.es, 2)}</td>
                    <td className="mono down">{usd(port.hist.var * c.position)}</td>
                    <td className="l muted" title="The average stand-alone historical VaR against the portfolio's: what spreading the position over the coins saves">
                      diversification saves {pct(sumStand - port.hist.var, 2)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {pick && (
              <>
                <div className="pro-section">{pick.coin} — EACH METHOD'S 1-HOUR VaR FORECASTS OVER THE LAST 500 HOURS, AGAINST WHAT HAPPENED</div>
                <table className="pro-table compact">
                  <thead>
                    <tr>
                      <th className="l">METHOD</th>
                      <th>BREACHES</th>
                      <th>EXPECTED</th>
                      <th title="Kupiec (1995): is the number of breaches right? Below 5 % rejects the model.">KUPIEC p</th>
                      <th title="Christoffersen (1998): do breaches cluster? Below 5 % rejects.">CLUSTERING p</th>
                      <th title="Both together">COVERAGE p</th>
                      <th className="l">VERDICT</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bt.map(({ m, t }) => (
                      <tr key={m.id}>
                        <td className="l b">{m.name}</td>
                        <td className="mono">{t ? t.breaches : '—'}</td>
                        <td className="mono muted">{t ? t.expected.toFixed(1) : '—'}</td>
                        <td className={`mono ${t && t.kupiecP < 0.05 ? 'down' : 'up'}`}>{t ? num(t.kupiecP, 3) : '—'}</td>
                        <td className={`mono ${t && t.indP < 0.05 ? 'down' : 'up'}`}>{t ? num(t.indP, 3) : '—'}</td>
                        <td className={`mono ${t && t.ccP < 0.05 ? 'down' : 'up'}`}>{t ? num(t.ccP, 3) : '—'}</td>
                        <td className="l muted">{!t ? 'too little data' : t.ccP < 0.05 ? (t.breaches > t.expected ? 'rejected: under-states risk' : 'rejected') : best?.m.id === m.id ? 'passes — best calibrated' : 'passes'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {best && (
                  <LineChart
                    log={false}
                    height={150}
                    format={(v) => `${(v * 100).toFixed(1)}%`}
                    series={[
                      { values: pick.r.slice(-500), color: 'var(--muted)', width: 1 },
                      { values: Array.from(bt.find((x) => x.m.id === 'garch')?.f ?? best.f).slice(-500).map((v) => -v), color: 'var(--sell)', width: 1.4 },
                    ]}
                    labels={
                      <>
                        <span className="muted">hourly return</span> · <span className="down">−VaR (GARCH): a breach is a return below the red line</span>
                      </>
                    }
                  />
                )}
                <div className="lab-line muted">
                  Historical simulation reads the past losses directly; normal assumes a bell curve (it under-states crypto's tails); Cornish–Fisher bends the normal for skew and fat tails; EWMA is RiskMetrics' fast-moving volatility; GARCH forecasts the next hour's volatility from its clustering with the fitted tails. Expected shortfall — the mean loss beyond the VaR — is the coherent measure (Artzner et al. 1999). The Lab's VaR-budget sizing uses the GARCH figure.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// DHG — delta hedging an option on the coin
// ======================================================================

export interface DeltaConfig {
  venue: VenueId | 'auto';
  kind: OptType | 'straddle';
  side: 1 | -1;
  strike: number;
  days: number;
  vol: 'garch' | 'realised' | 'manual';
  iv: number;
  contracts: number;
}
export const DELTA_DEFAULTS: DeltaConfig = { venue: 'auto', kind: 'straddle', side: -1, strike: 100, days: 7, vol: 'garch', iv: 60, contracts: 1 };

export function DeltaHedgePanel({ config: c, setConfig }: PanelProps<DeltaConfig>) {
  const venue = useVenue(c.venue);
  const base = useSettings((s) => s.base);
  const k = useKlines(venue, [base], '1h', 1000);
  const bars = k.data[base] ?? [];
  const model = useMemo(() => {
    if (bars.length < 400) return null;
    const r = logR(bars);
    const fit = fitModel(r);
    return { r, fit, h: fit ? garchVar(fit, r) : null };
  }, [bars.length, bars[bars.length - 1]?.time]);
  const L = Math.max(24, Math.round(c.days * 24));
  const legs: OptType[] = c.kind === 'straddle' ? ['call', 'put'] : [c.kind];
  const volAt = (t: number): number => {
    if (!model) return NaN;
    if (c.vol === 'manual') return c.iv / 100;
    if (c.vol === 'realised') {
      const w = model.r.slice(Math.max(0, t - L), t);
      const m = moments4(w);
      return m.s * Math.sqrt(HOURS_A_YEAR);
    }
    if (!model.fit || !model.h) return NaN;
    const h1 = t < model.h.length ? model.h[t] : model.fit.longRun;
    return (horizonVol(model.fit, h1, L) / Math.sqrt(L)) * Math.sqrt(HOURS_A_YEAR);
  };
  const S = bars[bars.length - 1]?.close ?? NaN;
  const sigma = model ? volAt(model.r.length) : NaN;
  const T = c.days / 365;
  const K = (S * c.strike) / 100;
  const g = legs.map((t) => blackScholes(S, K, T, sigma, t)).reduce((a, x) => ({ price: a.price + x.price, delta: a.delta + x.delta, gamma: a.gamma + x.gamma, vega: a.vega + x.vega, theta: a.theta + x.theta }), { price: 0, delta: 0, gamma: 0, vega: 0, theta: 0 });
  const q = c.side * c.contracts;
  // the hedge backtest: start every day, price at the volatility of the moment, hedge at each frequency
  const sim = useMemo(() => {
    if (!model || bars.length < L + 200) return null;
    const closes = bars.map((b) => b.close);
    const freqs = [1, 4, 12, 24, L];
    const starts: number[] = [];
    for (let s = 200; s + L < closes.length; s += 24) starts.push(s);
    const out = freqs.map((f) => ({ f, finals: [] as number[], spread: [] as number[], last: [] as number[] }));
    for (const s of starts) {
      const iv = volAt(s);
      if (!Number.isFinite(iv)) continue;
      const px = closes.slice(s, s + L + 1);
      out.forEach((o, j) => {
        const run = deltaHedge(px, { strikePct: c.strike / 100, iv, kind: c.kind, side: c.side, every: freqs[j], barYears: 1 / HOURS_A_YEAR, costBps: 5 });
        if (!run) return;
        o.finals.push(run.final);
        o.spread.push(iv - run.realised);
        if (s === starts[starts.length - 1]) o.last = run.pnl;
      });
    }
    return { out, n: starts.length };
  }, [model, c.kind, c.side, c.strike, c.days, c.vol, c.iv]);
  const mean = (x: number[]) => (x.length ? x.reduce((a, b) => a + b, 0) / x.length : NaN);
  const sd = (x: number[]) => Math.sqrt(mean(x.map((v) => (v - mean(x)) ** 2)));
  const colors = ['var(--pro-head, #ffd200)', 'var(--buy)', '#4f8ff0', '#c0508a', 'var(--muted)'];
  return (
    <div className="pro-panel">
      <Toolbar>
        <b className="pro-title">{base} options — delta hedging</b>
        <Select value={c.side} options={[{ value: -1 as const, label: 'Sell' }, { value: 1 as const, label: 'Buy' }]} onChange={(side) => setConfig({ side })} />
        <Select value={c.kind} options={[{ value: 'straddle' as const, label: 'straddle' }, { value: 'call' as const, label: 'call' }, { value: 'put' as const, label: 'put' }]} onChange={(kind) => setConfig({ kind })} />
        <NumberInput value={c.strike} step={5} min={50} width={64} onChange={(strike) => setConfig({ strike })} title="Strike, % of spot" suffix="%" />
        <NumberInput value={c.days} step={1} min={1} width={56} onChange={(days) => setConfig({ days: Math.min(30, days) })} title="Days to expiry (at most 30)" suffix="d" />
        <Select value={c.vol} options={[{ value: 'garch' as const, label: 'priced at GARCH vol' }, { value: 'realised' as const, label: 'priced at realised vol' }, { value: 'manual' as const, label: 'priced at my vol' }]} onChange={(vol) => setConfig({ vol })} />
        {c.vol === 'manual' && <NumberInput value={c.iv} step={5} min={5} width={60} onChange={(iv) => setConfig({ iv })} title="Implied volatility, % a year (e.g. Deribit's, from OMON)" suffix="%" />}
        <NumberInput value={c.contracts} step={1} min={0.01} width={60} onChange={(contracts) => setConfig({ contracts })} title="Contracts (1 = one coin)" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
      </Toolbar>
      <div className="pro-scroll">
        {!model || !Number.isFinite(S) ? (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : 'Not enough candles (400+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">
              {c.side < 0 ? 'SHORT' : 'LONG'} {c.contracts} × {c.days}-DAY {c.strike}% {c.kind.toUpperCase()} ON {base} AT {fmtPrice(S)} — VOLATILITY {pct(sigma, 1)} A YEAR ({c.vol === 'garch' ? 'GARCH forecast over the life' : c.vol === 'realised' ? `realised, last ${c.days} days` : 'yours'})
            </div>
            <div className="lab-kv mono">
              <span>premium {usd(g.price * c.contracts)} ({pct(g.price / S, 2)} of spot)</span>
              <span>delta {num(q * g.delta, 3)} {base}</span>
              <span>gamma per 1 % move {num(q * g.gamma * S * 0.01, 4)} {base}</span>
              <span>vega {usd((q * g.vega) / 100)} per vol point</span>
              <span>theta {usd((q * g.theta) / 365)} a day</span>
            </div>
            <div className="dh-hedge">
              To be delta-neutral now: <b className={q * g.delta > 0 ? 'down' : 'up'}>{q * g.delta > 0 ? 'SELL' : 'BUY'} {num(Math.abs(q * g.delta), 4)} {base}</b> ({usd(Math.abs(q * g.delta) * S)}) on the perpetual, and rebalance as the delta moves — gamma says how fast.
            </div>
            <div className="pro-section">STRIKE LADDER — {c.days} DAYS, {pct(sigma, 1)} VOLATILITY</div>
            <table className="pro-table compact">
              <thead>
                <tr>
                  <th>STRIKE</th>
                  <th>CALL</th>
                  <th>CALL Δ</th>
                  <th>PUT</th>
                  <th>PUT Δ</th>
                  <th>Γ (1 %)</th>
                  <th>VEGA / PT</th>
                  <th>THETA / DAY</th>
                </tr>
              </thead>
              <tbody>
                {[0.8, 0.9, 0.95, 1, 1.05, 1.1, 1.2].map((m) => {
                  const cl = blackScholes(S, S * m, T, sigma, 'call');
                  const pu = blackScholes(S, S * m, T, sigma, 'put');
                  return (
                    <tr key={m} className={Math.abs(m * 100 - c.strike) < 0.5 ? 'sel' : ''} onClick={() => setConfig({ strike: Math.round(m * 100) })}>
                      <td className="mono b">{fmtPrice(S * m)} ({Math.round(m * 100)}%)</td>
                      <td className="mono">{fmtPrice(cl.price)}</td>
                      <td className="mono">{num(cl.delta, 3)}</td>
                      <td className="mono">{fmtPrice(pu.price)}</td>
                      <td className="mono">{num(pu.delta, 3)}</td>
                      <td className="mono">{num(cl.gamma * S * 0.01, 4)}</td>
                      <td className="mono">{usd(cl.vega / 100)}</td>
                      <td className="mono down">{usd(cl.theta / 365)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {sim && (
              <>
                <div className="pro-section">
                  BACKTEST — {c.side < 0 ? 'SELLING' : 'BUYING'} THIS OPTION EVERY DAY OVER THE LAST {Math.round(bars.length / 24)} DAYS ({sim.n} RUNS), DELTA-HEDGED, 5 bp A TRADE
                </div>
                <table className="pro-table compact">
                  <thead>
                    <tr>
                      <th className="l">HEDGE</th>
                      <th title="P&L of the hedged book at expiry, % of spot">MEAN P&L</th>
                      <th>SPREAD (SD)</th>
                      <th>WORST</th>
                      <th>PROFITABLE</th>
                      <th title="Volatility priced minus volatility realised: positive means the option was dear">PRICED − REALISED VOL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sim.out.map((o) => (
                      <tr key={o.f}>
                        <td className="l b">{o.f === L ? 'never (static at inception)' : `every ${o.f} h`}</td>
                        <td className={`mono ${mean(o.finals) > 0 ? 'up' : 'down'}`}>{pct(mean(o.finals), 2)}</td>
                        <td className="mono">{pct(sd(o.finals), 2)}</td>
                        <td className="mono down">{pct(Math.min(...o.finals), 2)}</td>
                        <td className="mono">{pct(o.finals.filter((x) => x > 0).length / Math.max(1, o.finals.length), 0)}</td>
                        <td className="mono">{pct(mean(o.spread), 1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <LineChart
                  log={false}
                  height={150}
                  format={(v) => `${(v * 100).toFixed(1)}%`}
                  series={sim.out.map((o, j) => ({ values: o.last, color: colors[j], width: j === 0 ? 1.6 : 1.1 }))}
                  labels={
                    <>
                      the latest run's P&L by hedge frequency:{' '}
                      {sim.out.map((o, j) => (
                        <span key={o.f} style={{ color: colors[j], marginRight: 8 }}>
                          {o.f === L ? 'static' : `${o.f} h`}
                        </span>
                      ))}
                    </>
                  }
                />
                <div className="lab-line muted">
                  A delta-hedged option earns its holder about ½·Γ·S²·(realised² − priced²) over its life: hedging removes the direction and leaves a bet on volatility (Black & Scholes 1973). Selling pays when the volatility you sold above is not realised — the variance risk premium (Carr & Wu 2009). Hedging more often cuts the spread of outcomes, not the average; costs eat into it. The tradable price is the exchange's implied volatility (OMON shows Deribit's): price at "my vol" with it to test that trade.
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// VTGT — volatility targeting and sizing
// ======================================================================

export interface VolTargetConfig {
  venue: VenueId | 'auto';
  target: number;
  account: number;
  cap: number;
  win: number;
  payoff: number;
}
export const VTGT_DEFAULTS: VolTargetConfig = { venue: 'auto', target: 40, account: 10000, cap: 3, win: 45, payoff: 2 };

export function VolTargetPanel({ config: c, setConfig }: PanelProps<VolTargetConfig>) {
  const venue = useVenue(c.venue);
  const base = useSettings((s) => s.base);
  const k = useKlines(venue, [base], '1h', 1000);
  const bars = k.data[base] ?? [];
  const tgt = c.target / 100;
  const res = useMemo(() => {
    if (bars.length < 400) return null;
    const r = logR(bars);
    const fit = fitModel(r);
    const h = fit ? garchVar(fit, r) : null;
    const ann = (x: number) => x * Math.sqrt(HOURS_A_YEAR);
    const est = VOL_KINDS.map((v) => ({ id: v.id, name: v.name, cite: v.cite, day: ann(volEstimate(bars, 24, v.id)[bars.length - 1]), week: ann(volEstimate(bars, 168, v.id)[bars.length - 1]) }));
    let ew = NaN;
    for (const x of r) ew = Number.isFinite(ew) ? 0.94 * ew + 0.06 * x * x : x * x;
    let gNow = NaN;
    let gDay = NaN;
    if (fit && h) {
      const last = r[r.length - 1] - fit.mu;
      const h1 = fit.omega + (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last + fit.beta * h[h.length - 1];
      gNow = ann(Math.sqrt(h1));
      gDay = (horizonVol(fit, h1, 24) / Math.sqrt(24)) * Math.sqrt(HOURS_A_YEAR);
    }
    // buy-and-hold against the same position volatility-targeted on the GARCH forecast (rebalanced when the weight drifts 25 %)
    const bh = [1];
    const vt = [1];
    const wts: number[] = [];
    let w = NaN;
    for (let t = 1; t < r.length; t++) {
      const sig = h ? Math.sqrt(h[t]) : NaN;
      const want = sig > 0 ? Math.min(c.cap, tgt / Math.sqrt(HOURS_A_YEAR) / sig) : 1;
      let cost = 0;
      if (!Number.isFinite(w) || Math.abs(want - w) > 0.25 * w) {
        cost = Math.abs(want - (Number.isFinite(w) ? w : 0)) * 0.0005;
        w = want;
      }
      wts.push(w);
      bh.push(bh[bh.length - 1] * Math.exp(r[t]));
      vt.push(vt[vt.length - 1] * (1 + w * (Math.exp(r[t]) - 1) - cost));
    }
    const stats = (eq: number[]) => {
      const rr = eq.slice(1).map((x, i) => Math.log(x / eq[i]));
      const m = moments4(rr);
      let peak = eq[0];
      let dd = 0;
      for (const x of eq) {
        peak = Math.max(peak, x);
        dd = Math.max(dd, 1 - x / peak);
      }
      return { ret: Math.exp(m.m * HOURS_A_YEAR) - 1, vol: m.s * Math.sqrt(HOURS_A_YEAR), sharpe: m.s > 0 ? (m.m / m.s) * Math.sqrt(HOURS_A_YEAR) : NaN, dd };
    };
    return { est, ewma: ann(Math.sqrt(ew)), gNow, gDay, fit, bh, vt, sBh: stats(bh), sVt: stats(vt), avgW: wts.reduce((a, b) => a + b, 0) / Math.max(1, wts.length) };
  }, [bars.length, bars[bars.length - 1]?.time, c.target, c.cap]);
  const size = (vol: number) => {
    const lev = vol > 0 ? Math.min(c.cap, tgt / vol) : NaN;
    return { lev, notional: lev * c.account };
  };
  const kelly = kellyBet(c.win / 100, c.payoff, 1);
  return (
    <div className="pro-panel">
      <Toolbar>
        <b className="pro-title">{base} — volatility targeting & sizing</b>
        <NumberInput value={c.target} step={5} min={5} width={60} onChange={(target) => setConfig({ target })} title="Target volatility, % a year" suffix="%" />
        <NumberInput value={c.account} step={1000} min={100} width={90} onChange={(account) => setConfig({ account })} title="Account, dollars" suffix="$" />
        <NumberInput value={c.cap} step={0.5} min={0.5} width={56} onChange={(cap) => setConfig({ cap })} title="Leverage cap" suffix="×" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
      </Toolbar>
      <div className="pro-scroll">
        {!res ? (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : 'Not enough candles (400+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">VOLATILITY, ANNUALISED — AND THE POSITION THAT RUNS AT {c.target}% A YEAR ON {usd(c.account)}</div>
            <table className="pro-table compact">
              <thead>
                <tr>
                  <th className="l">ESTIMATOR</th>
                  <th>LAST DAY</th>
                  <th>LAST WEEK</th>
                  <th>POSITION (WEEK)</th>
                  <th>LEVERAGE</th>
                  <th className="l">SOURCE</th>
                </tr>
              </thead>
              <tbody>
                {res.est.map((e) => {
                  const z = size(e.week);
                  return (
                    <tr key={e.id}>
                      <td className="l b">{e.name}</td>
                      <td className="mono">{pct(e.day, 1)}</td>
                      <td className="mono">{pct(e.week, 1)}</td>
                      <td className="mono">{usd(z.notional)}</td>
                      <td className="mono">{num(z.lev, 2)}×</td>
                      <td className="l muted">{e.cite}</td>
                    </tr>
                  );
                })}
                <tr>
                  <td className="l b">EWMA (λ 0.94)</td>
                  <td className="mono" colSpan={2}>
                    {pct(res.ewma, 1)}
                  </td>
                  <td className="mono">{usd(size(res.ewma).notional)}</td>
                  <td className="mono">{num(size(res.ewma).lev, 2)}×</td>
                  <td className="l muted">RiskMetrics (1996)</td>
                </tr>
                <tr className="sel">
                  <td className="l b">GARCH forecast</td>
                  <td className="mono">{pct(res.gNow, 1)} next hour</td>
                  <td className="mono">{pct(res.gDay, 1)} next day</td>
                  <td className="mono">{usd(size(res.gDay).notional)}</td>
                  <td className="mono">{num(size(res.gDay).lev, 2)}×</td>
                  <td className="l muted">{res.fit ? `${res.fit.kind === 'gjr' ? 'GJR-GARCH' : 'GARCH'}(1,1) — what the Lab's volatility target uses` : '—'}</td>
                </tr>
              </tbody>
            </table>
            <div className="pro-section">BUY-AND-HOLD AGAINST THE SAME COIN VOLATILITY-TARGETED AT {c.target}% (GARCH, REBALANCED ON 25 % DRIFT, 5 bp)</div>
            <LineChart
              height={150}
              series={[
                { values: res.bh, color: 'var(--muted)', width: 1.1, dash: '3 2' },
                { values: res.vt, color: 'var(--pro-head, #ffd200)', width: 1.6 },
              ]}
              labels={
                <>
                  <span style={{ color: 'var(--pro-head, #ffd200)' }}>volatility-targeted</span> · <span className="muted">buy-and-hold</span>
                </>
              }
            />
            <table className="pro-table compact">
              <thead>
                <tr>
                  <th className="l"></th>
                  <th>RETURN (A YEAR)</th>
                  <th>VOLATILITY</th>
                  <th>SHARPE</th>
                  <th>MAX DRAWDOWN</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Buy-and-hold', res.sBh],
                  [`Vol-targeted (avg ${num(res.avgW, 2)}×)`, res.sVt],
                ].map(([n, s]) => {
                  const st = s as typeof res.sBh;
                  return (
                    <tr key={n as string}>
                      <td className="l b">{n as string}</td>
                      <td className={`mono ${st.ret > 0 ? 'up' : 'down'}`}>{pct(st.ret, 1)}</td>
                      <td className="mono">{pct(st.vol, 1)}</td>
                      <td className="mono">{num(st.sharpe)}</td>
                      <td className="mono down">{pct(st.dd, 1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="lab-line muted">
              Volatility clusters but does not predict returns, so running a position at constant volatility — less when the forecast is high — smooths it and usually lifts its Sharpe ratio (Moreira & Muir 2017; Harvey et al. 2018). Over a month and a half this is an illustration; the Strategy Lab tests volatility targeting on years. Model parameters here are fitted on the whole window.
            </div>
            <div className="pro-section">KELLY — HOW MUCH TO RISK A TRADE</div>
            <div className="q-kelly">
              <label>
                WIN RATE
                <NumberInput value={c.win} step={1} min={1} width={60} onChange={(win) => setConfig({ win: Math.min(99, win) })} suffix="%" />
              </label>
              <label>
                PAYOFF (R)
                <NumberInput value={c.payoff} step={0.1} min={0.1} width={60} onChange={(payoff) => setConfig({ payoff })} />
              </label>
              <span className="mono">
                Kelly {pct(kelly, 1)} · half Kelly <b>{pct(kelly / 2, 1)}</b> · quarter {pct(kelly / 4, 1)} of the account at risk a trade
                {kelly <= 0 ? ' — no edge: do not take it' : ''}
              </span>
            </div>
            <div className="lab-line muted">The growth-maximising bet (Kelly 1956) is ruinous if the edge is over-estimated; a half or a quarter of it gives up a little growth for far smaller drawdowns. The crypto swarm sizes with a quarter-Kelly multiplier on its own record.</div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// MOM — momentum monitor
// ======================================================================

export interface MomConfig {
  venue: VenueId | 'auto';
  coins: string;
}
export const MOM_DEFAULTS: MomConfig = { venue: 'auto', coins: DEFAULT_COINS };

interface MomRow {
  coin: string;
  closes: number[];
  level: number[];
  r: Record<'w' | 'm' | 'q' | 'h', number>;
  z: number;
  tt: number;
  kt: number;
  score: number;
  rank: number;
}

function momRow(coin: string, k: Kline[]): Omit<MomRow, 'rank'> | null {
  if (k.length < 60) return null;
  const closes = k.map((x) => x.close);
  const n = closes.length;
  const ret = (d: number) => (n > d ? closes[n - 1] / closes[n - 1 - d] - 1 : NaN);
  const lp = closes.map(Math.log);
  const lr = lp.slice(1).map((x, i) => x - lp[i]);
  const sd = moments4(lr.slice(-90)).s;
  const z = n > 30 && sd > 0 ? Math.log(closes[n - 1] / closes[n - 31]) / (sd * Math.sqrt(30)) : NaN;
  const tt = trendT(lp, Math.min(60, n - 1))[n - 1];
  const kf = kalmanTrend(lp, 1e-6 * 24 * 24, moments4(lr).s ** 2);
  const kt = kf.slopeSd[n - 1] > 0 ? kf.slope[n - 1] / kf.slopeSd[n - 1] : NaN;
  const sg = (x: number) => (Number.isFinite(x) ? Math.sign(x) : 0);
  const r = { w: ret(7), m: ret(30), q: ret(90), h: ret(180) };
  // time-series momentum over the horizons, and the Kalman trend: −1 all down … +1 all up
  const votes = [sg(r.w), sg(r.m), sg(r.q), Math.abs(kt) > 1 ? sg(kt) : 0];
  return { coin, closes, level: Array.from(kf.level, Math.exp), r, z, tt, kt, score: votes.reduce((a, b) => a + b, 0) / votes.length };
}

const heatCls = (x: number, s: number) => (!Number.isFinite(x) ? '' : x > 2 * s ? 'q-p3' : x > s ? 'q-p2' : x > 0 ? 'q-p1' : x < -2 * s ? 'q-n3' : x < -s ? 'q-n2' : 'q-n1');

export function MomentumPanel({ config: c, setConfig }: PanelProps<MomConfig>) {
  const venue = useVenue(c.venue);
  const base = useSettings((s) => s.base);
  const coins = coinsOf(c.coins);
  const k = useKlines(venue, coins, '1d', 400);
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => {
    const rs = coins.map((b) => (k.data[b] ? momRow(b, k.data[b]) : null)).filter((x): x is Omit<MomRow, 'rank'> => !!x);
    const order = [...rs].sort((a, b) => (Number.isFinite(b.z) ? b.z : -99) - (Number.isFinite(a.z) ? a.z : -99));
    return rs.map((r) => ({ ...r, rank: order.indexOf(r) + 1 })) as MomRow[];
  }, [k.data, coins.join()]);
  const pick = rows.find((r) => r.coin === sel) ?? rows.find((r) => r.coin === base) ?? rows[0];
  return (
    <div className="pro-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : 'daily candles · Moskowitz, Ooi & Pedersen (2012); Kalman (1960)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rows.length ? (
          <div className="pro-empty">{k.loading ? 'Loading daily candles…' : 'Not enough daily candles (60+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">TIME-SERIES MOMENTUM, TREND AND RANK</div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th>1 WEEK</th>
                  <th>1 MONTH</th>
                  <th>3 MONTHS</th>
                  <th>6 MONTHS</th>
                  <th title="The month's log return in its own standard deviations: momentum that is large for this coin">MONTH / σ</th>
                  <th title="t-statistic of the 60-day regression trend">TREND t (60D)</th>
                  <th title="Kalman-filtered slope over its standard error">KALMAN t</th>
                  <th title="Cross-sectional rank by month / σ: 1 strongest">RANK</th>
                  <th className="l">SIGNAL</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setSel(r.coin)}>
                    <td className="l b">{r.coin}</td>
                    <td className={`mono ${heatCls(r.r.w, 0.05)}`}>{pct(r.r.w, 1)}</td>
                    <td className={`mono ${heatCls(r.r.m, 0.1)}`}>{pct(r.r.m, 1)}</td>
                    <td className={`mono ${heatCls(r.r.q, 0.2)}`}>{pct(r.r.q, 1)}</td>
                    <td className={`mono ${heatCls(r.r.h, 0.3)}`}>{pct(r.r.h, 1)}</td>
                    <td className={`mono ${heatCls(r.z, 1)}`}>{num(r.z)}</td>
                    <td className={`mono ${heatCls(r.tt, 2)}`}>{num(r.tt, 1)}</td>
                    <td className={`mono ${heatCls(r.kt, 2)}`}>{num(r.kt, 1)}</td>
                    <td className="mono">{r.rank}</td>
                    <td className={`l b ${r.score >= 0.5 ? 'up' : r.score <= -0.5 ? 'down' : 'muted'}`}>{r.score >= 0.75 ? 'STRONG LONG' : r.score >= 0.5 ? 'LONG' : r.score <= -0.75 ? 'STRONG SHORT' : r.score <= -0.5 ? 'SHORT' : 'MIXED'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="lab-grid2">
              <div>
                <div className="pro-section">MONTH / σ — STRONGEST TO WEAKEST</div>
                <Bars rows={[...rows].sort((a, b) => a.rank - b.rank).map((r) => ({ label: r.coin, value: Number.isFinite(r.z) ? r.z : 0 }))} format={(v) => v.toFixed(2)} />
              </div>
              {pick && (
                <div>
                  <div className="pro-section">{pick.coin} — PRICE AND ITS KALMAN TREND (DAILY)</div>
                  <LineChart
                    height={150}
                    format={(v) => fmtPrice(v)}
                    series={[
                      { values: pick.closes.slice(-180), color: 'var(--muted)', width: 1 },
                      { values: pick.level.slice(-180), color: 'var(--pro-head, #ffd200)', width: 1.8 },
                    ]}
                  />
                </div>
              )}
            </div>
            <div className="lab-line muted">
              The signal votes the 1-week, 1-month and 3-month returns and the Kalman trend (when it is clear of zero). Momentum in crypto is strongest over days to weeks (Liu & Tsyvinski 2021); scaling by volatility trades the moves that are large for the coin. The Lab tests time-series momentum, volatility-scaled momentum and the Kalman trend as rules, and mixes them with sizing and hedges.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// REGM — regimes: trending, reverting or random; calm or turbulent
// ======================================================================

export interface RegimeConfig {
  venue: VenueId | 'auto';
  coins: string;
}
export const REGM_DEFAULTS: RegimeConfig = { venue: 'auto', coins: DEFAULT_COINS };

interface RegRow {
  coin: string;
  hurst: number;
  vr: number;
  vz: number;
  hl: number;
  s: number;
  pTurb: number;
  calm: number;
  turb: number;
  stay: [number, number];
  probs: number[];
}

function regRow(coin: string, k: Kline[]): RegRow | null {
  if (k.length < 400) return null;
  const r = logR(k);
  const n = r.length;
  const v = varianceRatio(r, 24, n - 30);
  const o = ouRolling(
    k.map((x) => Math.log(x.close)),
    168,
  );
  const m = fitHmm2(r);
  const p = m ? Array.from(hmmFilter(m, r)) : [];
  return {
    coin,
    hurst: hurstRS(r),
    vr: v.vr[n - 1],
    vz: v.z[n - 1],
    hl: o.halfLife[k.length - 1],
    s: o.s[k.length - 1],
    pTurb: p[p.length - 1] ?? NaN,
    calm: m ? m.sd[0] * Math.sqrt(HOURS_A_YEAR) : NaN,
    turb: m ? m.sd[1] * Math.sqrt(HOURS_A_YEAR) : NaN,
    stay: m ? hmmDuration(m) : [NaN, NaN],
    probs: p,
  };
}

const character = (r: RegRow) => (r.vr > 1.1 && r.vz > 1.5 ? 'trending' : r.vr < 0.9 && r.vz < -1.5 ? 'mean-reverting' : 'random walk');

export function RegimePanel({ config: c, setConfig }: PanelProps<RegimeConfig>) {
  const venue = useVenue(c.venue);
  const base = useSettings((s) => s.base);
  const coins = coinsOf(c.coins);
  const k = useKlines(venue, coins, '1h', 1000);
  const [sel, setSel] = useState<string | null>(null);
  const rows = useMemo(() => coins.map((b) => (k.data[b] ? regRow(b, k.data[b]) : null)).filter((x): x is RegRow => !!x), [k.data, coins.join()]);
  const pick = rows.find((r) => r.coin === sel) ?? rows.find((r) => r.coin === base) ?? rows[0];
  return (
    <div className="pro-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'fitting…' : '1000 hourly bars · Lo & MacKinlay (1988); Hurst (1951); Hamilton (1989)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!rows.length ? (
          <div className="pro-empty">{k.loading ? 'Loading candles and fitting the models…' : 'Not enough candles (400+ needed).'}</div>
        ) : (
          <>
            <div className="pro-section">WHAT KIND OF MARKET — PERSISTENCE, MEAN REVERSION AND THE HIDDEN REGIME</div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th title="Rescaled-range Hurst exponent: 0.5 random, above trending, below reverting">HURST</th>
                  <th title="Variance ratio of 24-hour to 1-hour returns: above 1 trending, below reverting">VARIANCE RATIO</th>
                  <th title="z-statistic of the variance ratio against a random walk">VR z</th>
                  <th title="Ornstein–Uhlenbeck half-life over the last week, hours">OU HALF-LIFE</th>
                  <th title="Distance from the OU equilibrium in its standard deviations">OU s-SCORE</th>
                  <th className="l">CHARACTER</th>
                  <th title="Hidden Markov model: the odds the market is in its turbulent state now">P(TURBULENT)</th>
                  <th>CALM / TURBULENT VOL</th>
                  <th title="Expected stay in each state">STAYS (H)</th>
                  <th className="l">SUITS</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const ch = character(r);
                  return (
                    <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setSel(r.coin)}>
                      <td className="l b">{r.coin}</td>
                      <td className={`mono ${r.hurst > 0.55 ? 'up' : r.hurst < 0.45 ? 'down' : ''}`}>{num(r.hurst)}</td>
                      <td className={`mono ${r.vr > 1.1 ? 'up' : r.vr < 0.9 ? 'down' : ''}`}>{num(r.vr)}</td>
                      <td className="mono">{num(r.vz, 1)}</td>
                      <td className="mono">{Number.isFinite(r.hl) ? `${r.hl.toFixed(0)} h` : 'none'}</td>
                      <td className={`mono ${Math.abs(r.s) > 2 ? 'b' : ''}`}>{num(r.s)}</td>
                      <td className={`l b ${ch === 'trending' ? 'up' : ch === 'mean-reverting' ? 'down' : 'muted'}`}>{ch}</td>
                      <td className={`mono ${r.pTurb > 0.5 ? 'down' : 'up'}`}>{pct(r.pTurb, 0)}</td>
                      <td className="mono">
                        {pct(r.calm, 0)} / {pct(r.turb, 0)}
                      </td>
                      <td className="mono muted">
                        {num(r.stay[0], 0)} / {num(r.stay[1], 0)}
                      </td>
                      <td className="l muted">{ch === 'trending' ? 'trend & momentum rules' : ch === 'mean-reverting' ? 'reversion rules (OU, z-score)' : 'neither — size down'}{r.pTurb > 0.5 ? ', smaller size' : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {pick && pick.probs.length > 0 && (
              <>
                <div className="pro-section">{pick.coin} — ODDS OF THE TURBULENT REGIME, HOUR BY HOUR (FILTERED: EACH HOUR USES ONLY THE RETURNS UP TO IT)</div>
                <AreaChart values={pick.probs.slice(-600)} level={0.5} format={(v) => `${Math.round(v * 100)}%`} height={140} />
              </>
            )}
            <div className="lab-line muted">
              The variance ratio and the Hurst exponent ask whether moves persist (trend) or reverse (revert); the Ornstein–Uhlenbeck fit gives the speed of any pull back; the hidden Markov model separates calm and turbulent stretches and gives the odds of each as data arrive. In the Lab they are filters (variance-ratio regime, hidden-Markov regime), a rule (Ornstein–Uhlenbeck reversion) and inputs to every learned model.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
