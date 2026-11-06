// GARCH: volatility that clusters, measured and forecast.
//
//   GARCH(1,1)  h_t = ω + α ε²_{t-1} + β h_{t-1}                (Bollerslev 1986)
//   GJR-GARCH   … + γ ε²_{t-1}·[ε_{t-1} < 0]                    (Glosten, Jagannathan & Runkle 1993)
//               — falls move volatility more than rises (or, in crypto, sometimes less)
//   errors      normal, or Student-t for the fat tails crypto has
//
// Fitted by maximum likelihood with variance targeting (ω set so the long-run
// variance equals the sample's), searched by Nelder–Mead on transformed
// parameters that keep the model stationary. It gives:
//   - the conditional volatility of every bar (using only earlier bars)
//   - forecasts any number of bars ahead, mean-reverting to the long run
//   - value at risk from the fitted distribution
//   - simulated histories: filtered historical simulation (Barone-Adesi,
//     Giannopoulos & Vosper 1999) — the fitted volatility dynamics driven by
//     the coin's own standardised shocks, with no drift or predictability
//   - an honest check: does it forecast better than simple estimates here?
//     (QLIKE loss, Patton 2011; Diebold–Mariano test)
import { rngOf } from './ml';
import { nwT } from './stats';

export type GarchKind = 'garch' | 'gjr';
export type GarchDist = 'normal' | 't';

export interface GarchFit {
  kind: GarchKind;
  dist: GarchDist;
  omega: number;
  alpha: number;
  beta: number;
  gamma: number;
  /** Student-t degrees of freedom (Infinity for normal errors) */
  nu: number;
  mu: number;
  /** long-run (unconditional) variance per bar */
  longRun: number;
  persistence: number;
  /** bars for a volatility shock to halve */
  halfLife: number;
  logLik: number;
  aic: number;
  bic: number;
  n: number;
  /** the variance expected for the next bar after the last one fitted */
  nextVar: number;
  /** the last bar's shock and variance (to keep filtering forward) */
  lastEps: number;
  lastVar: number;
}

// ---------- maths ----------

/** log Γ(x), Lanczos approximation */
export function lgamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Nelder–Mead minimisation */
export function nelderMead(f: (x: number[]) => number, x0: number[], iters = 400, step = 0.5): { x: number[]; fx: number } {
  const n = x0.length;
  let pts = [x0, ...x0.map((_, i) => x0.map((v, j) => (i === j ? v + step : v)))].map((x) => ({ x, fx: f(x) }));
  for (let k = 0; k < iters; k++) {
    pts.sort((a, b) => a.fx - b.fx);
    if (Math.abs(pts[n].fx - pts[0].fx) < 1e-9 * (1 + Math.abs(pts[0].fx))) break;
    const cen = new Array(n).fill(0);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) cen[j] += pts[i].x[j] / n;
    const worst = pts[n];
    const at = (t: number) => cen.map((c, j) => c + t * (worst.x[j] - c));
    const r = { x: at(-1), fx: 0 };
    r.fx = f(r.x);
    if (r.fx < pts[0].fx) {
      const e = { x: at(-2), fx: 0 };
      e.fx = f(e.x);
      pts[n] = e.fx < r.fx ? e : r;
    } else if (r.fx < pts[n - 1].fx) pts[n] = r;
    else {
      const ct = { x: at(r.fx < worst.fx ? -0.5 : 0.5), fx: 0 };
      ct.fx = f(ct.x);
      if (ct.fx < Math.min(worst.fx, r.fx)) pts[n] = ct;
      else pts = pts.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => pts[0].x[j] + 0.5 * (v - pts[0].x[j])), fx: 0 })).map((p, i) => (i === 0 ? p : { ...p, fx: f(p.x) }));
    }
  }
  pts.sort((a, b) => a.fx - b.fx);
  return pts[0];
}

const sig = (u: number) => 1 / (1 + Math.exp(-u));

