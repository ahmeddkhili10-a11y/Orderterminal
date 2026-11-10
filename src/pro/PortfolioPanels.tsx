// Portfolio theory on the QUANT desk (F4):
//
//   CAPM   each coin against the market (bitcoin, or an equal-weight index of
//          the coins): beta, Jensen's alpha and its t, R², the return CAPM
//          expects for that beta, Treynor and information ratios, and the
//          security market line
//   EF     the long-only efficient frontier (Markowitz) of the coins: the
//          minimum-variance and maximum-Sharpe (tangency) portfolios, the
//          capital market line, equal weight and the Kelly portfolio
//   KELLY  the Kelly criterion: each coin's growth-optimal leverage and its
//          growth curve, the growth-optimal portfolio, and a strategy's Kelly
//          bet from its win rate and payoff
//
// Means are the noisiest inputs in all three: the frontier and Kelly shrink
// them toward the coins' average (a James–Stein-style blend), and the screens
// say how much to trust them.
import { useMemo, useState } from 'react';
import type { Kline, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { capm, efficientFrontier, kellyBet, kellyGrowth, kellyPortfolio, meanCov, moments4, type Capm, type Portfolio } from '../lab/quant';
import { useSettings } from '../store/settings';
import { NumberInput, Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { Bars, LineChart, ScatterChart } from './charts';
import { USES } from './botUses';
import { UseInBot } from './UseInBot';
import { BOARD_VENUES, useBoardVenue, useKlines } from './data';

const venueOpts = () => [{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))];
const pct = (x: number, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const num = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
const coinsOf = (s: string) => s.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 12);
const DAYS = 365;
const DEFAULT_COINS = 'BTC ETH SOL BNB XRP DOGE AVAX LINK';
const COLORS = ['#ffd200', '#4f8ff0', '#2cf0b0', '#ff7a1a', '#c0508a', '#38e1ff', '#e3262f', '#a0d468', '#ffffff', '#b58cff', '#ff9ec7', '#7fd8be'];

function CoinsInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  return <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => onCommit(text)} onKeyDown={(e) => e.key === 'Enter' && onCommit(text)} style={{ width: 200 }} title="Coins, separated by spaces" />;
}

/** daily log returns aligned by day across coins (the last `days` days every coin has) */
function aligned(data: Record<string, Kline[]>, coins: string[], days: number) {
  const have = coins.filter((c) => (data[c]?.length ?? 0) > 30);
  if (!have.length) return { coins: [] as string[], rets: [] as number[][], n: 0 };
  const maps = have.map((c) => new Map(data[c].map((k) => [Math.floor(k.time / 86_400_000), k.close])));
  const days0 = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort((a, b) => a - b).slice(-(days + 1));
  const rets = maps.map((m) => days0.slice(1).map((d, i) => Math.log(m.get(d)! / m.get(days0[i])!)));
  return { coins: have, rets, n: days0.length - 1 };
}

/** shrink the means toward their cross-sectional average */
const shrinkMeans = (mu: number[], k: number) => {
  const avg = mu.reduce((a, b) => a + b, 0) / mu.length;
  return mu.map((m) => (1 - k) * m + k * avg);
};

// ======================================================================
// CAPM
// ======================================================================

export interface CapmConfig {
  venue: VenueId | 'auto';
  coins: string;
  market: 'BTC' | 'index';
  rf: number;
  days: number;
}
export const CAPM_DEFAULTS: CapmConfig = { venue: 'auto', coins: DEFAULT_COINS, market: 'BTC', rf: 4, days: 365 };

