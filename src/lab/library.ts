// The Strategy Lab's library: trading rules from the research in papers.ts,
// broken into parts the Lab can mix and match.
//
//   signals  say long (+1), short (−1) or nothing (0) at each bar's close.
//            A trade opens when a signal switches on; the next bar's open is
//            the entry, so no rule ever sees the bar it trades on.
//   filters  allow longs or shorts at a bar (trend, volatility regime, trend
//            strength, volume, session, funding crowding).
//   exits    an ATR stop, an optional target in R, a trailing stop, a time
//            limit, and whether an opposite signal closes the trade.
//
// Lookbacks are written in hours and converted to bars of the timeframe, so
// one rule runs on 1-hour, 4-hour or daily candles.
import { fitBest, garchVar, type GarchFit } from './garch';
import { fitForest, fitMLP, fitRidge, predictForest, predictMLP, predictRidge, type ForestModel, type MLP, type Ridge } from './ml';
import { fitHmm2, hmmFilter, hurstRS, kalmanTrend, ouRolling, varianceRatio, volEstimate, type Hmm2 } from './quant';
import { CANDLE_FEATURES, candleShape } from './shape';
import { adx, atr, ema, hiPrev, loPrev, logRets, pctRank, retN, rsi, rstd, rvol, sma, volZ, type Bar } from './series';

export interface Market {
  coin: string;
  /** hours per bar: 1, 4 or 24 */
  tfH: number;
  bars: Bar[];
  /** funding paid by longs per bar (a fraction of notional), aligned with bars; null when unknown */
  funding?: Float64Array | null;
  /** the benchmark's close (bitcoin) at each bar, for a delta hedge; null for bitcoin itself or when unknown */
  bench?: Float64Array | null;
}
export type Params = Record<string, number>;
/** relative: the coin measured against bitcoin (pairs, lead and lag) */
export type Family = 'momentum' | 'trend' | 'breakout' | 'reversion' | 'carry' | 'seasonal' | 'volume' | 'ml' | 'relative';

export interface ExitSpec {
  /** stop distance in ATR(14) */
  stopAtr: number;
  /** target in R (multiples of the stop distance); 0 = no target */
  targetR: number;
  /** trailing stop in ATR once the trade is 1R up; 0 = none */
  trailAtr: number;
  /** close after this many bars */
  maxBars: number;
  /** an opposite signal closes the trade */
  onFlip: boolean;
  /** stop distance in GARCH volatility units instead of ATR (σ of the next bar's return); 0 = use the ATR stop */
  stopVol?: number;
}
export const EXIT_DEFAULT: ExitSpec = { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true, stopVol: 0 };

export interface Ctx {
  m: Market;
  cache: Map<string, unknown>;
  /** bars before this index are the training set (learned rules fit only on them) */
  trainEnd: number;
  seed: number;
}
export const ctxOf = (m: Market, trainEnd = m.bars.length, seed = 7): Ctx => ({ m, cache: new Map(), trainEnd, seed });

/** a lookback in hours as bars of the market's timeframe */
export const H = (c: Ctx, hours: number) => Math.max(2, Math.round(hours / c.m.tfH));
export const barsPerYear = (tfH: number) => (24 * 365) / tfH;

function cached<T>(c: Ctx, key: string, f: () => T): T {
  if (!c.cache.has(key)) c.cache.set(key, f());
  return c.cache.get(key) as T;
}
const close = (c: Ctx) => cached(c, 'close', () => Float64Array.from(c.m.bars, (b) => b.close));
const smaH = (c: Ctx, h: number) => cached(c, `sma${H(c, h)}`, () => sma(close(c), H(c, h)));
const sdH = (c: Ctx, h: number) => cached(c, `sd${H(c, h)}`, () => rstd(close(c), H(c, h)));
export const atr14 = (c: Ctx) => cached(c, 'atr14', () => atr(c.m.bars, 14));
const fundAnn = (c: Ctx, h: number) =>
  cached(c, `fund${H(c, h)}`, () => {
    const f = c.m.funding;
    if (!f) return null;
    const m = sma(f, H(c, h));
    const k = barsPerYear(c.m.tfH);
    return m.map((x) => x * k);
  });

// ---------- GARCH volatility, fitted on the training bars only ----------

/** the coin's GARCH model (the best of GARCH/GJR × normal/t by BIC), fitted on the bars before trainEnd */
export function garchOf(c: Ctx): GarchFit | null {
  return cached(c, 'garch', () => {
    const lr = logRets(close(c));
    const end = Math.min(c.trainEnd, lr.length);
    return end - 1 >= 300 ? trainedOnce(c, 'garch', () => fitBest(lr.slice(Math.max(1, end - 6000), end))) : null;
  });
}

/**
 * GARCH volatility (σ of the log return) of the bar AFTER each bar — known at
 * that bar's close, so value i never uses bar i + 1. Exponentially weighted
 * (RiskMetrics) when the history is too short to fit GARCH.
 */
export function garchSigma(c: Ctx): Float64Array {
  return cached(c, 'gsig', () => {
    const lr = logRets(close(c));
    const n = lr.length;
    const fit = garchOf(c);
    const out = new Float64Array(n);
    if (fit) {
      // shifted: element k is the return of bar k + 1, so h[k] is known at bar k's close
      const shifted = Float64Array.from({ length: n }, (_, k) => (k + 1 < n ? lr[k + 1] : 0));
      const h = garchVar(fit, shifted);
      for (let k = 0; k < n; k++) out[k] = Math.sqrt(h[k]);
      return out;
    }
    let v = NaN;
    for (let k = 0; k < n; k++) {
      v = Number.isFinite(v) ? 0.94 * v + 0.06 * lr[k] * lr[k] : lr[k] * lr[k] || 1e-6;
      out[k] = Math.sqrt(v);
    }
    return out;
  });
}

// ---------- quantitative models (quant.ts), cached per market ----------

const lrets = (c: Ctx) => cached(c, 'lr', () => logRets(close(c)));
const logp = (c: Ctx) => cached(c, 'logp', () => Float64Array.from(close(c), Math.log));

/** variance of the 1-bar log return over the training bars (the Kalman filter's observation noise) */
function trainVar(c: Ctx): number {
  return cached(c, 'trainVar', () => {
    const lr = lrets(c);
    const end = Math.min(c.trainEnd, lr.length);
    let s = 0;
    let q = 0;
    let k = 0;
    for (let i = Math.max(1, end - 6000); i < end; i++)
      if (Number.isFinite(lr[i])) {
        s += lr[i];
        q += lr[i] * lr[i];
        k++;
      }
    return k > 10 ? q / k - (s / k) ** 2 : 1e-4;
  });
}

/** the Kalman local-linear trend of log price; smooth 0 (smoothest) … 2 */
export const kalmanOf = (c: Ctx, smooth: number) =>
  cached(c, `kalman${smooth}`, () => kalmanTrend(logp(c), [1e-7, 1e-6, 1e-5][smooth] * c.m.tfH ** 2, trainVar(c)));
/** Ornstein–Uhlenbeck fit of log price over a rolling window (hours) */
export const ouOf = (c: Ctx, windowH: number) => cached(c, `ou${H(c, windowH)}`, () => ouRolling(logp(c), H(c, windowH)));
/** variance ratio of 1-day returns against 1-bar returns, over a rolling window (hours) */
export const vrOf = (c: Ctx, windowH: number) => cached(c, `vr${H(c, windowH)}`, () => varianceRatio(lrets(c), Math.max(2, H(c, 24)), H(c, windowH)).vr);
/** the rolling Hurst exponent (rescaled range) of 1-bar returns over ~500 bars, refreshed every day of bars, known at each bar's close */
export const hurstOf = (c: Ctx) =>
  cached(c, 'hurst', () => {
    const lr = lrets(c);
    const n = lr.length;
    const w = Math.min(500, Math.max(200, H(c, 720)));
    const every = Math.max(1, H(c, 24));
    const out = new Float64Array(n).fill(NaN);
    let last = NaN;
    for (let i = 0; i < n; i++) {
      if (i >= w && (i - w) % every === 0) {
        const seg: number[] = [];
        for (let k = i - w + 1; k <= i; k++) if (Number.isFinite(lr[k])) seg.push(lr[k]);
        last = seg.length > 100 ? hurstRS(seg) : NaN;
      }
      out[i] = last;
    }
    return out;
  });
