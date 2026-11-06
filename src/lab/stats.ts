// The Lab's statistics: how good a strategy looks, and how sure we can be.
//
//   performance   Sharpe, Sortino, CAGR, drawdown, win rate, profit factor
//   significance  Newey–West t-statistic of the mean return (Newey & West
//                 1987); probabilistic Sharpe ratio (Bailey & López de Prado
//                 2012); deflated Sharpe ratio for the number of strategies
//                 tried (Bailey & López de Prado 2014); a t > 3 hurdle
//                 (Harvey, Liu & Zhu 2016)
//   simulation    Monte Carlo of the trade sequence (bootstrap) and of random
//                 entries with the same holding times (a null to beat);
//                 probability of backtest overfitting (Bailey et al. 2017)
import { rngOf } from './ml';
import type { Trade } from './backtest';

export const EULER = 0.5772156649015329;

/** standard normal CDF (Abramowitz & Stegun 7.1.26 via erf) */
export function ncdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** inverse standard normal CDF (Acklam's rational approximation) */
export function ninv(p: number): number {
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -ninv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function moments(x: ArrayLike<number>) {
  const n = x.length;
  let m = 0;
  for (let i = 0; i < n; i++) m += x[i] / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    m2 += (d * d) / n;
    m3 += (d * d * d) / n;
    m4 += (d * d * d * d) / n;
  }
  const sd = Math.sqrt(m2);
  return { n, mean: m, sd, skew: sd > 0 ? m3 / sd ** 3 : 0, kurt: sd > 0 ? m4 / sd ** 4 : 3 };
}

/** Newey–West t-statistic of the mean (Bartlett kernel, automatic lag) */
export function nwT(x: ArrayLike<number>, lags?: number): number {
  const { n, mean } = moments(x);
  if (n < 3) return 0;
  const L = lags ?? Math.floor(4 * (n / 100) ** (2 / 9));
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mean) ** 2;
  for (let l = 1; l <= L; l++) {
    let g = 0;
    for (let i = l; i < n; i++) g += (x[i] - mean) * (x[i - l] - mean);
    s += 2 * (1 - l / (L + 1)) * g;
  }
  const v = s / n;
  return v > 0 ? mean / Math.sqrt(v / n) : 0;
}

/** the probabilistic Sharpe ratio: P(true Sharpe > sr0), per-period Sharpe ratios */
export function psr(sr: number, n: number, skew: number, kurt: number, sr0 = 0): number {
  const den = Math.sqrt(Math.max(1e-12, 1 - skew * sr + ((kurt - 1) / 4) * sr * sr));
  return ncdf(((sr - sr0) * Math.sqrt(Math.max(1, n - 1))) / den);
}

/** the Sharpe a best-of-N lucky strategy would show (per period), given the spread of the N Sharpes */
export function expectedMaxSharpe(n: number, varSr: number): number {
  if (n <= 1 || varSr <= 0) return 0;
  return Math.sqrt(varSr) * ((1 - EULER) * ninv(1 - 1 / n) + EULER * ninv(1 - 1 / (n * Math.E)));
}

export interface Perf {
  bars: number;
  trades: number;
  /** annualised */
  sharpe: number;
  sortino: number;
  cagr: number;
  vol: number;
  maxDD: number;
  calmar: number;
  winRate: number;
  profitFactor: number;
  avgR: number;
  exposure: number;
  totalReturn: number;
  /** Newey–West t of the mean bar return */
  t: number;
  /** probability the true Sharpe is above zero */
  psr: number;
  skew: number;
  kurt: number;
  /** per-period Sharpe (for the deflated Sharpe) */
  srBar: number;
}

export function perf(rets: ArrayLike<number>, trades: Trade[], barsPerYear: number, exposure = 0): Perf {
  const m = moments(rets);
  const srBar = m.sd > 0 ? m.mean / m.sd : 0;
  let dn = 0;
  for (let i = 0; i < m.n; i++) if (rets[i] < 0) dn += rets[i] ** 2 / m.n;
  let eq = 1;
  let peak = 1;
  let mdd = 0;
  for (let i = 0; i < m.n; i++) {
    eq *= 1 + rets[i];
    peak = Math.max(peak, eq);
    mdd = Math.max(mdd, 1 - eq / peak);
  }
  const years = m.n / barsPerYear;
  const cagr = years > 0 && eq > 0 ? eq ** (1 / years) - 1 : -1;
  const wins = trades.filter((t) => t.ret > 0);
  const gw = wins.reduce((a, t) => a + t.ret, 0);
  const gl = -trades.filter((t) => t.ret <= 0).reduce((a, t) => a + t.ret, 0);
  return {
    bars: m.n,
    trades: trades.length,
    sharpe: srBar * Math.sqrt(barsPerYear),
    sortino: dn > 0 ? (m.mean / Math.sqrt(dn)) * Math.sqrt(barsPerYear) : 0,
    cagr,
    vol: m.sd * Math.sqrt(barsPerYear),
    maxDD: mdd,
    calmar: mdd > 0 ? cagr / mdd : 0,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    avgR: trades.length ? trades.reduce((a, t) => a + t.r, 0) / trades.length : 0,
    exposure,
    totalReturn: eq - 1,
    t: nwT(rets),
    psr: psr(srBar, m.n, m.skew, m.kurt),
    skew: m.skew,
    kurt: m.kurt,
    srBar,
  };
}