export function CapmPanel({ config: c, setConfig }: PanelProps<CapmConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const base = useSettings((s) => s.base);
  const coins = coinsOf(c.coins);
  const all = [...new Set([...(c.market === 'BTC' ? ['BTC'] : []), ...coins])];
  const k = useKlines(venue, all, '1d', 400);
  const rfD = c.rf / 100 / DAYS;
  const res = useMemo(() => {
    const al = aligned(k.data, all, c.days);
    if (al.coins.length < 2) return null;
    const idx = c.market === 'BTC' ? al.rets[al.coins.indexOf('BTC')] : al.rets[0].map((_, t) => al.rets.reduce((a, r) => a + r[t], 0) / al.rets.length);
    if (!idx) return null;
    const mMean = idx.reduce((a, b) => a + b, 0) / idx.length;
    const mVar = moments4(idx).s ** 2;
    const rows = al.coins
      .filter((x) => !(c.market === 'BTC' && x === 'BTC'))
      .map((coin) => {
        const r = al.rets[al.coins.indexOf(coin)];
        const cp = capm(r, idx, rfD) as Capm;
        const m = moments4(r);
        const expected = rfD + cp.beta * (mMean - rfD);
        return { coin, cp, mean: m.m, sd: m.s, expected, treynor: Math.abs(cp.beta) > 0.1 ? (m.m - rfD) / cp.beta : NaN, ir: cp.residSd > 0 ? cp.alpha / cp.residSd : NaN, sharpe: m.s > 0 ? (m.m - rfD) / m.s : NaN };
      });
    return { rows, mMean, mSd: Math.sqrt(mVar), n: al.n };
  }, [k.data, c.market, c.rf, c.days, all.join()]);
  const ann = (x: number) => x * DAYS;
  return (
    <div className="pro-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <Select value={c.market} options={[{ value: 'BTC' as const, label: 'market = bitcoin' }, { value: 'index' as const, label: 'market = equal-weight index' }]} onChange={(market) => setConfig({ market })} />
        <NumberInput value={c.rf} step={0.5} min={0} width={56} onChange={(rf) => setConfig({ rf })} title="Risk-free rate, % a year" suffix="%" />
        <Select value={c.days} options={[90, 180, 365].map((d) => ({ value: d, label: `${d} days` }))} onChange={(days) => setConfig({ days })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="CAPM" options={USES.capm()} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : 'daily returns · Sharpe (1964); Jensen (1968); Treynor (1965)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!res ? (
          <div className="pro-empty">{k.loading ? 'Loading daily candles…' : 'Not enough daily candles for these coins.'}</div>
        ) : (
          <>
            <div className="pro-section">
              CAPITAL ASSET PRICING MODEL — EACH COIN AGAINST {c.market === 'BTC' ? 'BITCOIN' : 'THE EQUAL-WEIGHT INDEX'}, {res.n} DAYS (MARKET {pct(ann(res.mMean))} A YEAR, VOL {pct(res.mSd * Math.sqrt(DAYS))})
            </div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th title="Market exposure: 1.5 moves 1.5% for each 1% of the market">β</th>
                  <th title="Jensen's alpha, a year: return beyond what its beta explains">α (A YEAR)</th>
                  <th title="t-statistic of alpha: above 2 is unlikely to be luck">α t</th>
                  <th title="Share of the coin's variance the market explains">R²</th>
                  <th title="What CAPM says a coin with this beta should earn">CAPM E[R]</th>
                  <th title="What it did earn (mean log return, a year)">REALISED</th>
                  <th title="Excess return per unit of beta">TREYNOR</th>
                  <th title="Alpha over idiosyncratic risk, a year">INFO RATIO</th>
                  <th>SHARPE</th>
                  <th title="Volatility the market does not explain">IDIO VOL</th>
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.coin} className={r.coin === base ? 'sel' : ''}>
                    <td className="l b">{r.coin}</td>
                    <td className="mono b">{num(r.cp.beta)}</td>
                    <td className={`mono ${r.cp.alpha > 0 ? 'up' : 'down'}`}>{pct(ann(r.cp.alpha))}</td>
                    <td className={`mono ${Math.abs(r.cp.tAlpha) > 2 ? 'b' : 'muted'}`}>{num(r.cp.tAlpha, 1)}</td>
                    <td className="mono">{pct(r.cp.r2, 0)}</td>
                    <td className="mono">{pct(ann(r.expected))}</td>
                    <td className={`mono ${r.mean > r.expected ? 'up' : 'down'}`}>{pct(ann(r.mean))}</td>
                    <td className="mono">{pct(ann(r.treynor))}</td>
                    <td className="mono">{num(r.ir * Math.sqrt(DAYS))}</td>
                    <td className="mono">{num(r.sharpe * Math.sqrt(DAYS))}</td>
                    <td className="mono muted">{pct(r.cp.residSd * Math.sqrt(DAYS), 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pro-section">SECURITY MARKET LINE — BETA AGAINST RETURN; ABOVE THE LINE EARNED MORE THAN ITS BETA</div>
            <ScatterChart
              height={230}
              xLabel="β"
              yLabel="return a year"
              xFormat={(v) => v.toFixed(1)}
              yFormat={(v) => `${(v * 100).toFixed(0)}%`}
              lines={[{ pts: [[0, c.rf / 100], [Math.max(2, ...res.rows.map((r) => r.cp.beta)) * 1.05, c.rf / 100 + Math.max(2, ...res.rows.map((r) => r.cp.beta)) * 1.05 * (ann(res.mMean) - c.rf / 100)]], color: 'var(--muted)', dash: '5 4' }]}
              points={[{ x: 1, y: ann(res.mMean), label: 'market', color: 'var(--muted)', ring: true, r: 5 }, ...res.rows.map((r, i) => ({ x: r.cp.beta, y: ann(r.mean), label: r.coin, color: COLORS[i % COLORS.length] }))]}
            />
            <div className="lab-line muted">
              CAPM says a coin should earn the risk-free rate plus beta times the market's premium; alpha is what it earned beyond that. Over a year of daily crypto returns, alpha's t-statistic is rarely above 2 — most of a coin's move is the market's. Beta is the useful number: it sizes the bitcoin hedge in the Strategy Lab (the delta hedge shorts β × the position) and says how much of the swarm's book is one bet.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// EF — the efficient frontier
// ======================================================================

export interface FrontierConfig {
  venue: VenueId | 'auto';
  coins: string;
  rf: number;
  days: number;
  shrink: number;
}
export const EF_DEFAULTS: FrontierConfig = { venue: 'auto', coins: DEFAULT_COINS, rf: 4, days: 365, shrink: 50 };

export function FrontierPanel({ config: c, setConfig }: PanelProps<FrontierConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const coins = coinsOf(c.coins);
  const k = useKlines(venue, coins, '1d', 400);
  const rf = c.rf / 100;
  const res = useMemo(() => {
    const al = aligned(k.data, coins, c.days);
    if (al.coins.length < 2) return null;
    const { mu: m0, cov: c0 } = meanCov(al.rets);
    const cov = c0.map((r) => r.map((v) => v * DAYS));
    // log-return means → arithmetic expected returns: add half the variance
    const mu = shrinkMeans(m0, c.shrink / 100).map((m, i) => m * DAYS + 0.5 * cov[i][i]);
    const ef = efficientFrontier(mu, cov, rf);
    const eqW = al.coins.map(() => 1 / al.coins.length);
    const eqRet = eqW.reduce((a, w, i) => a + w * mu[i], 0);
    const eqVol = Math.sqrt(eqW.reduce((a, wi, i) => a + eqW.reduce((b, wj, j) => b + wi * wj * cov[i][j], 0), 0));
    const kelly = kellyPortfolio(mu, cov, rf, 1);
    const half: Portfolio = { ...kelly, w: kelly.w.map((w) => w / 2), ret: rf + (kelly.ret - rf) / 2, vol: kelly.vol / 2 };
    return { coins: al.coins, mu, cov, ef, eq: { w: eqW, ret: eqRet, vol: eqVol, sharpe: eqVol > 0 ? (eqRet - rf) / eqVol : NaN }, kelly, half, n: al.n };
  }, [k.data, c.rf, c.days, c.shrink, coins.join()]);
  const portfolios = res
    ? ([
        ['Minimum variance', res.ef.minVar],
        ['Maximum Sharpe (tangency)', res.ef.tangency],
        ['Equal weight', res.eq],
        ['Kelly (growth-optimal, ≤ 1×)', res.kelly],
        ['Half Kelly', res.half],
      ] as [string, Portfolio][])
    : [];
  return (
    <div className="pro-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <NumberInput value={c.rf} step={0.5} min={0} width={56} onChange={(v) => setConfig({ rf: v })} title="Risk-free rate, % a year" suffix="%" />
        <Select value={c.days} options={[180, 365].map((d) => ({ value: d, label: `${d} days` }))} onChange={(days) => setConfig({ days })} />
        <Select value={c.shrink} options={[0, 25, 50, 75].map((v) => ({ value: v, label: `shrink means ${v}%` }))} onChange={(shrink) => setConfig({ shrink })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="EF" options={USES.frontier()} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : 'long-only · Markowitz (1952); Sharpe (1964); Tobin (1958)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!res ? (
          <div className="pro-empty">{k.loading ? 'Loading daily candles…' : 'Need at least two coins with daily history.'}</div>
        ) : (
          <>
            <div className="pro-section">
              EFFICIENT FRONTIER — {res.coins.length} COINS, {res.n} DAYS, LONG ONLY, FULLY INVESTED; CAPITAL MARKET LINE FROM {c.rf}% THROUGH THE TANGENCY
            </div>
            <ScatterChart
              height={280}
              xLabel="volatility a year"
              yLabel="expected return a year"
              xFormat={(v) => `${(v * 100).toFixed(0)}%`}
              yFormat={(v) => `${(v * 100).toFixed(0)}%`}
              lines={[
                { pts: res.ef.frontier.map((p) => [p.vol, p.ret] as [number, number]), color: 'var(--pro-head, #ffd200)', width: 2.2 },
                { pts: [[0, rf], [res.ef.tangency.vol * 1.6, rf + res.ef.tangency.sharpe * res.ef.tangency.vol * 1.6]], color: 'var(--muted)', dash: '5 4' },
              ]}
              points={[
                ...res.coins.map((coin, i) => ({ x: Math.sqrt(res.cov[i][i]), y: res.mu[i], label: coin, color: COLORS[i % COLORS.length], r: 3 })),
                { x: res.ef.minVar.vol, y: res.ef.minVar.ret, label: 'min variance', color: '#4f8ff0', r: 5, ring: true },
                { x: res.ef.tangency.vol, y: res.ef.tangency.ret, label: 'max Sharpe', color: '#2cf0b0', r: 5, ring: true },
                { x: res.eq.vol, y: res.eq.ret, label: 'equal weight', color: 'var(--muted)', r: 4, ring: true },
                { x: res.kelly.vol, y: res.kelly.ret, label: 'Kelly', color: '#ff7a1a', r: 5, ring: true },
              ]}
            />
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">PORTFOLIO</th>
                  <th>RETURN</th>
                  <th>VOL</th>
                  <th>SHARPE</th>
                  {res.coins.map((x) => (
                    <th key={x}>{x}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {portfolios.map(([name, p]) => (
                  <tr key={name}>
                    <td className="l b">{name}</td>
                    <td className={`mono ${p.ret > rf ? 'up' : 'down'}`}>{pct(p.ret)}</td>
                    <td className="mono">{pct(p.vol)}</td>
                    <td className="mono">{num(p.sharpe)}</td>
                    {p.w.map((w, i) => (
                      <td key={i} className={`mono ${w > 0.005 ? '' : 'muted'}`}>
                        {w > 0.005 ? pct(w, 0) : '·'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="lab-line muted">
              The frontier is every portfolio with the most return for its risk. The tangency portfolio has the best Sharpe ratio; the capital market line mixes it with cash (Tobin's separation). The Kelly portfolio maximises long-run growth (capped at 1× here; the rest in cash) and half Kelly gives up a quarter of the growth for half the volatility. Expected returns are the weakest input — a year of crypto returns says little about the next — so they are shrunk toward the coins' average; covariances are far more reliable, which is why the minimum-variance portfolio is the most robust point on the curve.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ======================================================================
// KELLY — the Kelly criterion
// ======================================================================

export interface KellyConfig {
  venue: VenueId | 'auto';
  coins: string;
  rf: number;
  shrink: number;
  cap: number;
}
export const KELLY_DEFAULTS: KellyConfig = { venue: 'auto', coins: DEFAULT_COINS, rf: 4, shrink: 50, cap: 2 };

export function KellyPanel({ config: c, setConfig }: PanelProps<KellyConfig>) {
  const board = useBoardVenue();
  const venue = c.venue === 'auto' ? board : c.venue;
  const base = useSettings((s) => s.base);
  const coins = coinsOf(c.coins);
  const k = useKlines(venue, coins, '1d', 400);
  const rf = c.rf / 100;
  const [sel, setSel] = useState<string | null>(null);
  const res = useMemo(() => {
    const al = aligned(k.data, coins, 365);
    if (!al.coins.length) return null;
    const { mu: m0, cov: c0 } = meanCov(al.rets);
    const mu = shrinkMeans(m0, al.coins.length > 1 ? c.shrink / 100 : 0).map((m) => m * DAYS);
    const cov = c0.map((r) => r.map((v) => v * DAYS));
    // log-return means → arithmetic: add half the variance
    const arith = mu.map((m, i) => m + 0.5 * cov[i][i]);
    const rows = al.coins.map((coin, i) => {
      const v = cov[i][i];
      const f = (arith[i] - rf) / v;
      // long only: no edge over cash means no position, and cash's growth
      const fl = Math.max(0, f);
      return { coin, mu: arith[i], vol: Math.sqrt(v), f, g: kellyGrowth(fl, arith[i] - rf, v, rf), gHalf: kellyGrowth(fl / 2, arith[i] - rf, v, rf) };
    });
    const port = al.coins.length > 1 ? kellyPortfolio(arith, cov, rf, c.cap) : null;
    return { coins: al.coins, rows, port, n: al.n };
  }, [k.data, c.rf, c.shrink, c.cap, coins.join()]);
  const pick = res?.rows.find((r) => r.coin === sel) ?? res?.rows.find((r) => r.coin === base) ?? res?.rows[0];
  // Kelly for a strategy's bets: win rate and the average win in R (losses of 1R)
  const [win, setWin] = useState(45);
  const [payoff, setPayoff] = useState(2);
  const stratKelly = kellyBet(win / 100, payoff, 1);
  return (
    <div className="pro-panel kelly-panel">
      <Toolbar>
        <CoinsInput value={c.coins} onCommit={(coins) => setConfig({ coins })} />
        <NumberInput value={c.rf} step={0.5} min={0} width={56} onChange={(rf) => setConfig({ rf })} title="Risk-free rate, % a year" suffix="%" />
        <Select value={c.shrink} options={[0, 25, 50, 75].map((v) => ({ value: v, label: `shrink means ${v}%` }))} onChange={(shrink) => setConfig({ shrink })} />
        <NumberInput value={c.cap} step={0.5} min={0.5} width={56} onChange={(cap) => setConfig({ cap })} title="Leverage cap for the Kelly portfolio" suffix="×" />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <UseInBot from="KELLY" options={USES.kelly()} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : 'Kelly (1956); Thorp (2006); MacLean, Thorp & Ziemba (2011)'}</span>
      </Toolbar>
      <div className="pro-scroll">
        {!res ? (
          <div className="pro-empty">{k.loading ? 'Loading daily candles…' : 'Not enough daily candles.'}</div>
        ) : (
          <>
            <div className="pro-section">THE KELLY CRITERION — THE LEVERAGE THAT MAXIMISES LONG-RUN GROWTH, COIN BY COIN ({res.n} DAYS)</div>
            <table className="pro-table">
              <thead>
                <tr>
                  <th className="l">COIN</th>
                  <th title="Expected return a year (means shrunk toward the coins' average)">E[R]</th>
                  <th>VOL</th>
                  <th title="(μ − r) / σ²: the growth-optimal leverage; negative means short or nothing">FULL KELLY</th>
                  <th>HALF KELLY</th>
                  <th title="Expected log growth a year at full Kelly">GROWTH (FULL)</th>
                  <th title="At half Kelly: three quarters of the growth, half the volatility">GROWTH (HALF)</th>
                  <th className="l">READING</th>
                </tr>
              </thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.coin} className={pick?.coin === r.coin ? 'sel' : ''} onClick={() => setSel(r.coin)}>
                    <td className="l b">{r.coin}</td>
                    <td className={`mono ${r.mu > rf ? 'up' : 'down'}`}>{pct(r.mu)}</td>
                    <td className="mono">{pct(r.vol)}</td>
                    <td className="mono b">{r.f > 0 ? `${num(r.f)}×` : 'none'}</td>
                    <td className="mono">{r.f > 0 ? `${num(r.f / 2)}×` : 'none'}</td>
                    <td className="mono">{pct(r.g)}</td>
                    <td className="mono">{pct(r.gHalf)}</td>
                    <td className="l muted">{r.f <= 0 ? 'no edge over cash: hold none' : r.f > 3 ? 'very high — the mean is likely over-estimated' : r.f < 0.25 ? 'small edge for the risk' : 'a usable edge, if the mean holds'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {pick && (
              <>
                <div className="pro-section">
                  {pick.coin} — EXPECTED GROWTH BY LEVERAGE: {pick.f > 0 ? `IT PEAKS AT FULL KELLY (${num(pick.f)}×) AND FALLS BACK TO CASH'S AT TWICE IT` : 'NO EDGE OVER CASH — GROWTH ONLY FALLS AS LEVERAGE RISES'}
                </div>
                <LineChart
                  log={false}
                  height={150}
                  format={(v) => `${(v * 100).toFixed(0)}%`}
                  series={[{ values: Array.from({ length: 41 }, (_, i) => kellyGrowth((Math.max(0.4, pick.f * 2.5) * i) / 40, pick.mu - rf, pick.vol ** 2, rf)), color: 'var(--pro-head, #ffd200)', width: 1.8 }]}
                  labels={
                    <>
                      leverage from 0 to {num(Math.max(0.4, pick.f * 2.5))}× · {pick.f > 0 ? `peak at ${num(pick.f)}× · past 2× Kelly growth falls below cash's even with an edge` : 'any long position lowers growth here'}
                    </>
                  }
                />
              </>
            )}
            {res.port && (
              <div className="lab-grid2">
                <div>
                  <div className="pro-section">GROWTH-OPTIMAL PORTFOLIO (LONG ONLY, ≤ {c.cap}×)</div>
                  <Bars rows={res.coins.map((coin, i) => ({ label: coin, value: res.port!.w[i], tone: 'up' as const })).filter((r) => r.value > 0.005)} format={(v) => `${(v * 100).toFixed(0)}%`} />
                  <div className="lab-line mono">
                    gross {num(res.port.w.reduce((a, b) => a + b, 0))}× · return {pct(res.port.ret)} · vol {pct(res.port.vol)} · half Kelly: same weights halved
                  </div>
                </div>
                <div>
                  <div className="pro-section">KELLY FOR A STRATEGY — WIN RATE AND PAYOFF</div>
                  <div className="q-kelly">
                    <label>
                      WIN RATE
                      <NumberInput value={win} step={1} min={1} width={60} onChange={(v) => setWin(Math.min(99, v))} suffix="%" />
                    </label>
                    <label>
                      AVG WIN (R)
                      <NumberInput value={payoff} step={0.1} min={0.1} width={60} onChange={setPayoff} />
                    </label>
                  </div>
                  <div className="lab-kv mono">
                    <span className={stratKelly > 0 ? 'up' : 'down'}>Kelly {pct(stratKelly, 1)} of the account at risk a trade</span>
                    <span>half {pct(stratKelly / 2, 1)}</span>
                    <span>quarter {pct(stratKelly / 4, 1)}</span>
                    {stratKelly <= 0 && <span className="down">no edge: do not take it</span>}
                  </div>
                </div>
              </div>
            )}
            <div className="lab-line muted">
              Kelly's bet maximises the long-run growth of capital: the edge over the variance. It assumes the edge is known — and an over-estimated edge makes the Kelly bet ruinous, which is why practitioners use a half or a quarter of it (MacLean, Thorp & Ziemba 2011). Use the Strategy Lab's tested win rate and payoff here; its Monte Carlo shows the drawdowns at 1 % risk a trade.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
