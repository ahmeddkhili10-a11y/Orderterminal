// Quantitative finance models for the Lab and the terminal's QUANT desk.
//
// Every rolling series here has value i computed from data 0..i only — the
// Lab reads them at a bar's close and trades the next bar's open, so nothing
// looks ahead. Models with parameters (the regime model, the Kalman noise)
// are fitted on the training bars by the caller.
//
//   trend      Kalman local-linear-trend filter; regression trend t-statistic
//   reversion  Ornstein–Uhlenbeck fit on a rolling window: s-score, half-life
//   regime     variance ratio (Lo & MacKinlay), Hurst R/S, a two-state
//              Gaussian hidden Markov model (Hamilton)
//   volatility close-to-close, Parkinson, Garman–Klass, Rogers–Satchell,
//              Yang–Zhang; volatility targeting weights
//   risk       value at risk and expected shortfall (historical, normal,
//              Cornish–Fisher, GARCH) with Kupiec and Christoffersen backtests
//   options    Black–Scholes prices and greeks; a delta-hedging simulator
//   sizing     Kelly fractions
import { errQuantile, garchVar, type GarchFit } from './garch';
import { ncdf, ninv } from './stats';

const nanArr = (n: number) => new Float64Array(n).fill(NaN);
const npdf = (x: number) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// ---------- trend ----------

/**
 * Kalman filter for a local linear trend in log price: level and slope, the
 * slope a random walk (an integrated random walk trend — the Hodrick–Prescott
 * trend, filtered forward). `q` is the slope's noise relative to the
 * observation noise `r` (smaller = smoother). Returns the filtered level,
 * slope (log return per bar) and the slope's standard error.
 */
export function kalmanTrend(y: ArrayLike<number>, q: number, r: number): { level: Float64Array; slope: Float64Array; slopeSd: Float64Array } {
  const n = y.length;
  const level = nanArr(n);
  const slope = nanArr(n);
  const slopeSd = nanArr(n);
  if (!n || !(r > 0)) return { level, slope, slopeSd };
  let l = y[0];
  let s = 0;
  // generous initial uncertainty: the first bars set the state
  let p00 = r * 100;
  let p01 = 0;
  let p11 = r;
  const qs = q * r;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      // predict: l ← l + s, s ← s; P ← F P Fᵀ + Q
      l += s;
      const a = p00 + 2 * p01 + p11;
      const b = p01 + p11;
      p00 = a;
      p01 = b;
      p11 = p11 + qs;
    }
    const yi = y[i];
    if (Number.isFinite(yi)) {
      const v = yi - l;
      const S = p00 + r;
      const k0 = p00 / S;
      const k1 = p01 / S;
      l += k0 * v;
      s += k1 * v;
      const n00 = (1 - k0) * p00;
      const n01 = (1 - k0) * p01;
      const n11 = p11 - k1 * p01;
      p00 = n00;
      p01 = n01;
      p11 = n11;
    }
    level[i] = l;
    slope[i] = s;
    slopeSd[i] = Math.sqrt(Math.max(p11, 1e-30));
  }
  return { level, slope, slopeSd };
}

/** OLS slope t-statistic of log price on time over the last n bars (a trend's significance) */
export function trendT(logp: ArrayLike<number>, n: number): Float64Array {
  const out = nanArr(logp.length);
  // x = 0..n−1 within the window: Σx and Σx² are constants
  const sx = (n * (n - 1)) / 2;
  const sxx = ((n - 1) * n * (2 * n - 1)) / 6;
  const dx = n * sxx - sx * sx;
  for (let i = n - 1; i < logp.length; i++) {
    let sy = 0;
    let sxy = 0;
    let syy = 0;
    const base = logp[i - n + 1];
    for (let k = 0; k < n; k++) {
      const v = logp[i - n + 1 + k] - base;
      sy += v;
      sxy += k * v;
      syy += v * v;
    }
    const b = (n * sxy - sx * sy) / dx;
    const a = (sy - b * sx) / n;
    const sse = Math.max(0, syy - a * sy - b * sxy);
    const se = Math.sqrt(sse / Math.max(1, n - 2) / (sxx - (sx * sx) / n));
    out[i] = se > 0 ? b / se : NaN;
  }
  return out;
}

// ---------- mean reversion ----------

/**
 * Ornstein–Uhlenbeck fit on a rolling window (an AR(1) regression of x on its
 * previous value): the s-score (distance from the equilibrium in equilibrium
 * standard deviations), the half-life in bars and the equilibrium level.
 * NaN where the window shows no mean reversion (slope ≥ 1).
 */
export function ouRolling(x: ArrayLike<number>, w: number): { s: Float64Array; halfLife: Float64Array; mu: Float64Array } {
  const n = x.length;
  const s = nanArr(n);
  const halfLife = nanArr(n);
  const mu = nanArr(n);
  const c = n ? x[0] : 0;
  let Sx = 0;
  let Sy = 0;
  let Sxx = 0;
  let Sxy = 0;
  let Syy = 0;
  let m = 0;
  for (let i = 1; i < n; i++) {
    const X = x[i - 1] - c;
    const Y = x[i] - c;
    Sx += X;
    Sy += Y;
    Sxx += X * X;
    Sxy += X * Y;
    Syy += Y * Y;
    m++;
    if (m > w) {
      const X0 = x[i - w - 1] - c;
      const Y0 = x[i - w] - c;
      Sx -= X0;
      Sy -= Y0;
      Sxx -= X0 * X0;
      Sxy -= X0 * Y0;
      Syy -= Y0 * Y0;
      m = w;
    }
    if (m < w) continue;
    const d = m * Sxx - Sx * Sx;
    if (!(d > 0)) continue;
    const b = (m * Sxy - Sx * Sy) / d;
    const a = (Sy - b * Sx) / m;
    if (!(b > 0 && b < 1)) continue;
    const sse = Math.max(0, Syy - a * Sy - b * Sxy);
    const ve = sse / Math.max(1, m - 2);
    const sdEq = Math.sqrt(ve / (1 - b * b));
    const muEq = a / (1 - b) + c;
    halfLife[i] = Math.log(2) / -Math.log(b);
    mu[i] = muEq;
    s[i] = sdEq > 0 ? (x[i] - muEq) / sdEq : NaN;
  }
  return { s, halfLife, mu };
}

// ---------- regime ----------