/** the two-state regime model (Hamilton), fitted on the training bars */
export function hmmOf(c: Ctx): Hmm2 | null {
  return cached(c, 'hmm', () => {
    const lr = lrets(c);
    const end = Math.min(c.trainEnd, lr.length);
    return end > 400 ? trainedOnce(c, 'hmm', () => fitHmm2(lr.slice(Math.max(1, end - 6000), end))) : null;
  });
}
/** P(turbulent regime) at each bar, filtered forward (uses returns up to that bar only) */
export const hmmProb = (c: Ctx) =>
  cached(c, 'hmmP', () => {
    const m = hmmOf(c);
    return m ? hmmFilter(m, Float64Array.from(lrets(c), (x) => (Number.isFinite(x) ? x : 0))) : new Float64Array(c.m.bars.length).fill(NaN);
  });
/** rolling beta of the coin to the benchmark (bitcoin) over 30 days, from returns up to each bar */
export function benchBeta(c: Ctx): Float64Array | null {
  return cached(c, 'beta', () => {
    const bm = c.m.bench;
    if (!bm) return null;
    const n = c.m.bars.length;
    const w = H(c, 720);
    const y = lrets(c);
    const out = new Float64Array(n).fill(NaN);
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let k = 0;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const x = Math.log(bm[i] / bm[i - 1]);
      const ok = Number.isFinite(x) && Number.isFinite(y[i]);
      xs[i] = ok ? x : 0;
      ys[i] = ok ? y[i] : 0;
      sx += xs[i];
      sy += ys[i];
      sxx += xs[i] * xs[i];
      sxy += xs[i] * ys[i];
      k++;
      if (k > w) {
        const j = i - w;
        sx -= xs[j];
        sy -= ys[j];
        sxx -= xs[j] * xs[j];
        sxy -= xs[j] * ys[j];
        k = w;
      }
      const d = k * sxx - sx * sx;
      if (k >= w && d > 0) out[i] = (k * sxy - sx * sy) / d;
    }
    return out;
  });
}

/** the benchmark's (bitcoin's) close with gaps filled forward; null when there is none */
const benchFilled = (c: Ctx) =>
  cached(c, 'benchF', () => {
    const b = c.m.bench;
    if (!b) return null;
    const out = new Float64Array(b.length).fill(NaN);
    let last = NaN;
    for (let i = 0; i < b.length; i++) {
      if (Number.isFinite(b[i]) && b[i] > 0) last = b[i];
      out[i] = last;
    }
    return out;
  });

/** the highest (sign 1) or lowest (sign −1) of the n values BEFORE each one */
function extremePrev(x: ArrayLike<number>, n: number, sign: 1 | -1): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < x.length; i++) {
    while (dq.length && dq[0] < i - n) dq.shift();
    if (i >= n && dq.length) out[i] = x[dq[0]];
    while (dq.length && (x[dq[dq.length - 1]] - x[i]) * sign <= 0) dq.pop();
    dq.push(i);
  }
  return out;
}

/**
 * The coin against bitcoin over a rolling window: regress log price on
 * bitcoin's log price and read where today's price sits against the line, in
 * standard deviations of the fit (z), with the fit's R². Each value uses the
 * window ending at that bar only.
 */
export function pairZ(c: Ctx, windowH: number): { z: Float64Array; r2: Float64Array; beta: Float64Array } | null {
  return cached(c, `pairZ${H(c, windowH)}`, () => {
    const bm = benchFilled(c);
    if (!bm) return null;
    const cl = close(c);
    const n = cl.length;
    const w = Math.max(20, H(c, windowH));
    const z = new Float64Array(n).fill(NaN);
    const r2 = new Float64Array(n).fill(NaN);
    const beta = new Float64Array(n).fill(NaN);
    // centred on the first usable pair, so the rolling sums stay well conditioned
    let x0 = NaN;
    let y0 = NaN;
    const xs = new Float64Array(n);
    const ys = new Float64Array(n);
    const ok = new Uint8Array(n);
    let k = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    let syy = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isFinite(bm[i]) && bm[i] > 0 && cl[i] > 0) {
        if (!Number.isFinite(x0)) {
          x0 = Math.log(bm[i]);
          y0 = Math.log(cl[i]);
        }
        xs[i] = Math.log(bm[i]) - x0;
        ys[i] = Math.log(cl[i]) - y0;
        ok[i] = 1;
        k++;
        sx += xs[i];
        sy += ys[i];
        sxx += xs[i] * xs[i];
        sxy += xs[i] * ys[i];
        syy += ys[i] * ys[i];
      }
      const j = i - w;
      if (j >= 0 && ok[j]) {
        k--;
        sx -= xs[j];
        sy -= ys[j];
        sxx -= xs[j] * xs[j];
        sxy -= xs[j] * ys[j];
        syy -= ys[j] * ys[j];
      }
      if (k < w || !ok[i]) continue;
      const mx = sx / k;
      const my = sy / k;
      const vxx = sxx / k - mx * mx;
      const vxy = sxy / k - mx * my;
      const vyy = syy / k - my * my;
      if (!(vxx > 1e-12) || !(vyy > 1e-12)) continue;
      const b = vxy / vxx;
      const sse = Math.max(0, vyy - b * vxy) * k;
      const sd = Math.sqrt(sse / (k - 2));
      beta[i] = b;
      r2[i] = Math.min(1, (vxy * vxy) / (vxx * vyy));
      if (sd > 1e-9) z[i] = (ys[i] - my - b * (xs[i] - mx)) / sd;
    }
    return { z, r2, beta };
  });
}

/**
 * The trend composite's score in −1 … +1: one vote each from price and volume
 * indicators over several horizons (`unit` hours stand for one "day" of the
 * published daily indicators).
 */
