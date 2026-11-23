// The heavy maths behind the volatility and risk panels (GARCH fits, regime models,
// value-at-risk backtests), as plain functions of the candles. They run on a separate thread
// (compute.worker.ts) so the terminal never stops answering while they work: a GARCH fit
// takes tens of milliseconds a coin, and a panel of ten coins refitting every five minutes
// used to freeze the page — the mouse included — for a second or more.
import type { Kline } from "../core/types";
import {
  fitModel,
  forecastPath,
  garchVar,
  horizonVol,
  hourProfile,
  valueAtRisk,
  type GarchFit,
} from "../lab/garch";
import {
  fitHmm2,
  hmmDuration,
  hmmFilter,
  hurstRS,
  moments4,
  ouRolling,
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
  type VarMethod,
  type VarResult,
} from "../lab/quant";

export type GarchModel = "best" | "garch" | "gjr";
const HOURS_A_YEAR = 24 * 365;
const logR = (k: Kline[]) =>
  k.slice(1).map((x, i) => Math.log(x.close / k[i].close));
/** overlapping h-bar sums */
export const agg = (r: number[], h: number) => {
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

// ---------- GV — GARCH volatility ----------

export interface CoinVol {
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

function analyse(
  coin: string,
  k: Kline[],
  ahead: number,
  model: GarchModel = "best",
): CoinVol | null {
  if (k.length < 300) return null;
  const lr = k.slice(1).map((x, i) => Math.log(x.close / k[i].close));
  const fit = fitModel(lr, model === "best" ? undefined : model);
  if (!fit) return null;
  const bpy = 24 * 365;
  const h = garchVar(fit, lr);
  const last = lr[lr.length - 1] - fit.mu;
  const h1 =
    fit.omega +
    (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last +
    fit.beta * h[h.length - 1];
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

// ---------- VAR — value at risk ----------

export interface CoinVar {
  coin: string;
  r: number[];
  fit: GarchFit | null;
  by: Record<VarMethod, VarResult>;
}

function coinVar(
  coin: string,
  k: Kline[],
  conf: number,
  h: number,
): CoinVar | null {
  if (k.length < 300) return null;
  const r = logR(k);
  const fit = fitModel(r);
  const a = agg(r, h);
  const m1 = moments4(r);
  const ma = moments4(a);
  let ew = NaN;
  for (const x of r)
    ew = Number.isFinite(ew) ? 0.94 * ew + 0.06 * x * x : x * x;
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
    const h1 =
      fit.omega +
      (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last +
      fit.beta * hv[hv.length - 1];
    const one = varGarch(fit, h1, conf);
    const v = valueAtRisk(fit, h1, h, conf);
    by.garch = { var: v, es: one.var > 0 ? (v * one.es) / one.var : v };
  }
  return { coin, r, fit, by };
}

function varBacktestAll(r: number[], fit: GarchFit | null, conf: number) {
  const n = r.length;
  const from = Math.max(300, n - 500);
  return VAR_METHODS.map((m) => {
    const f = varForecasts(r, from, conf, m.id, 300, fit);
    return {
      m,
      f,
      t: varBacktest(r.slice(from), Array.from(f.slice(from)), conf),
    };
  });
}

// ---------- REGM — regimes ----------

export interface RegRow {
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

// ---------- VTGT — volatility targeting ----------

function volTarget(bars: Kline[], tgt: number, cap: number) {
  if (bars.length < 400) return null;
  const r = logR(bars);
  const fit = fitModel(r);
  const h = fit ? garchVar(fit, r) : null;
  const ann = (x: number) => x * Math.sqrt(HOURS_A_YEAR);
  const est = VOL_KINDS.map((v) => ({
    id: v.id,
    name: v.name,
    cite: v.cite,
    day: ann(volEstimate(bars, 24, v.id)[bars.length - 1]),
    week: ann(volEstimate(bars, 168, v.id)[bars.length - 1]),
  }));
  let ew = NaN;
  for (const x of r)
    ew = Number.isFinite(ew) ? 0.94 * ew + 0.06 * x * x : x * x;
  let gNow = NaN;
  let gDay = NaN;
  if (fit && h) {
    const last = r[r.length - 1] - fit.mu;
    const h1 =
      fit.omega +
      (fit.alpha + (last < 0 ? fit.gamma : 0)) * last * last +
      fit.beta * h[h.length - 1];
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
    const want =
      sig > 0 ? Math.min(cap, tgt / Math.sqrt(HOURS_A_YEAR) / sig) : 1;
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
    return {
      ret: Math.exp(m.m * HOURS_A_YEAR) - 1,
      vol: m.s * Math.sqrt(HOURS_A_YEAR),
      sharpe: m.s > 0 ? (m.m / m.s) * Math.sqrt(HOURS_A_YEAR) : NaN,
      dd,
    };
  };
  return {
    est,
    ewma: ann(Math.sqrt(ew)),
    gNow,
    gDay,
    fit,
    bh,
    vt,
    sBh: stats(bh),
    sVt: stats(vt),
    avgW: wts.reduce((a, b) => a + b, 0) / Math.max(1, wts.length),
  };
}

// ---------- the tasks the panels ask for ----------

type Data = Record<string, Kline[]>;
const each = <T>(
  coins: string[],
  data: Data,
  f: (coin: string, k: Kline[]) => T | null,
) =>
  coins.map((b) => (data[b] ? f(b, data[b]) : null)).filter((x): x is T => !!x);

export const TASKS = {
  garchRows: (a: {
    coins: string[];
    data: Data;
    ahead: number;
    model: GarchModel;
  }) => each(a.coins, a.data, (b, k) => analyse(b, k, a.ahead, a.model)),
  varRows: (a: {
    coins: string[];
    data: Data;
    conf: number;
    horizon: number;
  }) => each(a.coins, a.data, (b, k) => coinVar(b, k, a.conf, a.horizon)),
  varBacktest: (a: { r: number[]; fit: GarchFit | null; conf: number }) =>
    varBacktestAll(a.r, a.fit, a.conf),
  regimeRows: (a: { coins: string[]; data: Data }) =>
    each(a.coins, a.data, regRow),
  garchModel: (a: { bars: Kline[] }) => {
    const r = logR(a.bars);
    const fit = fitModel(r);
    return { r, fit, h: fit ? garchVar(fit, r) : null };
  },
  volTarget: (a: { bars: Kline[]; tgt: number; cap: number }) =>
    volTarget(a.bars, a.tgt, a.cap),
};
export type TaskName = keyof typeof TASKS;
export type TaskArgs<K extends TaskName> = Parameters<(typeof TASKS)[K]>[0];
export type TaskResult<K extends TaskName> = ReturnType<(typeof TASKS)[K]>;

/** a short fingerprint of the candles a panel works on: it changes when a candle is added or the last one moves */
export const dataKey = (data: Data, coins: string[]) =>
  coins
    .map((b) => {
      const k = data[b];
      return k?.length
        ? `${b}:${k.length}:${k[k.length - 1].time}:${k[k.length - 1].close}`
        : `${b}:-`;
    })
    .join("|");