/**
 * Rolling variance ratio VR(q) of 1-bar log returns over a window (Lo &
 * MacKinlay 1988): the variance of q-bar returns over q times the 1-bar
 * variance. Above 1: moves persist (trending); below 1: they reverse. Also the
 * homoskedastic z-statistic of VR − 1.
 */
export function varianceRatio(r: ArrayLike<number>, q: number, w: number): { vr: Float64Array; z: Float64Array } {
  const n = r.length;
  const vr = nanArr(n);
  const z = nanArr(n);
  // q-bar overlapping sums
  const R = nanArr(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += Number.isFinite(r[i]) ? r[i] : 0;
    if (i >= q) acc -= Number.isFinite(r[i - q]) ? r[i - q] : 0;
    if (i >= q - 1) R[i] = acc;
  }
  let s1 = 0;
  let q1 = 0;
  let sq = 0;
  let qq = 0;
  const sd = Math.sqrt((2 * (2 * q - 1) * (q - 1)) / (3 * q * w));
  for (let i = 0; i < n; i++) {
    const a = Number.isFinite(r[i]) ? r[i] : 0;
    s1 += a;
    q1 += a * a;
    const b = Number.isFinite(R[i]) ? R[i] : 0;
    sq += b;
    qq += b * b;
    if (i >= w) {
      const a0 = Number.isFinite(r[i - w]) ? r[i - w] : 0;
      s1 -= a0;
      q1 -= a0 * a0;
      const b0 = Number.isFinite(R[i - w]) ? R[i - w] : 0;
      sq -= b0;
      qq -= b0 * b0;
    }
    if (i < w + q) continue;
    const m1 = s1 / w;
    const v1 = q1 / w - m1 * m1;
    const vq = qq / w - (sq / w) ** 2;
    if (v1 > 0) {
      vr[i] = vq / (q * v1);
      z[i] = (vr[i] - 1) / sd;
    }
  }
  return { vr, z };
}

/** Hurst exponent by rescaled range (Hurst 1951; Peters 1994): 0.5 random walk, above trending, below mean-reverting */
export function hurstRS(r: ArrayLike<number>): number {
  const x = Array.from(r).filter(Number.isFinite);
  const pts: [number, number][] = [];
  for (let size = 16; size <= x.length / 4; size = Math.floor(size * 1.6)) {
    let rs = 0;
    let k = 0;
    for (let s = 0; s + size <= x.length; s += size) {
      let m = 0;
      for (let j = 0; j < size; j++) m += x[s + j];
      m /= size;
      let cum = 0;
      let mx = -Infinity;
      let mn = Infinity;
      let v = 0;
      for (let j = 0; j < size; j++) {
        const d = x[s + j] - m;
        cum += d;
        mx = Math.max(mx, cum);
        mn = Math.min(mn, cum);
        v += d * d;
      }
      const sd = Math.sqrt(v / size);
      if (sd > 0) {
        rs += (mx - mn) / sd;
        k++;
      }
    }
    if (k) pts.push([Math.log(size), Math.log(rs / k)]);
  }
  if (pts.length < 3) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  let num = 0;
  let den = 0;
  for (const [a, b] of pts) {
    num += (a - mx) * (b - my);
    den += (a - mx) ** 2;
  }
  return den > 0 ? num / den : NaN;
}

export interface Hmm2 {
  /** state 0 is calm (lower volatility), state 1 turbulent */
  mu: [number, number];
  sd: [number, number];
  /** transition probabilities: P[i][j] = P(next = j | now = i) */
  P: [[number, number], [number, number]];
  pi: [number, number];
  logLik: number;
}

const gpdf = (x: number, m: number, s: number) => Math.exp(-0.5 * ((x - m) / s) ** 2) / (s * Math.sqrt(2 * Math.PI));

/** a two-state Gaussian hidden Markov model of returns (Hamilton 1989), fitted by Baum–Welch */
export function fitHmm2(r: ArrayLike<number>, iters = 40): Hmm2 | null {
  const x = Array.from(r).filter(Number.isFinite);
  const n = x.length;
  if (n < 200) return null;
  const m0 = x.reduce((a, b) => a + b, 0) / n;
  const s0 = Math.sqrt(x.reduce((a, b) => a + (b - m0) ** 2, 0) / n) || 1e-4;
  let mu: [number, number] = [m0, m0];
  let sd: [number, number] = [s0 * 0.7, s0 * 1.6];
  let P: [[number, number], [number, number]] = [
    [0.98, 0.02],
    [0.05, 0.95],
  ];
  let pi: [number, number] = [0.7, 0.3];
  let logLik = -Infinity;
  const a0 = new Float64Array(n);
  const a1 = new Float64Array(n);
  const b0 = new Float64Array(n);
  const b1 = new Float64Array(n);
  const sc = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    // forward, scaled
    let ll = 0;
    for (let t = 0; t < n; t++) {
      const e0 = Math.max(gpdf(x[t], mu[0], sd[0]), 1e-300);
      const e1 = Math.max(gpdf(x[t], mu[1], sd[1]), 1e-300);
      const p0 = t ? a0[t - 1] * P[0][0] + a1[t - 1] * P[1][0] : pi[0];
      const p1 = t ? a0[t - 1] * P[0][1] + a1[t - 1] * P[1][1] : pi[1];
      const f0 = p0 * e0;
      const f1 = p1 * e1;
      const c = f0 + f1 || 1e-300;
      a0[t] = f0 / c;
      a1[t] = f1 / c;
      sc[t] = c;
      ll += Math.log(c);
    }
    // backward, scaled
    b0[n - 1] = 1;
    b1[n - 1] = 1;
    for (let t = n - 2; t >= 0; t--) {
      const e0 = Math.max(gpdf(x[t + 1], mu[0], sd[0]), 1e-300);
      const e1 = Math.max(gpdf(x[t + 1], mu[1], sd[1]), 1e-300);
      b0[t] = (P[0][0] * e0 * b0[t + 1] + P[0][1] * e1 * b1[t + 1]) / sc[t + 1];
      b1[t] = (P[1][0] * e0 * b0[t + 1] + P[1][1] * e1 * b1[t + 1]) / sc[t + 1];
    }
    // expected states and transitions
    let g0s = 0;
    let g1s = 0;
    let m0s = 0;
    let m1s = 0;
    const xi = [
      [0, 0],
      [0, 0],
    ];
    for (let t = 0; t < n; t++) {
      const g0 = a0[t] * b0[t];
      const g1 = a1[t] * b1[t];
      const g = g0 + g1 || 1;
      g0s += g0 / g;
      g1s += g1 / g;
      m0s += (g0 / g) * x[t];
      m1s += (g1 / g) * x[t];
      if (t + 1 < n) {
        const e0 = Math.max(gpdf(x[t + 1], mu[0], sd[0]), 1e-300);
        const e1 = Math.max(gpdf(x[t + 1], mu[1], sd[1]), 1e-300);
        const k = sc[t + 1];
        xi[0][0] += (a0[t] * P[0][0] * e0 * b0[t + 1]) / k;
        xi[0][1] += (a0[t] * P[0][1] * e1 * b1[t + 1]) / k;
        xi[1][0] += (a1[t] * P[1][0] * e0 * b0[t + 1]) / k;
        xi[1][1] += (a1[t] * P[1][1] * e1 * b1[t + 1]) / k;
      }
    }
    const nm: [number, number] = [m0s / g0s, m1s / g1s];
    let v0 = 0;
    let v1 = 0;
    for (let t = 0; t < n; t++) {
      const g0 = a0[t] * b0[t];
      const g1 = a1[t] * b1[t];
      const g = g0 + g1 || 1;
      v0 += (g0 / g) * (x[t] - nm[0]) ** 2;
      v1 += (g1 / g) * (x[t] - nm[1]) ** 2;
    }
    mu = nm;
    sd = [Math.max(Math.sqrt(v0 / g0s), s0 * 0.05), Math.max(Math.sqrt(v1 / g1s), s0 * 0.05)];
    const r0 = xi[0][0] + xi[0][1] || 1;
    const r1 = xi[1][0] + xi[1][1] || 1;
    P = [
      [xi[0][0] / r0, xi[0][1] / r0],
      [xi[1][0] / r1, xi[1][1] / r1],
    ];
    const g00 = a0[0] * b0[0];
    const g10 = a1[0] * b1[0];
    pi = [g00 / (g00 + g10 || 1), g10 / (g00 + g10 || 1)];
    const done = Math.abs(ll - logLik) < 1e-6 * Math.abs(ll);
    logLik = ll;
    if (done) break;
  }
  // label: state 1 is the turbulent one
  if (sd[0] > sd[1]) {
    mu = [mu[1], mu[0]];
    sd = [sd[1], sd[0]];
    P = [
      [P[1][1], P[1][0]],
      [P[0][1], P[0][0]],
    ];
    pi = [pi[1], pi[0]];
  }
  return { mu, sd, P, pi, logLik };
}