export function trendScore(c: Ctx, unit: number): Float64Array {
  return cached(c, `ctrend${unit}:${c.m.tfH}`, () => {
    const b = c.m.bars;
    const n = b.length;
    const cl = close(c);
    const U = (d: number) => Math.max(2, Math.round((d * unit) / c.m.tfH));
    const votes: (Float64Array | Int8Array)[] = [];
    const push = (f: (i: number) => number) => {
      const v = new Float64Array(n);
      for (let i = 0; i < n; i++) v[i] = f(i);
      votes.push(v);
    };
    // oscillators: RSI, stochastic %K, commodity channel index
    const rs = rsi(cl, U(14));
    push((i) => (Number.isFinite(rs[i]) ? sgn(rs[i] - 50) : NaN));
    const hh = extremePrev(Float64Array.from(b, (x) => x.high), U(14), 1);
    const ll = extremePrev(Float64Array.from(b, (x) => x.low), U(14), -1);
    push((i) => {
      const hi = Math.max(hh[i], b[i].high);
      const lo = Math.min(ll[i], b[i].low);
      return Number.isFinite(hi) && Number.isFinite(lo) && hi > lo ? sgn((cl[i] - lo) / (hi - lo) - 0.5) : NaN;
    });
    const tp = Float64Array.from(b, (x) => (x.high + x.low + x.close) / 3);
    const tpm = sma(tp, U(20));
    push((i) => (Number.isFinite(tpm[i]) ? sgn(tp[i] - tpm[i]) : NaN));
    // price against its averages over seven horizons
    for (const d of [3, 5, 10, 20, 50, 100, 200]) {
      const m = sma(cl, U(d));
      push((i) => (Number.isFinite(m[i]) ? sgn(cl[i] - m[i]) : NaN));
    }
    // MACD and its signal line
    const ef = ema(cl, U(12));
    const es = ema(cl, U(26));
    const macd = Float64Array.from(ef, (x, i) => x - es[i]);
    const sig = ema(Float64Array.from(macd, (x) => (Number.isFinite(x) ? x : 0)), U(9));
    push((i) => (Number.isFinite(macd[i]) ? sgn(macd[i]) : NaN));
    push((i) => (Number.isFinite(macd[i]) && Number.isFinite(sig[i]) ? sgn(macd[i] - sig[i]) : NaN));
    // volume: rising volume confirms the direction price took over the same stretch
    const vol = Float64Array.from(b, (x) => x.volume);
    for (const [a, l] of [[3, 20], [5, 50], [10, 100]] as const) {
      const va = sma(vol, U(a));
      const vl = sma(vol, U(l));
      const r = retN(cl, U(a));
      push((i) => (Number.isFinite(va[i]) && Number.isFinite(vl[i]) && Number.isFinite(r[i]) ? (va[i] > vl[i] ? sgn(r[i]) : 0) : NaN));
    }
    // Chaikin money flow: where closes sit in their ranges, weighted by volume
    const mfv = Float64Array.from(b, (x) => (x.high > x.low ? ((x.close - x.low - (x.high - x.close)) / (x.high - x.low)) * x.volume : 0));
    const mfS = sma(mfv, U(20));
    push((i) => (Number.isFinite(mfS[i]) ? sgn(mfS[i]) : NaN));
    // Bollinger bands: a close outside them
    const bm = sma(cl, U(20));
    const bs = rstd(cl, U(20));
    push((i) => (Number.isFinite(bm[i]) && Number.isFinite(bs[i]) ? (cl[i] > bm[i] + 2 * bs[i] ? 1 : cl[i] < bm[i] - 2 * bs[i] ? -1 : 0) : NaN));
    const out = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      let s = 0;
      let k = 0;
      for (const v of votes)
        if (Number.isFinite(v[i])) {
          s += v[i];
          k++;
        }
      // every indicator must have its history: a score from the short ones alone is a different measure
      if (k === votes.length) out[i] = s / k;
    }
    return out;
  });
}
export const TREND_VOTES = 17;

const state = (n: number) => new Int8Array(n);
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export interface SignalDef {
  id: string;
  name: string;
  family: Family;
  papers: string[];
  /** why it should work: the economic story */
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  /** reads bitcoin's price beside the coin's: BTC must be among the coins tested (and it never trades BTC itself) */
  needsBench?: boolean;
  /** only meaningful on bars shorter than a day */
  intraday?: boolean;
  /** exits that suit the rule (the search varies them) */
  exit: Partial<ExitSpec>;
  compute: (c: Ctx, p: Params) => Int8Array;
  describe: (p: Params) => string;
}

export interface FilterDef {
  id: string;
  name: string;
  papers: string[];
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  /** it reads bitcoin's price when the market has it (and the coin's own otherwise) */
  usesBench?: boolean;
  compute: (c: Ctx, p: Params) => { long: Uint8Array; short: Uint8Array };
  describe: (p: Params) => string;
}