/** unconstrained search coordinates → model parameters (always stationary, α ≥ 0, α + γ ≥ 0) */
function params(u: number[], kind: GarchKind, dist: GarchDist) {
  const p = 0.999 * sig(u[0]);
  const s = p * sig(u[1]);
  const a = kind === 'gjr' ? Math.tanh(u[2]) : 0;
  const alpha = s * (1 - a);
  const gamma = 2 * s * a;
  const beta = p - s;
  // ν above 200 is a normal for every practical purpose (and keeps the log-gamma terms precise)
  const nu = dist === 't' ? Math.min(200, 2.1 + Math.exp(u[kind === 'gjr' ? 3 : 2])) : Infinity;
  return { alpha, beta, gamma, nu, p };
}

/** the conditional variance of each bar, from the bars before it */
export function filterVar(eps: ArrayLike<number>, omega: number, alpha: number, beta: number, gamma: number, h0: number): Float64Array {
  const h = new Float64Array(eps.length);
  let prev = h0;
  let e = 0;
  for (let t = 0; t < eps.length; t++) {
    const v = t === 0 ? h0 : omega + (alpha + (e < 0 ? gamma : 0)) * e * e + beta * prev;
    h[t] = Math.max(v, 1e-14);
    prev = h[t];
    e = eps[t];
  }
  return h;
}

function logLik(eps: ArrayLike<number>, h: Float64Array, nu: number): number {
  let ll = 0;
  if (!Number.isFinite(nu)) {
    for (let t = 0; t < eps.length; t++) ll -= 0.5 * (Math.log(2 * Math.PI) + Math.log(h[t]) + (eps[t] * eps[t]) / h[t]);
    return ll;
  }
  const c = lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(Math.PI * (nu - 2));
  for (let t = 0; t < eps.length; t++) ll += c - 0.5 * Math.log(h[t]) - ((nu + 1) / 2) * Math.log(1 + (eps[t] * eps[t]) / ((nu - 2) * h[t]));
  return ll;
}

/** fit a GARCH model to returns (log returns per bar) */
export function fitGarch(returns: ArrayLike<number>, kind: GarchKind = 'gjr', dist: GarchDist = 't'): GarchFit | null {
  const r = Array.from(returns).filter(Number.isFinite);
  const n = r.length;
  if (n < 100) return null;
  const mu = r.reduce((a, b) => a + b, 0) / n;
  const eps = r.map((x) => x - mu);
  const V = eps.reduce((a, b) => a + b * b, 0) / n;
  if (!(V > 0)) return null;
  const k = (kind === 'gjr' ? 3 : 2) + (dist === 't' ? 1 : 0);
  const nll = (u: number[]) => {
    const q = params(u, kind, dist);
    const omega = V * (1 - q.alpha - q.beta - q.gamma / 2);
    if (!(omega > 0)) return 1e12;
    const h = filterVar(eps, omega, q.alpha, q.beta, q.gamma, V);
    const v = -logLik(eps, h, q.nu);
    return Number.isFinite(v) ? v : 1e12;
  };
  // a few starts: persistence ~0.95–0.99, a news share of ~5–15 %
  let best: { x: number[]; fx: number } | null = null;
  for (const start of [
    [3, -2.5, 0, 1.5],
    [4.5, -3, 0.3, 2],
    [2, -1.5, -0.3, 1],
  ]) {
    const x0 = start.slice(0, k);
    const r0 = nelderMead(nll, x0, 350);
    if (!best || r0.fx < best.fx) best = r0;
  }
  const q = params(best!.x, kind, dist);
  const omega = V * (1 - q.alpha - q.beta - q.gamma / 2);
  const h = filterVar(eps, omega, q.alpha, q.beta, q.gamma, V);
  const last = eps[n - 1];
  const nextVar = omega + (q.alpha + (last < 0 ? q.gamma : 0)) * last * last + q.beta * h[n - 1];
  const ll = -best!.fx;
  const pers = q.alpha + q.beta + q.gamma / 2;
  return {
    kind,
    dist,
    omega,
    alpha: q.alpha,
    beta: q.beta,
    gamma: q.gamma,
    nu: q.nu,
    mu,
    longRun: V,
    persistence: pers,
    halfLife: pers > 0 && pers < 1 ? Math.log(0.5) / Math.log(pers) : Infinity,
    logLik: ll,
    aic: 2 * k - 2 * ll,
    bic: k * Math.log(n) - 2 * ll,
    n,
    nextVar,
    lastEps: last,
    lastVar: h[n - 1],
  };
}