/** P(turbulent state | returns up to and including t), the forward filter — no look-ahead */
export function hmmFilter(m: Hmm2, r: ArrayLike<number>): Float64Array {
  const n = r.length;
  const out = nanArr(n);
  let p0 = m.pi[0];
  let p1 = m.pi[1];
  for (let t = 0; t < n; t++) {
    const pr0 = p0 * m.P[0][0] + p1 * m.P[1][0];
    const pr1 = p0 * m.P[0][1] + p1 * m.P[1][1];
    if (!Number.isFinite(r[t])) {
      p0 = pr0;
      p1 = pr1;
      out[t] = p1;
      continue;
    }
    const f0 = pr0 * Math.max(gpdf(r[t], m.mu[0], m.sd[0]), 1e-300);
    const f1 = pr1 * Math.max(gpdf(r[t], m.mu[1], m.sd[1]), 1e-300);
    const c = f0 + f1 || 1;
    p0 = f0 / c;
    p1 = f1 / c;
    out[t] = p1;
  }
  return out;
}

/** expected stay in each state, in bars */
export const hmmDuration = (m: Hmm2): [number, number] => [1 / Math.max(1e-9, 1 - m.P[0][0]), 1 / Math.max(1e-9, 1 - m.P[1][1])];

// ---------- volatility estimators ----------

export interface OHLC {
  open: number;
  high: number;
  low: number;
  close: number;
}

function rollMean(x: Float64Array, w: number): Float64Array {
  const out = nanArr(x.length);
  let s = 0;
  let k = 0;
  for (let i = 0; i < x.length; i++) {
    const v = Number.isFinite(x[i]) ? x[i] : 0;
    s += v;
    k++;
    if (i >= w) {
      s -= Number.isFinite(x[i - w]) ? x[i - w] : 0;
      k = w;
    }
    if (k >= w) out[i] = s / w;
  }
  return out;
}

export type VolKind = 'close' | 'parkinson' | 'garmanKlass' | 'rogersSatchell' | 'yangZhang';
export const VOL_KINDS: { id: VolKind; name: string; cite: string }[] = [
  { id: 'close', name: 'Close to close', cite: 'the textbook estimate' },
  { id: 'parkinson', name: 'Parkinson', cite: 'Parkinson (1980): high–low range' },
  { id: 'garmanKlass', name: 'Garman–Klass', cite: 'Garman & Klass (1980): open, high, low, close' },
  { id: 'rogersSatchell', name: 'Rogers–Satchell', cite: 'Rogers & Satchell (1991): robust to drift' },
  { id: 'yangZhang', name: 'Yang–Zhang', cite: 'Yang & Zhang (2000): drift and opening jumps' },
];

/** rolling per-bar volatility (σ of the log return) by estimator, over w bars */
export function volEstimate(b: OHLC[], w: number, kind: VolKind): Float64Array {
  const n = b.length;
  const ln = Math.log;
  if (kind === 'close' || kind === 'yangZhang') {
    const r = Float64Array.from({ length: n }, (_, i) => (i ? ln(b[i].close / b[i - 1].close) : NaN));
    if (kind === 'close') {
      const m = rollMean(r, w);
      const q = rollMean(r.map((x) => x * x), w);
      return Float64Array.from(m, (mm, i) => (Number.isFinite(mm) ? Math.sqrt(Math.max(0, ((q[i] - mm * mm) * w) / (w - 1))) : NaN));
    }
    // Yang–Zhang: overnight (open vs previous close) + k·open-to-close + (1−k)·Rogers–Satchell
    const o = Float64Array.from({ length: n }, (_, i) => (i ? ln(b[i].open / b[i - 1].close) : NaN));
    const c = Float64Array.from(b, (x) => ln(x.close / x.open));
    const rs = Float64Array.from(b, (x) => ln(x.high / x.close) * ln(x.high / x.open) + ln(x.low / x.close) * ln(x.low / x.open));
    const varOf = (x: Float64Array) => {
      const m = rollMean(x, w);
      const q = rollMean(x.map((v) => v * v), w);
      return Float64Array.from(m, (mm, i) => (Number.isFinite(mm) ? Math.max(0, ((q[i] - mm * mm) * w) / (w - 1)) : NaN));
    };
    const vo = varOf(o);
    const vc = varOf(c);
    const vrs = rollMean(rs, w);
    const k = 0.34 / (1.34 + (w + 1) / (w - 1));
    return Float64Array.from(vo, (v, i) => (Number.isFinite(v) && Number.isFinite(vc[i]) && Number.isFinite(vrs[i]) ? Math.sqrt(Math.max(0, v + k * vc[i] + (1 - k) * vrs[i])) : NaN));
  }
  const per = Float64Array.from(b, (x) => {
    const hl = ln(x.high / x.low);
    const co = ln(x.close / x.open);
    if (kind === 'parkinson') return (hl * hl) / (4 * Math.LN2);
    if (kind === 'garmanKlass') return 0.5 * hl * hl - (2 * Math.LN2 - 1) * co * co;
    return ln(x.high / x.close) * ln(x.high / x.open) + ln(x.low / x.close) * ln(x.low / x.open);
  });
  return Float64Array.from(rollMean(per, w), (v) => (Number.isFinite(v) ? Math.sqrt(Math.max(0, v)) : NaN));
}