const hrs = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24}-day` : `${h}-hour`);

// ---------- features for the learned rules and the meta-labeller ----------

export const FEATURES = ['ret 1h', 'ret 4h', 'ret 1d', 'ret 1w', 'price / 1w MA', 'RSI 14', 'ADX 14', 'vol 1d / vol 30d', 'volume z', 'hour (sin)', 'hour (cos)', 'weekday', 'funding (a year)', 'GARCH σ next bar', 'GARCH σ / long run', ...CANDLE_FEATURES, 'Kalman slope t', 'OU s-score (1w)', 'variance ratio (2w)', 'P(turbulent regime)', 'Yang–Zhang / GARCH σ'];

export function features(c: Ctx): Float64Array[] {
  return cached(c, 'features', () => {
    const cl = close(c);
    const r1 = retN(cl, H(c, 1));
    const r4 = retN(cl, H(c, 4));
    const r24 = retN(cl, H(c, 24));
    const r168 = retN(cl, H(c, 168));
    const ma = smaH(c, 168);
    const rs = rsi(cl, 14);
    const ad = adx(c.m.bars, 14);
    const v1 = rvol(cl, H(c, 24));
    const v30 = rvol(cl, H(c, 720));
    // until 30 days of bars exist (a short download), compare with the last week instead
    const v7 = rvol(cl, H(c, 168));
    const vz = volZ(c.m.bars, H(c, 168));
    const fa = fundAnn(c, 24);
    const gs = garchSigma(c);
    const g = garchOf(c);
    const lrun = g ? Math.sqrt(g.longRun) : NaN;
    const shape = candleShape(c.m.bars, atr14(c));
    const kf = kalmanOf(c, 1);
    const ou = ouOf(c, 168).s;
    const vr = vrOf(c, 336);
    const hp = hmmProb(c);
    const yz = cached(c, 'yz', () => volEstimate(c.m.bars, H(c, 24), 'yangZhang'));
    return c.m.bars.map((b, i) => {
      const d = new Date(b.time);
      const h = d.getUTCHours();
      return Float64Array.from([r1[i], r4[i], r24[i], r168[i], cl[i] / ma[i] - 1, rs[i] / 100, ad[i] / 100, v30[i] > 0 ? v1[i] / v30[i] : v7[i] > 0 ? v1[i] / v7[i] : NaN, vz[i], Math.sin((h / 24) * 2 * Math.PI), Math.cos((h / 24) * 2 * Math.PI), d.getUTCDay() / 6, fa ? fa[i] : 0, gs[i] * 100, Number.isFinite(lrun) && lrun > 0 ? gs[i] / lrun : 1, ...shape[i], kf.slopeSd[i] > 0 ? kf.slope[i] / kf.slopeSd[i] : NaN, Number.isFinite(ou[i]) ? ou[i] : 0, Number.isFinite(vr[i]) ? vr[i] : 1, hp[i], gs[i] > 0 ? yz[i] / gs[i] : NaN]);
    });
  });
}
const finiteRow = (r: Float64Array) => r.every(Number.isFinite);

/**
 * Models fitted on the same training bars are the same model: kept here so a
 * strategy re-run on a simulated continuation of the same history (the
 * GARCH worlds) predicts with its model instead of fitting it again.
 */
const trained = new Map<string, unknown>();
function trainedOnce<T>(c: Ctx, what: string, fit: () => T): T {
  const b = c.m.bars;
  const e = Math.min(c.trainEnd, b.length) - 1;
  if (e < 1) return fit();
  const key = `${what}|${c.m.coin}|${c.m.tfH}|${c.seed}|${c.trainEnd}|${b[0].time}|${b[e].time}|${b[e].close}|${b.length > c.trainEnd ? 'cut' : 'all'}`;
  if (!trained.has(key)) {
    if (trained.size > 200) trained.delete(trained.keys().next().value as string);
    trained.set(key, fit());
  }
  return trained.get(key) as T;
}

/** learned rules: fit on bars before trainEnd whose label is known by then */
function learnedSignal(c: Ctx, p: Params, kind: 'ols' | 'rf' | 'nn'): Int8Array {
  const n = c.m.bars.length;
  const out = state(n);
  const h = H(c, p.horizon);
  const X = features(c);
  const cl = close(c);
  // the network's size can be set (the Quant desk's NNET panel sends its own): two hidden layers
  const hidden: [number, number] = [p.h1 > 0 ? Math.round(p.h1) : 16, p.h2 > 0 ? Math.round(p.h2) : 8];
  const model = trainedOnce<{ ols: Ridge; sd: number } | { rf: ForestModel } | { nn: MLP } | null>(c, `${kind}:${h}${kind === 'nn' ? `:${hidden.join('x')}` : ''}`, () => {
    const rows: number[][] = [];
    const ys: number[] = [];
    const step = Math.max(1, Math.floor(c.trainEnd / 4000));
    for (let i = 0; i + h < c.trainEnd; i += step) {
      if (!finiteRow(X[i])) continue;
      rows.push(Array.from(X[i]));
      ys.push(cl[i + h] / cl[i] - 1);
    }
    if (rows.length < 200) return null;
    if (kind === 'ols') {
      const m = fitRidge(rows, ys, 0.01);
      const fit = rows.map((r) => predictRidge(m, r));
      return { ols: m, sd: Math.sqrt(fit.reduce((a, b) => a + b * b, 0) / fit.length) || 1e-9 };
    }
    if (kind === 'nn') return { nn: fitMLP(rows, ys.map((y) => (y > 0 ? 1 : 0)), { hidden, epochs: 40, seed: c.seed, patience: 6 }) };
    return { rf: fitForest(rows, ys.map((y) => (y > 0 ? 1 : 0)), { trees: 40, maxDepth: 5, minLeaf: 20, seed: c.seed }) };
  });
  if (!model) return out;
  if ('nn' in model) {
    const m = model.nn;
    for (let i = 0; i < n; i++) {
      if (!finiteRow(X[i])) continue;
      const pr = predictMLP(m, X[i]);
      out[i] = pr > 0.5 + p.edge ? 1 : pr < 0.5 - p.edge ? -1 : 0;
    }
    return out;
  }
  if (kind === 'ols' && 'ols' in model) {
    const m = model.ols;
    const sd = model.sd;
    for (let i = 0; i < n; i++) {
      if (!finiteRow(X[i])) continue;
      const f = predictRidge(m, Array.from(X[i]));
      out[i] = Math.abs(f) > p.q * sd ? sgn(f) : 0;
    }
    return out;
  }
  if (!('rf' in model)) return out;
  const m = model.rf;
  for (let i = 0; i < n; i++) {
    if (!finiteRow(X[i])) continue;
    const pr = predictForest(m, Array.from(X[i]));
    out[i] = pr > 0.5 + p.edge ? 1 : pr < 0.5 - p.edge ? -1 : 0;
  }
  return out;
}

// ---------- the signals ----------

export const SIGNALS: SignalDef[] = [
  {
    id: 'tsmom',
    name: 'Time-series momentum',
    family: 'momentum',
    papers: ['mop12', 'lt21', 'ks151'],
    rationale: 'Investors under-react to news and attention arrives slowly, so a coin that has risen over the past days to weeks tends to keep rising (and fallers keep falling).',
    grid: { lookback: [24, 72, 168, 336, 720] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.lookback));
      return Int8Array.from(r, (x) => (Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `long when the last ${hrs(p.lookback)} return is positive, short when negative`,
  },
  {
    id: 'mac',
    name: 'Moving-average crossover',
    family: 'trend',
    papers: ['blr92', 'ks151', 'gas20', 'cels19'],
    rationale: 'A fast average above a slow one marks a trend the market is still pricing in; the rule rides it and steps aside when it turns.',
    grid: { fast: [12, 24, 50], slow: [100, 200, 400] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const f = smaH(c, p.fast);
      const s = smaH(c, p.slow);
      return Int8Array.from(f, (x, i) => (Number.isFinite(x) && Number.isFinite(s[i]) ? sgn(x - s[i]) : 0));
    },
    describe: (p) => `long while the ${hrs(p.fast)} average is above the ${hrs(p.slow)} average, short while below`,
  },
  {
    id: 'tma',
    name: 'Three moving averages',
    family: 'trend',
    papers: ['ks151'],
    rationale: 'Requiring three averages in order (fast > middle > slow) trades only established trends and filters the whipsaws of a single crossover.',
    grid: { set: [0, 1, 2] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      const f = smaH(c, a);
      const m = smaH(c, b);
      const s = smaH(c, d);
      return Int8Array.from(f, (x, i) => (x > m[i] && m[i] > s[i] ? 1 : x < m[i] && m[i] < s[i] ? -1 : 0));
    },
    describe: (p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      return `long when the ${hrs(a)} > ${hrs(b)} > ${hrs(d)} averages line up, short when they line up downward`;
    },
  },
  {
    id: 'maratio',
    name: 'Price-to-moving-average ratio',
    family: 'trend',
    papers: ['dlszz21'],
    rationale: 'With hard-to-value fundamentals, traders learn from price itself: the gap between price and its average carries information that is priced in slowly.',
    grid: { lookback: [168, 336, 720], band: [0, 0.02, 0.05] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (!Number.isFinite(m[i]) ? 0 : x / m[i] - 1 > p.band ? 1 : x / m[i] - 1 < -p.band ? -1 : 0));
    },
    describe: (p) => `long when price is more than ${(p.band * 100).toFixed(0)}% above its ${hrs(p.lookback)} average, short when as far below`,
  },
  {
    id: 'donchian',
    name: 'Channel breakout',
    family: 'breakout',
    papers: ['blr92', 'faith07', 'ks151', 'hu21'],
    rationale: 'A close beyond the range of the last N bars shows new information or forced buying/selling that the range did not hold; breakouts in crypto tend to extend.',
    grid: { n: [20, 55, 120, 240] },
    exit: { stopAtr: 2, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.n);
      const hi = cached(c, `hi${n}`, () => hiPrev(c.m.bars, n));
      const lo = cached(c, `lo${n}`, () => loPrev(c.m.bars, n));
      const out = state(c.m.bars.length);
      let s = 0;
      c.m.bars.forEach((b, i) => {
        if (b.close > hi[i]) s = 1;
        else if (b.close < lo[i]) s = -1;
        out[i] = s;
      });
      return out;
    },
    describe: (p) => `long after a close above the prior ${hrs(p.n)} high, short after a close below the prior ${hrs(p.n)} low`,
  },
  {
    id: 'pivot',
    name: 'Support and resistance (pivot points)',
    family: 'breakout',
    papers: ['ks151'],
    rationale: "Floor traders' pivot levels from yesterday's high, low and close are watched by many; a close through resistance or support triggers follow-through.",
    grid: { level: [1, 2] },
    intraday: true,
    exit: { stopAtr: 1.5, maxBars: 24, onFlip: true },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let day = -1;
      let dh = -Infinity;
      let dl = Infinity;
      let dc = NaN;
      let piv: [number, number] | null = null;
      c.m.bars.forEach((b, i) => {
        const d = Math.floor(b.time / 86_400_000);
        if (d !== day) {
          if (day >= 0 && Number.isFinite(dc)) {
            const P = (dh + dl + dc) / 3;
            piv = p.level === 1 ? [2 * P - dh, 2 * P - dl] : [P - (dh - dl), P + (dh - dl)];
          }
          day = d;
          dh = -Infinity;
          dl = Infinity;
        }
        if (piv) out[i] = b.close > piv[1] ? 1 : b.close < piv[0] ? -1 : 0;
        dh = Math.max(dh, b.high);
        dl = Math.min(dl, b.low);
        dc = b.close;
      });
      return out;
    },
    describe: (p) => `long on a close above yesterday's R${p.level} pivot resistance, short on a close below S${p.level} support`,
  },
  {
    id: 'zrev',
    name: 'Mean reversion (z-score)',
    family: 'reversion',
    papers: ['ks151', 'jeg90', 'lm90'],
    rationale: 'Short-horizon overreaction and liquidity demands push price too far from its average; liquidity providers are paid to take the other side as it reverts.',
    grid: { lookback: [24, 72, 168], k: [1.5, 2, 2.5] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => {
        const z = s[i] > 0 ? (x - m[i]) / s[i] : 0;
        return z < -p.k ? 1 : z > p.k ? -1 : 0;
      });
    },
    describe: (p) => `buy ${p.k} standard deviations below the ${hrs(p.lookback)} average, sell ${p.k} above`,
  },
  {
    id: 'rsi2',
    name: 'RSI extremes',
    family: 'reversion',
    papers: ['ca09', 'wil78'],
    rationale: 'Very short-term oversold readings mark capitulation by impatient sellers; the bounce rewards the buyer who supplies liquidity.',
    grid: { n: [2, 3, 14], band: [10, 20, 30] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const r = cached(c, `rsi${p.n}`, () => rsi(close(c), p.n));
      return Int8Array.from(r, (x) => (x < p.band ? 1 : x > 100 - p.band ? -1 : 0));
    },
    describe: (p) => `buy when RSI(${p.n}) is under ${p.band}, sell when over ${100 - p.band}`,
  },
  {
    id: 'bbreak',
    name: 'Bollinger band breakout',
    family: 'breakout',
    papers: ['bol01', 'hu21'],
    rationale: 'A close outside two-sigma bands marks a volatility expansion; in trending crypto markets expansions tend to continue rather than revert.',
    grid: { lookback: [20, 50, 100], k: [2, 2.5] },
    exit: { stopAtr: 2, maxBars: 120, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (x > m[i] + p.k * s[i] ? 1 : x < m[i] - p.k * s[i] ? -1 : 0));
    },
    describe: (p) => `long on a close above the upper ${p.k}σ band of the ${hrs(p.lookback)} average, short below the lower band`,
  },
  {
    id: 'macd',
    name: 'MACD trend',
    family: 'trend',
    papers: ['app05', 'hu21'],
    rationale: 'The gap between fast and slow exponential averages measures trend acceleration; its sign against its own signal line times entries in the trend.',
    grid: { scale: [1, 4, 24] },
    exit: { stopAtr: 2.5, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const f = ema(cl, H(c, 12 * p.scale));
      const s = ema(cl, H(c, 26 * p.scale));
      const macd = f.map((x, i) => x - s[i]);
      const sig = ema(Float64Array.from(macd, (x) => (Number.isFinite(x) ? x : 0)), H(c, 9 * p.scale));
      return Int8Array.from(macd, (x, i) => (Number.isFinite(x) && Number.isFinite(sig[i]) ? sgn(x - sig[i]) : 0));
    },
    describe: (p) => `long while MACD(${12 * p.scale}, ${26 * p.scale}) is above its ${9 * p.scale}-hour signal line, short while below`,
  },
  {
    id: 'itsm',
    name: 'Intraday time-series momentum',
    family: 'momentum',
    papers: ['suw22', 'wbxz22'],
    rationale: "Late-day traders (and those hedging the day's move) trade in the direction of the day so far, so the day's return predicts its final hours.",
    grid: { hour: [20, 21, 22] },
    intraday: true,
    exit: { stopAtr: 2, maxBars: 3, onFlip: false },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let open = NaN;
      c.m.bars.forEach((b, i) => {
        const h = new Date(b.time).getUTCHours();
        if (h === 0) open = b.open;
        // the bar that closes at hour p.hour (on 4-hour candles: the last one closing by then)
        if (h + c.m.tfH === Math.floor(p.hour / c.m.tfH) * c.m.tfH && Number.isFinite(open)) out[i] = sgn(b.close / open - 1);
      });
      return out;
    },
    describe: (p) => `at ${p.hour}:00 UTC, trade the day's direction so far into the close`,
  },
  {
    id: 'dow',
    name: 'Monday effect',
    family: 'seasonal',
    papers: ['cp19', 'bcgl19'],
    rationale: "Bitcoin's returns were reported higher on Mondays as weekday flows return after the weekend; the Lab tests whether it survives.",
    grid: { day: [1] },
    intraday: true,
    exit: { stopAtr: 3, maxBars: 24, onFlip: false },
    compute: (c) => {
      const out = state(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const t = new Date(b.time + c.m.tfH * 3_600_000);
        if (t.getUTCDay() === 1 && t.getUTCHours() === 0) out[i] = 1;
      });
      return out;
    },
    describe: () => 'long from Monday 00:00 UTC for the day',
  },
  {
    id: 'wrev',
    name: 'Weekly reversal',
    family: 'reversion',
    papers: ['dob23', 'jeg90'],
    rationale: "Last week's biggest moves partly reverse as overreaction fades, while two-to-four-week trends continue.",
    grid: { band: [0.05, 0.1, 0.15] },
    exit: { stopAtr: 3, targetR: 2, maxBars: 168, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, 168));
      return Int8Array.from(r, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `fade a week's move of more than ${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'carry',
    name: 'Funding carry',
    family: 'carry',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When leveraged longs pay high funding, shorting the perpetual collects the payment and leans against a crowded trade; negative funding pays longs.',
    grid: { lookback: [24, 72], band: [0.1, 0.25] },
    needsFunding: true,
    exit: { stopAtr: 3, maxBars: 168, onFlip: true },
    compute: (c, p) => {
      const f = fundAnn(c, p.lookback);
      if (!f) return state(c.m.bars.length);
      return Int8Array.from(f, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `short when funding averages more than ${(p.band * 100).toFixed(0)}% a year over ${hrs(p.lookback)}, long when below −${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'volbrk',
    name: 'Volume-confirmed move',
    family: 'volume',
    papers: ['lmsw02', 'beo94'],
    rationale: 'A price move on unusually heavy volume is more likely informed and continues; the same move on light volume says little.',
    grid: { n: [1, 4, 24], k: [1.5, 2.5] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.n));
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      return Int8Array.from(r, (x, i) => (vz[i] > p.k && Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `trade the ${hrs(p.n)} move when volume is ${p.k} standard deviations above normal`,
  },
  {
    id: 'vsmom',
    name: 'Volatility-scaled momentum (GARCH)',
    family: 'momentum',
    papers: ['mop12', 'boll86', 'lt21'],
    rationale: 'A move only says something when it is large against the volatility expected for it: scaling the trend by GARCH volatility trades significant moves and ignores noise in a storm.',
    grid: { lookback: [24, 72, 168], k: [0.5, 1, 1.5] },
    exit: { stopAtr: 3, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.lookback);
      const cl = close(c);
      const gs = garchSigma(c);
      const out = state(cl.length);
      for (let i = n; i < cl.length; i++) {
        // the GARCH volatility expected over those n bars, as of their start
        const z = Math.log(cl[i] / cl[i - n]) / (gs[i - n] * Math.sqrt(n));
        out[i] = Number.isFinite(z) ? (z > p.k ? 1 : z < -p.k ? -1 : 0) : 0;
      }
      return out;
    },
    describe: (p) => `long when the ${hrs(p.lookback)} return is more than ${p.k} GARCH standard deviations up, short when as far down`,
  },
  {
    id: 'kalman',
    name: 'Kalman-filter trend',
    family: 'trend',
    papers: ['kal60', 'har90'],
    rationale: 'A Kalman filter separates a trend from the noise around it and says how sure it is of the slope: trade only when the filtered slope is clearly away from zero, which ignores the whipsaws moving averages fall for.',
    grid: { smooth: [0, 1, 2], k: [1, 2, 3] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const kf = kalmanOf(c, p.smooth);
      return Int8Array.from(kf.slope, (s, i) => {
        const t = kf.slopeSd[i] > 0 ? s / kf.slopeSd[i] : 0;
        return t > p.k ? 1 : t < -p.k ? -1 : 0;
      });
    },
    describe: (p) => `long when the Kalman-filtered trend slope (${['smoothest', 'smooth', 'responsive'][p.smooth]}) is more than ${p.k} standard errors above zero, short when as far below`,
  },
  {
    id: 'ou',
    name: 'Ornstein–Uhlenbeck reversion',
    family: 'reversion',
    papers: ['uo30', 'al10', 'ber10'],
    rationale: 'Fit a mean-reverting (Ornstein–Uhlenbeck) process to the price over a window; when the process reverts quickly and price sits far from its equilibrium in its own standard deviations (the s-score), bet on the pull back.',
    grid: { window: [72, 168, 336], k: [1.5, 2] },
    exit: { stopAtr: 2, maxBars: 72, onFlip: false },
    compute: (c, p) => {
      const o = ouOf(c, p.window);
      const maxHL = H(c, p.window) / 4;
      return Int8Array.from(o.s, (s, i) => (Number.isFinite(s) && o.halfLife[i] < maxHL ? (s < -p.k ? 1 : s > p.k ? -1 : 0) : 0));
    },
    describe: (p) => `fit an Ornstein–Uhlenbeck process over ${hrs(p.window)}; when it reverts fast (half-life under a quarter of the window), long below −${p.k} s-score, short above +${p.k}`,
  },
  {
    id: 'vwmom',
    name: 'Volume-weighted momentum',
    family: 'momentum',
    papers: ['h24', 'mop12', 'lmsw02'],
    rationale: 'Momentum where each candle counts by its volume: a move made on heavy trading carries more information than the same move on a quiet market, and in crypto the volume-weighted trend has been the stronger predictor.',
    grid: { lookback: [24, 72, 168, 336] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.lookback);
      const lr = lrets(c);
      const b = c.m.bars;
      const out = state(b.length);
      let sv = 0;
      let s = 0;
      const w = (i: number) => (Number.isFinite(lr[i]) && b[i].volume > 0 ? b[i].volume : 0);
      for (let i = 1; i < b.length; i++) {
        sv += w(i) * (Number.isFinite(lr[i]) ? lr[i] : 0);
        s += w(i);
        if (i > n) {
          sv -= w(i - n) * (Number.isFinite(lr[i - n]) ? lr[i - n] : 0);
          s -= w(i - n);
        }
        if (i >= n && s > 0) out[i] = sgn(sv / s);
      }
      return out;
    },
    describe: (p) => `long when the volume-weighted return of the last ${hrs(p.lookback)} is positive, short when negative`,
  },
  {
    id: 'ctrend',
    name: 'Trend composite (17 indicators)',
    family: 'trend',
    papers: ['flpwz25', 'hu21', 'app05'],
    rationale: 'No single indicator is reliable, but together they are: RSI, stochastic, CCI, price against seven moving averages, MACD, volume trends, money flow and Bollinger bands each cast one vote. The published crypto trend factor weights such indicators by machine learning across thousands of coins; here each gets an equal vote on one coin.',
    grid: { unit: [24, 4], k: [0.3, 0.6] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => Int8Array.from(trendScore(c, p.unit), (x) => (Number.isFinite(x) ? (x > p.k ? 1 : x < -p.k ? -1 : 0) : 0)),
    describe: (p) => `${TREND_VOTES} price and volume indicators vote (${p.unit === 24 ? 'daily horizons, 3 to 200 days' : `horizons of ${3 * p.unit} to ${200 * p.unit} hours`}); long when the balance of votes is above ${Math.round(p.k * 100)} %, short below −${Math.round(p.k * 100)} %`,
  },
  {
    id: 'maxmin',
    name: 'New high / new low',
    family: 'breakout',
    papers: ['pv22', 'hu21'],
    rationale: 'In bitcoin, a close at a new 10-day high tended to be followed by more gains (trend), and a close at a new 10-day low by a bounce (panic selling exhausts itself). Both are buys — the rule never shorts.',
    grid: { n: [240, 480], mode: [0, 1, 2] },
    exit: { stopAtr: 3, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const n = H(c, p.n);
      const cl = close(c);
      const hi = cached(c, `chi${n}`, () => extremePrev(cl, n, 1));
      const lo = cached(c, `clo${n}`, () => extremePrev(cl, n, -1));
      return Int8Array.from(cl, (x, i) => ((p.mode !== 2 && x > hi[i]) || (p.mode !== 1 && x < lo[i]) ? 1 : 0));
    },
    describe: (p) => (p.mode === 1 ? `buy a close at a new ${hrs(p.n)} high` : p.mode === 2 ? `buy a close at a new ${hrs(p.n)} low (the bounce)` : `buy a close at a new ${hrs(p.n)} high (trend) or a new ${hrs(p.n)} low (bounce)`),
  },
  {
    id: 'jump',
    name: 'Big-day follow-through',
    family: 'momentum',
    papers: ['luwz21', 'cp19o'],
    rationale: 'In crypto an extreme day tends to be followed, not faded: coins with the biggest daily jumps went on to earn more, and fading abnormal days lost money. The published profit could not be told from luck after costs, so the Lab tests it on your coins before it is believed.',
    grid: { k: [2, 2.5, 3] },
    exit: { stopAtr: 2.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const d = H(c, 24);
      const cl = close(c);
      const r = retN(cl, d);
      const sd = cached(c, `jsd${d}`, () => rstd(Float64Array.from(r, (x) => (Number.isFinite(x) ? x : 0)), H(c, 720)));
      const out = state(cl.length);
      // the day's move against the spread of daily moves as it stood a day earlier
      for (let i = d + H(c, 720); i < cl.length; i++) {
        const z = sd[i - d] > 0 ? r[i] / sd[i - d] : 0;
        out[i] = z > p.k ? 1 : z < -p.k ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `after a 1-day move of more than ${p.k} standard deviations (of the last 30 days), trade in its direction for a day`,
  },
  {
    id: 'night',
    name: 'Late-evening hours (21:00–23:00 UTC)',
    family: 'seasonal',
    papers: ['pv22', 'bcgl19'],
    rationale: "Bitcoin's returns were concentrated in two hours late in the US day, 21:00 to 23:00 UTC, in 2015–2021 — and the pattern weakened afterwards. A calendar effect with no clear cause: the Lab tests whether it still holds.",
    grid: { hour: [21, 22] },
    intraday: true,
    exit: { stopAtr: 3, maxBars: 2, onFlip: false },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      const want = (Math.floor(p.hour / c.m.tfH) * c.m.tfH) % 24;
      c.m.bars.forEach((b, i) => {
        if ((new Date(b.time).getUTCHours() + c.m.tfH) % 24 === want) out[i] = 1;
      });
      return out;
    },
    describe: (p) => `buy at ${p.hour}:00 UTC and hold for two hours`,
  },
  {
    id: 'pairs',
    name: 'Pairs: the coin against bitcoin',
    family: 'relative',
    papers: ['ggr06', 'fk20', 'al10'],
    rationale: 'Coins move with bitcoin. When a coin drifts unusually far from where bitcoin says it should be, the gap tends to close: buy the coin when it is cheap against bitcoin, sell when rich. With the bitcoin hedge this is a true pairs trade — the market’s direction cancels out. In crypto the effect showed on hourly and 5-minute candles, not daily ones.',
    grid: { window: [168, 336, 720], k: [1.5, 2] },
    needsBench: true,
    exit: { stopAtr: 2.5, targetR: 1.5, maxBars: 96, onFlip: false },
    compute: (c, p) => {
      const f = pairZ(c, p.window);
      if (!f) return state(c.m.bars.length);
      // only where the coin really tracks bitcoin: a positive slope and a fit that explains half the moves
      return Int8Array.from(f.z, (z, i) => (Number.isFinite(z) && f.beta[i] > 0 && f.r2[i] >= 0.5 ? (z < -p.k ? 1 : z > p.k ? -1 : 0) : 0));
    },
    describe: (p) => `fit the coin against bitcoin over ${hrs(p.window)}; buy when it is more than ${p.k} standard deviations cheap against bitcoin, sell when as rich (only while the two move together)`,
  },
  {
    id: 'btclead',
    name: 'Bitcoin leads, the coin catches up',
    family: 'relative',
    papers: ['gstw24', 'ltw22'],
    rationale: 'News reaches bitcoin first; with limited attention, other coins react late. When bitcoin has moved and a coin has not yet done its share (its usual beta to bitcoin), trade the coin in bitcoin’s direction. Published at horizons of minutes — on hourly candles most of it may already be gone, which the test shows.',
    grid: { n: [1, 4, 24], k: [1, 1.5] },
    needsBench: true,
    exit: { stopAtr: 2, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const bm = benchFilled(c);
      const out = state(c.m.bars.length);
      const beta = benchBeta(c);
      if (!bm || !beta) return out;
      // a one-candle look-back is allowed here: the lead is a short-lived thing
      const n = Math.max(1, Math.round(p.n / c.m.tfH));
      const cl = close(c);
      const gap = new Float64Array(cl.length);
      const lead = new Float64Array(cl.length);
      for (let i = n; i < cl.length; i++) {
        const b = Number.isFinite(beta[i - n]) ? beta[i - n] : NaN;
        lead[i] = Math.log(bm[i] / bm[i - n]);
        const g = b * lead[i] - Math.log(cl[i] / cl[i - n]);
        gap[i] = Number.isFinite(g) ? g : 0;
      }
      const sd = rstd(gap, H(c, 168));
      for (let i = n + H(c, 168); i < cl.length; i++) {
        const z = sd[i - 1] > 0 ? gap[i] / sd[i - 1] : 0;
        // bitcoin moved and the coin lagged it (not: the coin moved alone)
        out[i] = z > p.k && lead[i] > 0 ? 1 : z < -p.k && lead[i] < 0 ? -1 : 0;
      }
      return out;
    },
    describe: (p) => `when bitcoin has moved over ${hrs(p.n)} and the coin is more than ${p.k} standard deviations behind its usual share of that move, trade the coin in bitcoin's direction`,
  },
  {
    id: 'candle',
    name: 'Next-candle forecast',
    family: 'ml',
    papers: ['nis91', 'myr06', 'lsl12', 'bre01'],
    rationale: 'Candle shapes (bodies, wicks, where the close sat in the range, engulfing and hammer patterns) with GARCH volatility and momentum feed a forest that forecasts the next candle; it trades only when its odds are clear.',
    grid: { edge: [0.03, 0.06] },
    exit: { stopAtr: 1.5, targetR: 1.5, maxBars: 6, onFlip: true },
    compute: (c, p) => cached(c, `candle${p.edge}:${c.trainEnd}`, () => learnedSignal(c, { horizon: c.m.tfH, edge: p.edge }, 'rf')),
    describe: (p) => `a random forest on candle shapes, GARCH volatility and momentum forecasts the next candle; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
  {
    id: 'ols',
    name: 'Linear forecast (ridge regression)',
    family: 'ml',
    papers: ['gkx20', 'ks151'],
    rationale: 'A regression of the next return on momentum, reversal, volatility, volume, seasonality and funding combines weak predictors into one forecast (the linear analogue of the 151-strategies bitcoin ANN).',
    grid: { horizon: [4, 24], q: [0.5, 1] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `ols${p.horizon}:${p.q}:${c.trainEnd}`, () => learnedSignal(c, p, 'ols')),
    describe: (p) => `ridge regression of the next ${hrs(p.horizon)} return on ${FEATURES.length} features (momentum, volatility, GARCH, candle shapes, seasonality, funding); trade forecasts beyond ${p.q} standard deviations`,
  },
  {
    id: 'rf',
    name: 'Random-forest direction',
    family: 'ml',
    papers: ['bre01', 'gkx20'],
    rationale: 'Trees find nonlinear interactions between the same features (e.g. momentum only when volatility is low) that a linear forecast misses.',
    grid: { horizon: [4, 24], edge: [0.03, 0.06] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `rf${p.horizon}:${p.edge}:${c.trainEnd}`, () => learnedSignal(c, p, 'rf')),
    describe: (p) => `random forest (40 trees) on ${FEATURES.length} features forecasting the ${hrs(p.horizon)} direction; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
  {
    id: 'nn',
    name: 'Neural-network direction',
    family: 'ml',
    papers: ['gkx20', 'ks151', 'kb15'],
    rationale: 'A small neural network (two hidden layers) learns smooth nonlinear combinations of the same features — the model class Gu, Kelly and Xiu found best for return prediction; early stopping on the latest training data keeps it from memorising.',
    grid: { horizon: [4, 24], edge: [0.03, 0.06] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `nn${p.horizon}:${p.edge}:${p.h1 ?? 16}:${p.h2 ?? 8}:${c.trainEnd}`, () => learnedSignal(c, p, 'nn')),
    describe: (p) => `a neural network (${FEATURES.length} inputs, ${p.h1 ?? 16} and ${p.h2 ?? 8} hidden units) forecasting the ${hrs(p.horizon)} direction; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
];

// ---------- the filters ----------

const allow = (n: number) => ({ long: new Uint8Array(n), short: new Uint8Array(n) });

export const FILTERS: FilterDef[] = [
  {
    id: 'trend',
    name: 'Long-term trend',
    papers: ['fab07', 'blr92'],
    rationale: 'Trade only with the long-term trend: longs above the long average, shorts below — the side with the drift behind it.',
    grid: { lookback: [200, 1200, 4800] },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const a = allow(cl.length);
      cl.forEach((x, i) => {
        a.long[i] = Number.isFinite(m[i]) && x > m[i] ? 1 : 0;
        a.short[i] = Number.isFinite(m[i]) && x < m[i] ? 1 : 0;
      });
      return a;
    },
    describe: (p) => `with the ${hrs(p.lookback)} trend`,
  },
  {
    id: 'volreg',
    name: 'Volatility regime',
    papers: ['mm17', 'bsc15'],
    rationale: 'High volatility does not pay more but crashes trend strategies; calm regimes trade, storms wait (or the reverse for breakouts that need movement).',
    grid: { mode: [0, 1], pct: [0.5, 0.8] },
    compute: (c, p) => {
      const v = cached(c, 'vol24', () => rvol(close(c), H(c, 24)));
      const r = cached(c, 'volrank', () => pctRank(v, H(c, 720)));
      const a = allow(v.length);
      r.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x < p.pct : x > 1 - p.pct);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when 1-day volatility is in the calmest ${p.pct * 100}% of the month` : `only when 1-day volatility is in the busiest ${p.pct * 100}% of the month`),
  },
  {
    id: 'garch',
    name: 'GARCH volatility regime',
    papers: ['boll86', 'mm17', 'hl05'],
    rationale: 'GARCH volatility above its long-run level marks a storm that tends to persist (and mean-revert slowly); trend rules suffer in it, breakouts need it.',
    grid: { mode: [0, 1], ratio: [0.8, 1, 1.25] },
    compute: (c, p) => {
      const gs = garchSigma(c);
      const g = garchOf(c);
      const lr = g ? Math.sqrt(g.longRun) : NaN;
      const a = allow(gs.length);
      gs.forEach((x, i) => {
        const r = Number.isFinite(lr) && lr > 0 ? x / lr : NaN;
        const ok = Number.isFinite(r) && (p.mode === 0 ? r < p.ratio : r > p.ratio);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when GARCH volatility is under ${p.ratio}× its long-run level (calm)` : `only when GARCH volatility is over ${p.ratio}× its long-run level (a storm)`),
  },
  {
    id: 'adx',
    name: 'Trend strength (ADX)',
    papers: ['wil78'],
    rationale: 'Trend rules need a trend and reversion rules need a range; ADX separates the two.',
    grid: { mode: [0, 1], level: [20, 25] },
    compute: (c, p) => {
      const d = cached(c, 'adx14', () => adx(c.m.bars, 14));
      const a = allow(d.length);
      d.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > p.level : x < p.level);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when ADX is above ${p.level} (trending)` : `only when ADX is below ${p.level} (ranging)`),
  },
  {
    id: 'volume',
    name: 'Participation',
    papers: ['beo94'],
    rationale: 'Signals on above-normal volume carry more information than signals in a quiet market.',
    grid: { k: [0, 0.5] },
    compute: (c, p) => {
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      const a = allow(vz.length);
      vz.forEach((x, i) => (a.long[i] = a.short[i] = x > p.k ? 1 : 0));
      return a;
    },
    describe: (p) => `only on volume ${p.k} standard deviations or more above normal`,
  },
  {
    id: 'session',
    name: 'Trading session',
    papers: ['bcgl19', 'wbxz22'],
    rationale: 'Liquidity and informed flow concentrate when the US and European markets are open; signals then are more reliable.',
    grid: { s: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const h = new Date(b.time).getUTCHours();
        const ok = p.s === 0 ? h >= 13 && h < 21 : h >= 7 && h < 16;
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.s === 0 ? 'only in US hours (13–21 UTC)' : 'only in European hours (7–16 UTC)'),
  },
  {
    id: 'crowd',
    name: 'Funding crowding',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When one side pays heavily to hold, it is crowded: do not join it.',
    grid: { band: [0.2, 0.5] },
    needsFunding: true,
    compute: (c, p) => {
      const f = fundAnn(c, 24);
      const n = c.m.bars.length;
      const a = allow(n);
      for (let i = 0; i < n; i++) {
        const x = f ? f[i] : 0;
        a.long[i] = !Number.isFinite(x) || x < p.band ? 1 : 0;
        a.short[i] = !Number.isFinite(x) || x > -p.band ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `no longs when funding is above ${(p.band * 100).toFixed(0)}% a year, no shorts below −${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'btctrend',
    name: 'Bitcoin market trend',
    papers: ['ltw22', 'fab07'],
    rationale: 'Most of a coin’s move is the crypto market’s move, and bitcoin is the market: longs only while bitcoin is above its long average, shorts only while below. (On bitcoin itself this is its own trend.)',
    grid: { lookback: [1200, 4800] },
    usesBench: true,
    compute: (c, p) => {
      const px = benchFilled(c) ?? close(c);
      const m = sma(Float64Array.from(px, (x) => (Number.isFinite(x) ? x : 0)), H(c, p.lookback));
      const a = allow(px.length);
      const from = H(c, p.lookback);
      // the average needs a full window of real prices
      let seen = 0;
      for (let i = 0; i < px.length; i++) {
        seen = Number.isFinite(px[i]) ? seen + 1 : 0;
        const ok = seen >= from && Number.isFinite(m[i]);
        a.long[i] = ok && px[i] > m[i] ? 1 : 0;
        a.short[i] = ok && px[i] < m[i] ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `longs only while bitcoin is above its ${hrs(p.lookback)} average, shorts only while below`,
  },
  {
    id: 'weekday',
    name: 'Weekdays or weekends',
    papers: ['kp21', 'aq19', 'bcgl19'],
    rationale: 'Crypto trades all week but the money does not: at weekends volume and risk are lower and moves follow through less; at the start of the week volatility returns. Trend rules tend to want weekdays, dip-buying the quiet weekend.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        // the day the signal's trade would open on: the bar after this one
        const d = new Date(b.time + c.m.tfH * 3_600_000).getUTCDay();
        const weekend = d === 0 || d === 6;
        a.long[i] = a.short[i] = (p.mode === 0 ? !weekend : weekend) ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only on weekdays (Monday to Friday, UTC)' : 'only at weekends (Saturday and Sunday, UTC)'),
  },
  {
    id: 'vratio',
    name: 'Variance-ratio regime',
    papers: ['lm88', 'hur51'],
    rationale: 'When daily moves are bigger than the sum of hourly ones would suggest (variance ratio above 1), moves persist and trends pay; below 1 they reverse and fading pays. Match the rule to the regime.',
    grid: { mode: [0, 1], window: [336, 720] },
    compute: (c, p) => {
      const vr = vrOf(c, p.window);
      const a = allow(vr.length);
      vr.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > 1.05 : x < 0.95);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only while moves persist: the ${hrs(p.window)} variance ratio of daily to hourly returns is above 1.05 (trending)` : `only while moves reverse: the ${hrs(p.window)} variance ratio is below 0.95 (mean-reverting)`),
  },
  {
    id: 'agree',
    name: 'Forecast agrees',
    papers: ['kal60', 'bre01', 'gkx20', 'nis91'],
    rationale: 'A second opinion: trade only in the direction a forecasting model also expects — the Kalman trend, or a model trained on the in-sample years (next-candle forest, ridge regression, random forest, neural network).',
    grid: { model: [0, 1, 2, 3, 4] },
    compute: (c, p) => {
      const n = c.m.bars.length;
      const a = allow(n);
      let dir: Int8Array;
      if (p.model === 4) dir = SIGNAL_MAP.nn.compute(c, { horizon: p.horizon > 0 ? p.horizon : 24, edge: 0, ...(p.h1 > 0 ? { h1: p.h1, h2: p.h2 > 0 ? p.h2 : Math.max(2, Math.round(p.h1 / 2)) } : {}) });
      else if (p.model === 3) {
        const kf = kalmanOf(c, 1);
        dir = Int8Array.from(kf.slope, (s) => sgn(s));
      } else if (p.model === 0) dir = SIGNAL_MAP.candle.compute(c, { edge: 0 });
      else if (p.model === 1) dir = SIGNAL_MAP.ols.compute(c, { horizon: 24, q: 0 });
      else dir = SIGNAL_MAP.rf.compute(c, { horizon: 24, edge: 0 });
      for (let i = 0; i < n; i++) {
        a.long[i] = dir[i] > 0 ? 1 : 0;
        a.short[i] = dir[i] < 0 ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `only when ${['the next-candle forest', 'the ridge-regression forecast', 'the random-forest forecast', 'the Kalman trend', p.h1 > 0 ? `the neural-network forecast (${p.h1} and ${p.h2 > 0 ? p.h2 : Math.max(2, Math.round(p.h1 / 2))} hidden units${p.horizon > 0 ? `, ${hrs(p.horizon)} ahead` : ''})` : 'the neural-network forecast'][p.model]} points the same way`,
  },
  {
    id: 'hurst',
    name: 'Hurst exponent regime',
    papers: ['hur51', 'lo91'],
    rationale: 'The Hurst exponent measures memory in returns: above 0.5 moves tend to continue (trend rules pay), below 0.5 they tend to reverse (fading pays). Rolling over the last month or two of bars.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const hs = hurstOf(c);
      const a = allow(hs.length);
      hs.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > 0.55 : x < 0.45);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only while returns have memory: the rolling Hurst exponent is above 0.55 (trending)' : 'only while returns reverse: the rolling Hurst exponent is below 0.45 (mean-reverting)'),
  },
  {
    id: 'hmm',
    name: 'Hidden-Markov regime',
    papers: ['ham89', 'at12'],
    rationale: 'A two-state Markov-switching model, fitted in sample, reads the odds that the market is in its calm or its turbulent regime from the returns so far; strategies behave differently in each.',
    grid: { mode: [0, 1] },
    compute: (c, p) => {
      const hp = hmmProb(c);
      const a = allow(hp.length);
      hp.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x < 0.5 : x > 0.5);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? 'only in the calm regime (the hidden-Markov odds of turbulence under 50 %)' : 'only in the turbulent regime (the hidden-Markov odds of turbulence over 50 %)'),
  },
];

export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
export const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

/** every combination of a parameter grid */
export function gridOf(g: Record<string, number[]>): Params[] {
  let out: Params[] = [{}];
  for (const [k, vs] of Object.entries(g)) out = out.flatMap((p) => vs.map((v) => ({ ...p, [k]: v })));
  return out;
}

export const logRet = logRets;