/** the best of GARCH and GJR, normal and t errors, by BIC */
export function fitBest(returns: ArrayLike<number>): GarchFit | null {
  const fits = (['garch', 'gjr'] as const).flatMap((k) => (['normal', 't'] as const).map((d) => fitGarch(returns, k, d))).filter(Boolean) as GarchFit[];
  return fits.sort((a, b) => a.bic - b.bic)[0] ?? null;
}

/** the conditional variance of every bar of a return series, with fitted parameters (no look-ahead) */
export function garchVar(fit: GarchFit, returns: ArrayLike<number>): Float64Array {
  const eps = Array.from(returns, (x) => (Number.isFinite(x) ? x - fit.mu : 0));
  return filterVar(eps, fit.omega, fit.alpha, fit.beta, fit.gamma, fit.longRun);
}

/** expected variance of each of the next `steps` bars, starting from next-bar variance h1 */
export function forecastPath(fit: GarchFit, h1: number, steps: number): number[] {
  const out: number[] = [];
  let h = h1;
  for (let k = 0; k < steps; k++) {
    out.push(h);
    h = fit.longRun + fit.persistence * (h - fit.longRun);
  }
  return out;
}

/** volatility (standard deviation of the summed return) over the next `steps` bars */
export const horizonVol = (fit: GarchFit, h1: number, steps: number) => Math.sqrt(forecastPath(fit, h1, steps).reduce((a, b) => a + b, 0));

/** the quantile of the standardised error distribution (normal, or unit-variance t) */
export function errQuantile(fit: GarchFit, p: number): number {
  if (!Number.isFinite(fit.nu) || fit.nu > 100) return normInv(p);
  // unit-variance Student-t quantile, by bisection on its CDF (numerical)
  const nu = fit.nu;
  const scale = Math.sqrt((nu - 2) / nu);
  const k0 = lgamma((nu + 1) / 2) - lgamma(nu / 2) - 0.5 * Math.log(nu * Math.PI);
  const pdf = (x: number) => Math.exp(k0 - ((nu + 1) / 2) * Math.log(1 + (x * x) / nu));
  const cdf = (x: number) => {
    // Simpson integration from 0 (symmetric)
    const m = 200;
    const a = 0;
    const b = Math.abs(x);
    let s = pdf(a) + pdf(b);
    for (let i = 1; i < m; i++) s += (i % 2 ? 4 : 2) * pdf(a + ((b - a) * i) / m);
    const half = ((b - a) / (3 * m)) * s;
    return x >= 0 ? 0.5 + half : 0.5 - half;
  };
  let lo = -60;
  let hi = 60;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * scale;
}