/**
 * Volatility targeting (Moreira & Muir 2017; Harvey et al. 2018): the weight
 * that brings a position's expected volatility to the target, capped.
 * sigma is the forecast per-bar σ; target the annual volatility wanted.
 */
export const volTargetWeight = (sigmaBar: number, targetAnn: number, barsPerYear: number, cap = 3) => (sigmaBar > 0 ? Math.min(cap, targetAnn / Math.sqrt(barsPerYear) / sigmaBar) : 0);

// ---------- value at risk ----------

export function quantile(xs: number[], p: number): number {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return NaN;
  const k = (a.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.ceil(k);
  return a[lo] + (a[hi] - a[lo]) * (k - lo);
}

export interface VarResult {
  /** loss as a positive fraction of value */
  var: number;
  es: number;
}

/** sample moments: mean, sd, skew, excess kurtosis */
export function moments4(x: number[]): { m: number; s: number; skew: number; kurt: number } {
  const a = x.filter(Number.isFinite);
  const n = a.length || 1;
  const m = a.reduce((p, v) => p + v, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of a) {
    const d = v - m;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  const s = Math.sqrt(m2);
  return { m, s, skew: s > 0 ? m3 / s ** 3 : 0, kurt: s > 0 ? m4 / s ** 4 - 3 : 0 };
}

/** historical simulation: the empirical loss quantile and the mean loss beyond it */
export function varHistorical(r: number[], p: number): VarResult {
  const v = -quantile(r, 1 - p);
  const tail = r.filter((x) => Number.isFinite(x) && x <= -v);
  return { var: v, es: tail.length ? -tail.reduce((a, b) => a + b, 0) / tail.length : v };
}

/** normal (variance–covariance) */
export function varNormal(m: number, s: number, p: number): VarResult {
  const z = ninv(1 - p);
  return { var: -(m + s * z), es: -(m - (s * npdf(z)) / (1 - p)) };
}

/** Cornish–Fisher: the normal quantile bent for skew and fat tails (Favre & Galeano 2002) */
export function varCornishFisher(m: number, s: number, skew: number, kurt: number, p: number): VarResult {
  const z = ninv(1 - p);
  const zc = z + ((z * z - 1) * skew) / 6 + ((z ** 3 - 3 * z) * kurt) / 24 - ((2 * z ** 3 - 5 * z) * skew * skew) / 36;
  // expected shortfall: averaged over the tail of the Cornish–Fisher quantile function
  let es = 0;
  const K = 40;
  for (let k = 0; k < K; k++) {
    const u = ((k + 0.5) / K) * (1 - p);
    const zu = ninv(u);
    es += zu + ((zu * zu - 1) * skew) / 6 + ((zu ** 3 - 3 * zu) * kurt) / 24 - ((2 * zu ** 3 - 5 * zu) * skew * skew) / 36;
  }
  return { var: -(m + s * zc), es: -(m + (s * es) / K) };
}

/** one-step GARCH value at risk from the fitted error distribution (normal or Student-t) */
export function varGarch(fit: GarchFit, h1: number, p: number): VarResult {
  const s = Math.sqrt(h1);
  const q = errQuantile(fit, 1 - p);
  // expected shortfall by averaging the tail quantiles
  let es = 0;
  const K = 24;
  for (let k = 0; k < K; k++) es += errQuantile(fit, ((k + 0.5) / K) * (1 - p));
  return { var: -(fit.mu + s * q), es: -(fit.mu + (s * es) / K) };
}

export type VarMethod = 'historical' | 'normal' | 'cornishFisher' | 'garch' | 'ewma';
export const VAR_METHODS: { id: VarMethod; name: string }[] = [
  { id: 'historical', name: 'Historical' },
  { id: 'normal', name: 'Normal' },
  { id: 'cornishFisher', name: 'Cornish–Fisher' },
  { id: 'ewma', name: 'EWMA (RiskMetrics)' },
  { id: 'garch', name: 'GARCH' },
];

/**
 * One-step-ahead VaR forecasts for each bar from `from` on, each made with
 * returns before it only: rolling window for the historical and parametric
 * methods, the RiskMetrics average, and the GARCH filter.
 */
export function varForecasts(r: ArrayLike<number>, from: number, p: number, method: VarMethod, w = 500, fit?: GarchFit | null): Float64Array {
  const n = r.length;
  const out = nanArr(n);
  if (method === 'garch') {
    if (!fit) return out;
    // h[t] is the variance of r[t] from r[0..t−1]
    const h = garchVar(fit, Array.from(r, (x) => (Number.isFinite(x) ? x : 0)));
    const q = errQuantile(fit, 1 - p);
    for (let t = from; t < n; t++) out[t] = -(fit.mu + Math.sqrt(h[t]) * q);
    return out;
  }
  if (method === 'ewma') {
    let v = NaN;
    const z = ninv(1 - p);
    for (let t = 1; t < n; t++) {
      const x = r[t - 1];
      if (Number.isFinite(x)) v = Number.isFinite(v) ? 0.94 * v + 0.06 * x * x : x * x;
      if (t >= from && Number.isFinite(v)) out[t] = -z * Math.sqrt(v);
    }
    return out;
  }
  for (let t = Math.max(from, w); t < n; t++) {
    const win: number[] = [];
    for (let k = t - w; k < t; k++) if (Number.isFinite(r[k])) win.push(r[k]);
    if (win.length < w / 2) continue;
    if (method === 'historical') out[t] = -quantile(win, 1 - p);
    else {
      const mm = moments4(win);
      out[t] = method === 'normal' ? varNormal(mm.m, mm.s, p).var : varCornishFisher(mm.m, mm.s, mm.skew, mm.kurt, p).var;
    }
  }
  return out;
}

export interface VarBacktest {
  n: number;
  breaches: number;
  expected: number;
  /** Kupiec proportion-of-failures test: are there as many breaches as there should be? */
  kupiecLR: number;
  kupiecP: number;
  /** Christoffersen: do breaches cluster (one makes the next more likely)? */
  indLR: number;
  indP: number;
  /** conditional coverage: both together (2 degrees of freedom) */
  ccP: number;
}

const chi1p = (lr: number) => (lr > 0 ? 2 * (1 - ncdf(Math.sqrt(lr))) : 1);
const xlogy = (x: number, y: number) => (x > 0 ? x * Math.log(y) : 0);

/** backtest a VaR forecast series against realised returns: Kupiec (1995) and Christoffersen (1998) */
export function varBacktest(r: ArrayLike<number>, vars: ArrayLike<number>, p: number): VarBacktest | null {
  const hits: number[] = [];
  for (let t = 0; t < r.length; t++) if (Number.isFinite(r[t]) && Number.isFinite(vars[t])) hits.push(r[t] < -vars[t] ? 1 : 0);
  const n = hits.length;
  if (n < 50) return null;
  const x = hits.reduce((a, b) => a + b, 0);
  const a = 1 - p;
  const ph = x / n;
  const kupiecLR = -2 * (xlogy(n - x, 1 - a) + xlogy(x, a) - xlogy(n - x, 1 - ph) - xlogy(x, ph));
  let n00 = 0;
  let n01 = 0;
  let n10 = 0;
  let n11 = 0;
  for (let t = 1; t < n; t++) {
    const k = hits[t - 1] * 2 + hits[t];
    if (k === 0) n00++;
    else if (k === 1) n01++;
    else if (k === 2) n10++;
    else n11++;
  }
  const p01 = n01 / Math.max(1, n00 + n01);
  const p11 = n11 / Math.max(1, n10 + n11);
  const p1 = (n01 + n11) / Math.max(1, n00 + n01 + n10 + n11);
  const indLR = -2 * (xlogy(n00 + n10, 1 - p1) + xlogy(n01 + n11, p1) - xlogy(n00, 1 - p01) - xlogy(n01, p01) - xlogy(n10, 1 - p11) - xlogy(n11, p11));
  const k1 = Math.max(0, kupiecLR);
  const k2 = Math.max(0, indLR);
  return { n, breaches: x, expected: n * a, kupiecLR: k1, kupiecP: chi1p(k1), indLR: k2, indP: chi1p(k2), ccP: Math.exp(-(k1 + k2) / 2) };
}

// ---------- options: Black–Scholes and delta hedging ----------

export type OptType = 'call' | 'put';

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  /** per 1.00 change in volatility (divide by 100 for a vol point) */
  vega: number;
  /** per year (divide by 365 for a day) */
  theta: number;
}

/** Black–Scholes (Black & Scholes 1973; perpetual-funded futures: no carry, r = 0 by default) */
export function blackScholes(S: number, K: number, T: number, sigma: number, type: OptType, r = 0): Greeks {
  if (!(T > 0) || !(sigma > 0)) {
    const intrinsic = type === 'call' ? Math.max(0, S - K) : Math.max(0, K - S);
    const delta = type === 'call' ? (S > K ? 1 : 0) : S < K ? -1 : 0;
    return { price: intrinsic, delta, gamma: 0, vega: 0, theta: 0 };
  }
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T);
  const price = type === 'call' ? S * ncdf(d1) - K * df * ncdf(d2) : K * df * ncdf(-d2) - S * ncdf(-d1);
  const delta = type === 'call' ? ncdf(d1) : ncdf(d1) - 1;
  const gamma = npdf(d1) / (S * sq);
  const vega = S * npdf(d1) * Math.sqrt(T);
  const theta = -(S * npdf(d1) * sigma) / (2 * Math.sqrt(T)) - (type === 'call' ? r * K * df * ncdf(d2) : -r * K * df * ncdf(-d2));
  return { price, delta, gamma, vega, theta };
}

