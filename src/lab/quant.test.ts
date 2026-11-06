import { describe, expect, it } from 'vitest';
import { fitGarch } from './garch';
import { rngOf } from './ml';
import {
  blackScholes,
  deltaHedge,
  fitHmm2,
  hmmFilter,
  hurstRS,
  impliedVol,
  kalmanTrend,
  kellyBet,
  ouRolling,
  trendT,
  varBacktest,
  varCornishFisher,
  varForecasts,
  varHistorical,
  varianceRatio,
  varNormal,
  volEstimate,
  volTargetWeight,
} from './quant';

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

describe('quant: trend and reversion', () => {
  it('the Kalman slope finds a drift and its t is large; a random walk’s is not', () => {
    const rnd = rngOf(1);
    let p = 0;
    const up = Array.from({ length: 3000 }, () => (p += 0.002 + 0.005 * gauss(rnd)));
    const k = kalmanTrend(up, 1e-6, 0.005 ** 2);
    const avg = Array.from(k.slope.slice(1000)).reduce((x, y) => x + y, 0) / 2000;
    expect(avg).toBeGreaterThan(0.0015);
    expect(avg).toBeLessThan(0.0025);
    expect(k.slope[2999] / k.slopeSd[2999]).toBeGreaterThan(2);
    const tt = trendT(up, 200);
    expect(tt[2999]).toBeGreaterThan(5);
  });

  it('fits an Ornstein–Uhlenbeck process: half-life and s-score', () => {
    const rnd = rngOf(2);
    const b = 0.95; // half-life ln2/−ln(0.95) ≈ 13.5 bars
    let x = 0;
    const xs = Array.from({ length: 4000 }, () => (x = b * x + 0.01 * gauss(rnd)));
    const o = ouRolling(xs, 2000);
    expect(o.halfLife[3999]).toBeGreaterThan(9);
    expect(o.halfLife[3999]).toBeLessThan(20);
    // the s-score is the price's distance from equilibrium in equilibrium σ
    const sdEq = 0.01 / Math.sqrt(1 - b * b);
    expect(o.s[3999]).toBeCloseTo((xs[3999] - o.mu[3999]) / sdEq, 0);
  });

  it('the variance ratio and Hurst tell trending from reverting from random', () => {
    const rnd = rngOf(3);
    const n = 6000;
    const rw = Array.from({ length: n }, () => gauss(rnd));
    // persistent returns: AR(1) with +0.3; anti-persistent: −0.3
    let a = 0;
    const tr = rw.map((e) => (a = 0.3 * a + e));
    let c = 0;
    const mr = rw.map((e) => (c = -0.3 * c + e));
    const last = (r: number[]) => varianceRatio(r, 8, 2000).vr[n - 1];
    expect(last(tr)).toBeGreaterThan(1.3);
    expect(last(mr)).toBeLessThan(0.75);
    expect(Math.abs(last(rw) - 1)).toBeLessThan(0.2);
    expect(hurstRS(tr)).toBeGreaterThan(hurstRS(rw));
    expect(hurstRS(mr)).toBeLessThan(hurstRS(rw));
  });

  it('a two-state hidden Markov model finds calm and storm, filtering forward only', () => {
    const rnd = rngOf(4);
    const r: number[] = [];
    const truth: number[] = [];
    let s = 0;
    for (let t = 0; t < 5000; t++) {
      if (rnd() < (s ? 0.02 : 0.01)) s = 1 - s;
      truth.push(s);
      r.push(gauss(rnd) * (s ? 0.03 : 0.008));
    }
    const m = fitHmm2(r)!;
    expect(m.sd[0]).toBeGreaterThan(0.006);
    expect(m.sd[0]).toBeLessThan(0.011);
    expect(m.sd[1]).toBeGreaterThan(0.024);
    expect(m.P[0][0]).toBeGreaterThan(0.95);
    const p = hmmFilter(m, r);
    const right = truth.filter((x, t) => (p[t] > 0.5 ? 1 : 0) === x).length / truth.length;
    expect(right).toBeGreaterThan(0.85);
    // forward only: changing the future leaves the past alone
    const q = hmmFilter(m, [...r.slice(0, 3000), ...r.slice(3000).map((x) => x * 5)]);
    for (let t = 0; t < 3000; t++) expect(q[t]).toBe(p[t]);
  });
});