function normInv(p: number): number {
  // Acklam (shared with stats.ts; repeated to keep this module free-standing)
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  if (p < 0.02425) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - 0.02425) return -normInv(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** value at risk over `steps` bars at level p (e.g. 0.99), as a positive fraction of price */
export function valueAtRisk(fit: GarchFit, h1: number, steps: number, p = 0.99): number {
  const sd = horizonVol(fit, h1, steps);
  return Math.max(0, -(fit.mu * steps + errQuantile(fit, 1 - p) * sd));
}

/**
 * Intraday seasonality: how volatile each hour of the UTC day is relative to
 * the average (Andersen & Bollerslev 1997). 24 multipliers on the variance.
 */
export function hourProfile(times: ArrayLike<number>, returns: ArrayLike<number>): number[] {
  const s = new Array(24).fill(0);
  const c = new Array(24).fill(0);
  for (let i = 0; i < returns.length; i++) {
    if (!Number.isFinite(returns[i])) continue;
    const h = new Date(times[i]).getUTCHours();
    s[h] += returns[i] * returns[i];
    c[h]++;
  }
  const per = s.map((x, h) => (c[h] ? x / c[h] : NaN));
  const m = per.filter(Number.isFinite).reduce((a, b) => a + b, 0) / (per.filter(Number.isFinite).length || 1);
  return per.map((x) => (Number.isFinite(x) && m > 0 ? x / m : 1));
}

/**
 * Filtered historical simulation: `n` bars of returns with the fitted
 * volatility dynamics, driven by the series' own standardised shocks drawn at
 * random — realistic clustering and tails, no drift, no predictability. Also
 * returns which historical bar each shock came from (to borrow its candle
 * shape and volume).
 */
export function simulate(fit: GarchFit, stdResid: number[], n: number, seed = 1): { r: Float64Array; from: Int32Array } {
  const rnd = rngOf(seed);
  const r = new Float64Array(n);
  const from = new Int32Array(n);
  let h = fit.longRun;
  let e = 0;
  for (let t = 0; t < n; t++) {
    if (t) h = fit.omega + (fit.alpha + (e < 0 ? fit.gamma : 0)) * e * e + fit.beta * h;
    const k = Math.floor(rnd() * stdResid.length);
    from[t] = k;
    e = Math.sqrt(h) * stdResid[k];
    r[t] = e;
  }
  return { r, from };
}

export interface ForecastTest {
  bars: number;
  /** mean QLIKE loss of each forecast (lower is better) */
  qlike: { garch: number; ewma: number; rolling: number };
  /** Diebold–Mariano t of GARCH against the better of the two simple forecasts (negative: GARCH better) */
  dm: number;
  winner: 'GARCH' | 'EWMA' | 'rolling';
}

/**
 * Does GARCH forecast the next bar's variance better than simple estimates?
 * Fit on returns before `split`, then one-step forecasts after it against an
 * exponentially weighted average (RiskMetrics, λ = 0.94) and a rolling one.
 * QLIKE loss on squared returns (robust to the noisy proxy; Patton 2011).
 */
export function forecastTest(returns: ArrayLike<number>, split: number, window = 168): ForecastTest | null {
  const r = Array.from(returns, (x) => (Number.isFinite(x) ? x : 0));
  if (split < 300 || r.length - split < 100) return null;
  const fit = fitBest(r.slice(0, split));
  if (!fit) return null;
  const h = garchVar(fit, r);
  const lam = 0.94;
  let ew = fit.longRun;
  let roll = 0;
  const lg: number[] = [];
  const le: number[] = [];
  const lr: number[] = [];
  const ql = (x: number, f: number) => {
    const q = Math.max(x * x, 1e-12) / Math.max(f, 1e-14);
    return q - Math.log(q) - 1;
  };
  for (let t = 1; t < r.length; t++) {
    ew = lam * ew + (1 - lam) * r[t - 1] * r[t - 1];
    roll += r[t - 1] * r[t - 1] - (t - 1 - window >= 0 ? r[t - 1 - window] ** 2 : 0);
    if (t < split) continue;
    const rv = roll / Math.min(window, t);
    lg.push(ql(r[t] - fit.mu, h[t]));
    le.push(ql(r[t] - fit.mu, ew));
    lr.push(ql(r[t] - fit.mu, rv));
  }
  const m = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
  const q = { garch: m(lg), ewma: m(le), rolling: m(lr) };
  const other = q.ewma < q.rolling ? le : lr;
  const dm = nwT(lg.map((x, i) => x - other[i]));
  const winner = q.garch <= Math.min(q.ewma, q.rolling) ? 'GARCH' : q.ewma < q.rolling ? 'EWMA' : 'rolling';
  return { bars: lg.length, qlike: q, dm, winner };
}