/** implied volatility by bisection */
export function impliedVol(price: number, S: number, K: number, T: number, type: OptType): number {
  let lo = 0.01;
  let hi = 5;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (blackScholes(S, K, T, mid, type).price < price) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface HedgeRun {
  /** P&L of the hedged book as a fraction of the starting price, at each bar */
  pnl: number[];
  final: number;
  /** realised volatility over the option's life (annualised) */
  realised: number;
  /** premium received or paid, as a fraction of the starting price */
  premium: number;
}

/**
 * Sell (side −1) or buy (+1) a straddle or single option priced at `iv`, then
 * delta-hedge it with the underlying every `every` bars until expiry. The
 * book's P&L is what the hedger keeps: roughly ½·Γ·S²·(σ²_realised − σ²_implied)
 * summed over the life (for the buyer) — the volatility risk premium in money.
 */
export function deltaHedge(prices: number[], opts: { strikePct: number; iv: number; kind: OptType | 'straddle'; side: 1 | -1; every: number; barYears: number; costBps?: number }): HedgeRun | null {
  const n = prices.length;
  if (n < 3) return null;
  const S0 = prices[0];
  const K = S0 * opts.strikePct;
  const T0 = (n - 1) * opts.barYears;
  const legs: OptType[] = opts.kind === 'straddle' ? ['call', 'put'] : [opts.kind];
  const val = (S: number, T: number) => legs.reduce((a, t) => a + blackScholes(S, K, T, opts.iv, t).price, 0);
  const del = (S: number, T: number) => legs.reduce((a, t) => a + blackScholes(S, K, T, opts.iv, t).delta, 0);
  const cost = (opts.costBps ?? 0) / 1e4;
  const premium = val(S0, T0);
  let hedge = -opts.side * del(S0, T0);
  let cash = -opts.side * premium - Math.abs(hedge) * S0 * cost;
  const pnl: number[] = [0];
  let sumR2 = 0;
  for (let i = 1; i < n; i++) {
    const S = prices[i];
    const T = Math.max(0, T0 - i * opts.barYears);
    cash += hedge * (S - prices[i - 1]);
    sumR2 += Math.log(S / prices[i - 1]) ** 2;
    const book = opts.side * (i === n - 1 ? legs.reduce((a, t) => a + (t === 'call' ? Math.max(0, S - K) : Math.max(0, K - S)), 0) : val(S, T));
    pnl.push((cash + book) / S0);
    if (i < n - 1 && i % opts.every === 0) {
      const target = -opts.side * del(S, T);
      cash -= Math.abs(target - hedge) * S * cost;
      hedge = target;
    }
  }
  const realised = Math.sqrt(sumR2 / ((n - 1) * opts.barYears));
  return { pnl, final: pnl[pnl.length - 1], realised, premium: premium / S0 };
}

// ---------- sizing ----------

/** Kelly fraction for a bet won with probability p paying `win` per 1 risked and losing `loss` (Kelly 1956; Thorp 2006) */
export const kellyBet = (p: number, win: number, loss = 1) => (win > 0 && loss > 0 ? p / loss - (1 - p) / win : 0);
/** Kelly leverage for a return stream with mean m and variance v per period (continuous approximation) */
export const kellyLeverage = (m: number, v: number) => (v > 0 ? m / v : 0);

// ---------- CAPM, the efficient frontier and the Kelly portfolio ----------

export interface Capm {
  /** Jensen's alpha per period, its t-statistic, beta and its t, R² */
  alpha: number;
  tAlpha: number;
  beta: number;
  tBeta: number;
  r2: number;
  /** residual (idiosyncratic) standard deviation per period */
  residSd: number;
  n: number;
}

/**
 * The capital asset pricing model as a regression (Sharpe 1964; Jensen 1968):
 * the asset's excess return on the market's. Beta is the market exposure,
 * alpha what is left over, R² the share of the asset's variance the market
 * explains. Returns per period, risk-free rate per period.
 */
export function capm(asset: ArrayLike<number>, market: ArrayLike<number>, rf = 0): Capm | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < Math.min(asset.length, market.length); i++)
    if (Number.isFinite(asset[i]) && Number.isFinite(market[i])) {
      xs.push(market[i] - rf);
      ys.push(asset[i] - rf);
    }
  const n = xs.length;
  if (n < 10) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  const sse = Math.max(0, syy - beta * sxy);
  const s2 = sse / Math.max(1, n - 2);
  const seB = Math.sqrt(s2 / sxx);
  const seA = Math.sqrt(s2 * (1 / n + (mx * mx) / sxx));
  return { alpha, tAlpha: seA > 0 ? alpha / seA : NaN, beta, tBeta: seB > 0 ? beta / seB : NaN, r2: syy > 0 ? 1 - sse / syy : NaN, residSd: Math.sqrt(s2), n };
}