describe('quant: volatility and risk', () => {
  const bars = (() => {
    const rnd = rngOf(5);
    let p = 100;
    return Array.from({ length: 3000 }, () => {
      // 30 sub-steps a bar, σ 0.002 each → bar σ ≈ 0.011
      const o = p;
      let hi = p;
      let lo = p;
      for (let k = 0; k < 30; k++) {
        p *= Math.exp(0.002 * gauss(rnd));
        hi = Math.max(hi, p);
        lo = Math.min(lo, p);
      }
      return { open: o, high: hi, low: lo, close: p };
    });
  })();

  it('range estimators agree with close-to-close on a random walk', () => {
    const want = 0.002 * Math.sqrt(30);
    for (const k of ['close', 'parkinson', 'garmanKlass', 'rogersSatchell', 'yangZhang'] as const) {
      const v = volEstimate(bars, 500, k)[2999];
      // discrete sampling biases the range estimators down a little
      expect(v / want).toBeGreaterThan(0.8);
      expect(v / want).toBeLessThan(1.15);
    }
    expect(volTargetWeight(0.01, 0.5, 8760)).toBeCloseTo(0.5 / Math.sqrt(8760) / 0.01, 10);
    expect(volTargetWeight(1e-6, 0.5, 8760)).toBe(3);
  });

  it('value at risk: normal matches the textbook, Cornish–Fisher reduces to it without skew or kurtosis', () => {
    const n = varNormal(0, 0.02, 0.99);
    expect(n.var).toBeCloseTo(0.02 * 2.3263, 4);
    expect(n.es).toBeGreaterThan(n.var);
    const cf = varCornishFisher(0, 0.02, 0, 0, 0.99);
    expect(cf.var).toBeCloseTo(n.var, 6);
    expect(varCornishFisher(0, 0.02, -0.5, 5, 0.99).var).toBeGreaterThan(n.var);
    const h = varHistorical(Array.from({ length: 1000 }, (_, i) => (i - 500) / 10000), 0.99);
    expect(h.var).toBeCloseTo(0.049, 2);
  });

  it('Kupiec and Christoffersen pass a right model and reject a wrong one', () => {
    const rnd = rngOf(6);
    const r = Array.from({ length: 4000 }, () => 0.01 * gauss(rnd));
    const good = r.map(() => 0.01 * 2.3263);
    const bad = r.map(() => 0.01 * 1.2);
    expect(varBacktest(r, good, 0.99)!.kupiecP).toBeGreaterThan(0.05);
    expect(varBacktest(r, bad, 0.99)!.kupiecP).toBeLessThan(0.001);
    // GARCH forecasts on GARCH data cover correctly
    const rr: number[] = [];
    let hv = 1e-4;
    let e = 0;
    for (let t = 0; t < 5000; t++) {
      hv = 1e-4 * 0.02 + 0.08 * e * e + 0.9 * hv;
      e = Math.sqrt(hv) * gauss(rnd);
      rr.push(e);
    }
    const fit = fitGarch(rr.slice(0, 3000), 'garch', 'normal')!;
    const g = varBacktest(rr.slice(3000), varForecasts(rr, 3000, 0.99, 'garch', 500, fit).slice(3000), 0.99)!;
    expect(g.kupiecP).toBeGreaterThan(0.01);
    expect(g.ccP).toBeGreaterThan(0.01);
  });
});

describe('quant: options and sizing', () => {
  it('Black–Scholes: put–call parity, greeks and implied volatility', () => {
    const c = blackScholes(100, 105, 0.25, 0.6, 'call');
    const p = blackScholes(100, 105, 0.25, 0.6, 'put');
    expect(c.price - p.price).toBeCloseTo(100 - 105, 8);
    expect(c.delta - p.delta).toBeCloseTo(1, 8);
    expect(c.gamma).toBeCloseTo(p.gamma, 10);
    const bump = (blackScholes(100.01, 105, 0.25, 0.6, 'call').price - blackScholes(99.99, 105, 0.25, 0.6, 'call').price) / 0.02;
    expect(c.delta).toBeCloseTo(bump, 4);
    expect(impliedVol(c.price, 100, 105, 0.25, 'call')).toBeCloseTo(0.6, 4);
  });

  it('delta hedging: a short straddle earns when realised volatility is below the implied, and hedging more often cuts the noise', () => {
    const run = (realised: number, every: number, seed: number) => {
      const rnd = rngOf(seed);
      const bar = 1 / 8760;
      let s = 100;
      const px = [s];
      for (let i = 0; i < 24 * 14; i++) px.push((s *= Math.exp(realised * Math.sqrt(bar) * gauss(rnd) - 0.5 * realised * realised * bar)));
      return deltaHedge(px, { strikePct: 1, iv: 0.6, kind: 'straddle', side: -1, every, barYears: bar })!;
    };
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = (xs: number[]) => Math.sqrt(mean(xs.map((x) => (x - mean(xs)) ** 2)));
    const cheap = Array.from({ length: 60 }, (_, k) => run(0.4, 1, k).final);
    const dear = Array.from({ length: 60 }, (_, k) => run(0.8, 1, k).final);
    expect(mean(cheap)).toBeGreaterThan(0);
    expect(mean(dear)).toBeLessThan(0);
    const hourly = Array.from({ length: 60 }, (_, k) => run(0.6, 1, 100 + k).final);
    const daily = Array.from({ length: 60 }, (_, k) => run(0.6, 24, 100 + k).final);
    expect(sd(hourly)).toBeLessThan(sd(daily));
    expect(run(0.6, 1, 1).realised).toBeGreaterThan(0.4);
  });

  it('Kelly', () => {
    expect(kellyBet(0.5, 2, 1)).toBeCloseTo(0.25, 10);
    expect(kellyBet(0.4, 1, 1)).toBeLessThan(0);
  });
});