/** deflated Sharpe ratio: P(true Sharpe beats the best of N lucky trials) */
export function deflatedSharpe(p: Perf, nTrials: number, varSrTrials: number): number {
  return psr(p.srBar, p.bars, p.skew, p.kurt, expectedMaxSharpe(nTrials, varSrTrials));
}

export interface MonteCarlo {
  paths: number;
  trades: number;
  /** final equity multiple at 1 % risk per trade: 5th, 50th, 95th percentile */
  p5: number;
  p50: number;
  p95: number;
  /** chance of ending below the start, and of a 30 %+ drawdown on the way */
  pLoss: number;
  pDD30: number;
  /** median and 95th-percentile drawdown */
  ddMed: number;
  dd95: number;
  /** a fan of percentile equity curves (5, 25, 50, 75, 95) at 20 points */
  fan: number[][];
}

const pct = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/** bootstrap the trade sequence: what the same edge could look like, path by path, risking `risk` per trade */
export function monteCarlo(rs: number[], paths = 2000, risk = 0.01, seed = 3): MonteCarlo | null {
  const n = rs.length;
  if (n < 5) return null;
  const rnd = rngOf(seed);
  const finals: number[] = [];
  const dds: number[] = [];
  const pts = 20;
  const at: number[][] = Array.from({ length: pts + 1 }, () => []);
  // after which trade each of the 20 fan points is read
  const mark = new Map<number, number[]>();
  for (let k = 1; k <= pts; k++) {
    const j = Math.max(1, Math.round((k * n) / pts));
    mark.set(j, [...(mark.get(j) ?? []), k]);
  }
  for (let k = 0; k < paths; k++) {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    at[0].push(1);
    for (let j = 0; j < n; j++) {
      eq *= Math.max(0, 1 + risk * rs[Math.floor(rnd() * n)]);
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
      for (const q of mark.get(j + 1) ?? []) at[q].push(eq);
    }
    finals.push(eq);
    dds.push(dd);
  }
  finals.sort((a, b) => a - b);
  dds.sort((a, b) => a - b);
  const fan = at
    .filter((v) => v.length)
    .map((v) => {
      const s = [...v].sort((a, b) => a - b);
      return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => pct(s, q));
    });
  return {
    paths,
    trades: n,
    p5: pct(finals, 0.05),
    p50: pct(finals, 0.5),
    p95: pct(finals, 0.95),
    pLoss: finals.filter((x) => x < 1).length / paths,
    pDD30: dds.filter((x) => x >= 0.3).length / paths,
    ddMed: pct(dds, 0.5),
    dd95: pct(dds, 0.95),
    fan,
  };
}

/**
 * The random-entry null: the same number of trades, each held as long as the
 * real ones and on the same sides, but entered at random bars. The p-value is
 * the share of random runs whose average trade is at least as good — the
 * chance luck alone did it.
 */
export interface NullGroup {
  logClose: Float64Array;
  trades: Trade[];
  from: number;
  to: number;
}
export function randomEntryTest(groups: NullGroup[], costPerTrade: number, sims = 500, seed = 5): { p: number; actual: number; nullMean: number } | null {
  const all = groups.flatMap((g) => g.trades);
  if (all.length < 5) return null;
  const actual = all.reduce((a, t) => a + t.ret, 0) / all.length;
  const rnd = rngOf(seed);
  let beat = 0;
  let sum = 0;
  for (let k = 0; k < sims; k++) {
    let s = 0;
    for (const g of groups)
      for (const t of g.trades) {
        const len = Math.max(1, t.exitI - t.entryI);
        const i = g.from + Math.floor(rnd() * Math.max(1, g.to - g.from - len - 1));
        const j = Math.min(g.logClose.length - 1, i + len);
        s += t.side * (Math.exp(g.logClose[j] - g.logClose[i]) - 1) - costPerTrade;
      }
    const m = s / all.length;
    sum += m;
    if (m >= actual) beat++;
  }
  return { p: (beat + 1) / (sims + 1), actual, nullMean: sum / sims };
}

/**
 * Probability of backtest overfitting by combinatorially symmetric
 * cross-validation: split time into S blocks; for every half of the blocks
 * taken as "in sample", find the best candidate there and see where it ranks
 * on the other half. PBO is the share of splits where it lands in the bottom
 * half. `blocks[c][s]` is candidate c's mean return in block s.
 */
export function pbo(blocks: number[][]): number | null {
  const C = blocks.length;
  const S = blocks[0]?.length ?? 0;
  if (C < 3 || S < 4 || S % 2) return null;
  const half = S / 2;
  const combos: number[][] = [];
  const pick = (start: number, cur: number[]) => {
    if (cur.length === half) {
      combos.push([...cur]);
      return;
    }
    for (let s = start; s < S; s++) pick(s + 1, [...cur, s]);
  };
  pick(0, []);
  let below = 0;
  for (const is of combos) {
    const oos = Array.from({ length: S }, (_, s) => s).filter((s) => !is.includes(s));
    const score = (c: number, set: number[]) => set.reduce((a, s) => a + blocks[c][s], 0) / set.length;
    let best = 0;
    for (let c = 1; c < C; c++) if (score(c, is) > score(best, is)) best = c;
    const o = score(best, oos);
    const rank = Array.from({ length: C }, (_, c) => score(c, oos)).filter((x) => x < o).length / (C - 1);
    if (rank < 0.5) below++;
  }
  return below / combos.length;
}