/** mean vector and covariance matrix of aligned return series (rets[asset][t]) */
export function meanCov(rets: number[][]): { mu: number[]; cov: number[][] } {
  const k = rets.length;
  const n = Math.min(...rets.map((r) => r.length));
  const mu = rets.map((r) => r.slice(0, n).reduce((a, b) => a + b, 0) / n);
  const cov = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++)
    for (let j = i; j < k; j++) {
      let s = 0;
      for (let t = 0; t < n; t++) s += (rets[i][t] - mu[i]) * (rets[j][t] - mu[j]);
      cov[i][j] = cov[j][i] = s / Math.max(1, n - 1);
    }
  return { mu, cov };
}

const dot = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * b[i], 0);
const mulMV = (m: number[][], v: number[]) => m.map((row) => dot(row, v));
export const portVar = (w: number[], cov: number[][]) => dot(w, mulMV(cov, w));

/** Euclidean projection onto {w ≥ 0, Σw = c} (Duchi et al. 2008) */
export function projectSimplex(v: number[], c = 1): number[] {
  const u = [...v].sort((a, b) => b - a);
  let css = 0;
  let theta = 0;
  for (let i = 0; i < u.length; i++) {
    css += u[i];
    const t = (css - c) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(0, x - theta));
}

/** projection onto {w ≥ 0, Σw ≤ c} */
const projectCapped = (v: number[], c: number) => {
  const p = v.map((x) => Math.max(0, x));
  return p.reduce((a, b) => a + b, 0) <= c ? p : projectSimplex(v, c);
};

/** maximise f(w) = μ'w·λ − w'Σw (or its growth form) over a convex set by projected gradient ascent */
function ascend(mu: number[], cov: number[][], lambda: number, project: (v: number[]) => number[], half = false, iters = 600): number[] {
  const k = mu.length;
  const L = 2 * Math.max(1e-12, cov.reduce((a, r, i) => a + Math.abs(r[i]), 0));
  let w = project(new Array(k).fill(1 / k));
  for (let it = 0; it < iters; it++) {
    const g = mulMV(cov, w);
    // gradient of λμ'w − w'Σw is λμ − 2Σw; of μ'w − ½w'Σw (Kelly growth) is μ − Σw
    const grad = mu.map((m, i) => (half ? m - g[i] : lambda * m - 2 * g[i]));
    const next = project(w.map((x, i) => x + grad[i] / (half ? L / 2 : L)));
    const moved = next.reduce((a, x, i) => a + Math.abs(x - w[i]), 0);
    w = next;
    if (moved < 1e-10) break;
  }
  return w;
}

export interface Portfolio {
  w: number[];
  ret: number;
  vol: number;
  sharpe: number;
}

const portOf = (w: number[], mu: number[], cov: number[][], rf: number): Portfolio => {
  const ret = dot(w, mu);
  const vol = Math.sqrt(Math.max(0, portVar(w, cov)));
  return { w, ret, vol, sharpe: vol > 0 ? (ret - rf) / vol : NaN };
};

/**
 * The long-only efficient frontier (Markowitz 1952): for each risk appetite
 * λ, the fully invested portfolio maximising λ·return − variance. From the
 * minimum-variance portfolio (λ = 0) to the single best asset.
 */
export function efficientFrontier(mu: number[], cov: number[][], rf = 0, points = 40): { frontier: Portfolio[]; minVar: Portfolio; tangency: Portfolio } {
  const scale = cov.reduce((a, r, i) => a + r[i], 0) / mu.length / Math.max(1e-12, Math.max(...mu.map(Math.abs)));
  const lambdas = [0, ...Array.from({ length: points - 1 }, (_, i) => scale * 1e-2 * Math.pow(1e4, i / (points - 2)))];
  const frontier: Portfolio[] = [];
  for (const lam of lambdas) {
    const p = portOf(ascend(mu, cov, lam, (v) => projectSimplex(v, 1)), mu, cov, rf);
    if (!frontier.length || p.ret > frontier[frontier.length - 1].ret + 1e-12) frontier.push(p);
  }
  const minVar = frontier[0];
  const tangency = frontier.reduce((b, p) => (p.sharpe > b.sharpe ? p : b), frontier[0]);
  return { frontier, minVar, tangency };
}

/**
 * The growth-optimal (Kelly) portfolio: maximise the expected log growth,
 * ≈ μ'w − ½w'Σw for excess returns, long-only, gross exposure at most `cap`
 * (Kelly 1956; Thorp 2006). Unconstrained it is Σ⁻¹μ.
 */
export function kellyPortfolio(mu: number[], cov: number[][], rf = 0, cap = 1): Portfolio {
  const ex = mu.map((m) => m - rf);
  const w = ascend(ex, cov, 1, (v) => projectCapped(v, cap), true, 2000);
  const p = portOf(w, mu, cov, rf);
  // the cash share earns the risk-free rate
  const cash = 1 - w.reduce((a, b) => a + b, 0);
  return { ...p, ret: p.ret + cash * rf, sharpe: p.vol > 0 ? (p.ret + cash * rf - rf) / p.vol : NaN };
}

/** expected log growth of a leverage f on an asset with excess return m and variance v per period (continuous) */
export const kellyGrowth = (f: number, m: number, v: number, rf = 0) => rf + f * m - 0.5 * f * f * v;

// ---------- pairs and cointegration (Engle & Granger 1987) ----------

export interface Coint {
  /** y = alpha + beta · x: the hedge ratio and the intercept */
  beta: number;
  alpha: number;
  r2: number;
  /** the spread (the regression's residual) at each point */
  resid: number[];
  /** the spread today in its own standard deviations */
  z: number;
  sd: number;
  /** the augmented Dickey–Fuller t-statistic on the spread (one lag); the more negative, the stronger the pull back */
  adf: number;
  /** how sure: the spread reverts at the 1 %, 5 % or 10 % level, or not at all */
  level: 1 | 5 | 10 | null;
  /** how long half of a gap takes to close, in bars (Infinity when it does not revert) */
  halfLife: number;
}

/** Engle–Granger critical values for two series with a constant (MacKinnon 2010, asymptotic) */
export const EG_CRIT = { 1: -3.9, 5: -3.34, 10: -3.04 } as const;

/**
 * Are two price series tied together? Regress y on x (log prices), then test
 * whether the gap between them keeps coming back (an augmented Dickey–Fuller
 * test on the residual, against the Engle–Granger critical values — stricter
 * than the usual ones, because the hedge ratio was fitted to make the gap
 * look small).
 */
export function cointegration(y: ArrayLike<number>, x: ArrayLike<number>): Coint | null {
  const n = Math.min(y.length, x.length);
  if (n < 60) return null;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(y[i])) return null;
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    sxy += x[i] * y[i];
    syy += y[i] * y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  const vxx = sxx / n - mx * mx;
  const vxy = sxy / n - mx * my;
  const vyy = syy / n - my * my;
  if (!(vxx > 1e-14) || !(vyy > 1e-14)) return null;
  const beta = vxy / vxx;
  const alpha = my - beta * mx;
  const resid = Array.from({ length: n }, (_, i) => y[i] - alpha - beta * x[i]);
  const sd = Math.sqrt(resid.reduce((a, e) => a + e * e, 0) / (n - 2));
  // Δe(t) = γ·e(t−1) + φ·Δe(t−1) + u: the t-statistic of γ
  let a11 = 0;
  let a12 = 0;
  let a22 = 0;
  let b1 = 0;
  let b2 = 0;
  const rows: [number, number, number][] = [];
  for (let t = 2; t < n; t++) {
    const de = resid[t] - resid[t - 1];
    const lag = resid[t - 1];
    const dl = resid[t - 1] - resid[t - 2];
    rows.push([de, lag, dl]);
    a11 += lag * lag;
    a12 += lag * dl;
    a22 += dl * dl;
    b1 += lag * de;
    b2 += dl * de;
  }
  const det = a11 * a22 - a12 * a12;
  let adf = NaN;
  if (Math.abs(det) > 1e-18) {
    const g = (b1 * a22 - b2 * a12) / det;
    const f = (a11 * b2 - a12 * b1) / det;
    let sse = 0;
    for (const [de, lag, dl] of rows) sse += (de - g * lag - f * dl) ** 2;
    const s2 = sse / Math.max(1, rows.length - 2);
    const se = Math.sqrt((s2 * a22) / det);
    adf = se > 0 ? g / se : NaN;
  }
  // AR(1) on the spread: how fast a gap closes
  let num = 0;
  let den = 0;
  for (let t = 1; t < n; t++) {
    num += resid[t] * resid[t - 1];
    den += resid[t - 1] * resid[t - 1];
  }
  const phi = den > 0 ? num / den : 1;
  const halfLife = phi > 0 && phi < 1 ? -Math.LN2 / Math.log(phi) : Infinity;
  const level = !Number.isFinite(adf) ? null : adf < EG_CRIT[1] ? 1 : adf < EG_CRIT[5] ? 5 : adf < EG_CRIT[10] ? 10 : null;
  return { beta, alpha, r2: Math.min(1, (vxy * vxy) / (vxx * vyy)), resid, z: sd > 0 ? resid[n - 1] / sd : 0, sd, adf, level, halfLife };
}

/**
 * Who moves first? The correlation of x's return `lag` bars ago with y's
 * return now, for each lag from −maxLag to +maxLag: a peak at a positive lag
 * says x leads y by that many bars, at a negative lag that y leads x.
 */
export function leadLag(x: ArrayLike<number>, y: ArrayLike<number>, maxLag: number): { lag: number; corr: number }[] {
  const n = Math.min(x.length, y.length);
  const out: { lag: number; corr: number }[] = [];
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let k = 0;
    let sa = 0;
    let sb = 0;
    let saa = 0;
    let sbb = 0;
    let sab = 0;
    for (let t = Math.max(0, lag); t < n + Math.min(0, lag); t++) {
      const a = x[t - lag];
      const b = y[t];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      k++;
      sa += a;
      sb += b;
      saa += a * a;
      sbb += b * b;
      sab += a * b;
    }
    const va = saa / k - (sa / k) ** 2;
    const vb = sbb / k - (sb / k) ** 2;
    out.push({ lag, corr: k > 10 && va > 0 && vb > 0 ? (sab / k - (sa / k) * (sb / k)) / Math.sqrt(va * vb) : NaN });
  }
  return out;
}

// ---------- seasonality: the hour of the day and the day of the week ----------

export interface SeasonCell {
  /** average return of the bars in this cell */
  mean: number;
  /** its t-statistic: the average against its own scatter */
  t: number;
  n: number;
  /** share of those bars that rose */
  up: number;
}
export interface Seasonality {
  /** by the UTC hour the bar starts in (0–23) */
  hours: SeasonCell[];
  /** by UTC weekday (0 = Sunday … 6 = Saturday) */
  days: SeasonCell[];
  /** weekday × hour: the average return */
  grid: number[][];
  /** the |t| a single hour must beat to stand out among 24 tried (Bonferroni at 5 %) */
  tBar: number;
}

const cellOf = (xs: number[]): SeasonCell => {
  const n = xs.length;
  if (n < 2) return { mean: NaN, t: NaN, n, up: NaN };
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1);
  return { mean: m, t: v > 0 ? m / Math.sqrt(v / n) : 0, n, up: xs.filter((x) => x > 0).length / n };
};

/**
 * The average return by hour of the day and by weekday (UTC), each with its
 * t-statistic. Twenty-four hours are twenty-four tries: one of them looking
 * special by luck is expected, so an hour only stands out past tBar.
 */
export function seasonality(times: ArrayLike<number>, rets: ArrayLike<number>): Seasonality {
  const H: number[][] = Array.from({ length: 24 }, () => []);
  const D: number[][] = Array.from({ length: 7 }, () => []);
  const G: number[][][] = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => []));
  for (let i = 0; i < times.length; i++) {
    const r = rets[i];
    if (!Number.isFinite(r)) continue;
    const d = new Date(times[i]);
    const h = d.getUTCHours();
    const w = d.getUTCDay();
    H[h].push(r);
    D[w].push(r);
    G[w][h].push(r);
  }
  return { hours: H.map(cellOf), days: D.map(cellOf), grid: G.map((row) => row.map((xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN))), tBar: 3.08 };
}

// ---------- Monte Carlo on a strategy's trades: growth, drawdown and ruin ----------

export interface RuinSim {
  paths: number;
  trades: number;
  /** percentile equity curves (5, 25, 50, 75, 95), as multiples of the start */
  fan: number[][];
  /** the final multiple: 5th, 50th and 95th percentile */
  p5: number;
  p50: number;
  p95: number;
  /** chance of ending below the start */
  pLoss: number;
  /** chance of touching the target multiple, and of a drawdown as deep as the ruin level, at any point */
  pTarget: number;
  pRuin: number;
  /** the median and the 95th-percentile worst drawdown on the way */
  ddMed: number;
  dd95: number;
  /** the longest losing streak: median and 95th percentile */
  streakMed: number;
  streak95: number;
}

const pctOf = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];

/**
 * Resample a strategy's trade results (in R) into thousands of possible
 * futures, risking a fixed share of the account on each trade, and read off
 * what matters before trading it: how the account might grow, how deep the
 * drawdowns get, the odds of reaching a target and of a ruinous drawdown.
 * `block` > 1 keeps runs of trades together (winning and losing streaks as
 * they came).
 */
export function ruinSim(rs: number[], o: { risk: number; trades: number; paths?: number; target?: number; ruin?: number; seed?: number; block?: number }): RuinSim | null {
  const src = rs.filter(Number.isFinite);
  const m = src.length;
  const n = Math.max(1, Math.round(o.trades));
  if (m < 5 || !(o.risk > 0)) return null;
  const paths = o.paths ?? 2000;
  const target = o.target ?? 2;
  const ruin = o.ruin ?? 0.5;
  const block = Math.max(1, Math.round(o.block ?? 1));
  // a small generator of its own (mulberry32), so the same inputs give the same futures
  let a = (o.seed ?? 11) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pts = Math.min(40, n);
  const at: number[][] = Array.from({ length: pts + 1 }, () => []);
  const mark = new Map<number, number[]>();
  for (let k = 1; k <= pts; k++) {
    const j = Math.max(1, Math.round((k * n) / pts));
    mark.set(j, [...(mark.get(j) ?? []), k]);
  }
  const finals: number[] = [];
  const dds: number[] = [];
  const streaks: number[] = [];
  let hitT = 0;
  let hitR = 0;
  for (let p = 0; p < paths; p++) {
    let eq = 1;
    let peak = 1;
    let dd = 0;
    let run = 0;
    let worst = 0;
    let gotT = false;
    let pos = 0;
    let left = 0;
    at[0].push(1);
    for (let j = 0; j < n; j++) {
      if (left <= 0) {
        pos = Math.floor(rnd() * m);
        left = block;
      }
      const r = src[pos % m];
      pos++;
      left--;
      eq *= Math.max(0, 1 + o.risk * r);
      if (r <= 0) {
        run++;
        worst = Math.max(worst, run);
      } else run = 0;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, 1 - eq / peak);
      if (eq >= target) gotT = true;
      for (const q of mark.get(j + 1) ?? []) at[q].push(eq);
    }
    finals.push(eq);
    dds.push(dd);
    streaks.push(worst);
    if (gotT) hitT++;
    if (dd >= ruin) hitR++;
  }
  finals.sort((x, y) => x - y);
  dds.sort((x, y) => x - y);
  streaks.sort((x, y) => x - y);
  const fan = at.filter((v) => v.length).map((v) => {
    const s = [...v].sort((x, y) => x - y);
    return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => pctOf(s, q));
  });
  return { paths, trades: n, fan, p5: pctOf(finals, 0.05), p50: pctOf(finals, 0.5), p95: pctOf(finals, 0.95), pLoss: finals.filter((x) => x < 1).length / paths, pTarget: hitT / paths, pRuin: hitR / paths, ddMed: pctOf(dds, 0.5), dd95: pctOf(dds, 0.95), streakMed: pctOf(streaks, 0.5), streak95: pctOf(streaks, 0.95) };
}

/** a list of trade results with a given win rate and payoff: `winR` on a win, −`lossR` on a loss */
export function tradesFrom(winRate: number, winR: number, lossR = 1, n = 400): number[] {
  const wins = Math.round(Math.max(0, Math.min(1, winRate)) * n);
  return Array.from({ length: n }, (_, i) => (i < wins ? winR : -lossR));
}
