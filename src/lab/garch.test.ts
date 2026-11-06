import { describe, expect, it } from 'vitest';
import { candleForecast, candleShape } from './candles';
import { fitBest, fitGarch, forecastPath, forecastTest, garchVar, hourProfile, lgamma, valueAtRisk } from './garch';
import { ctxOf, garchSigma, type Market } from './library';
import { rngOf } from './ml';
import { garchWorld, research } from './research';
import { atr } from './series';

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** returns from a known GARCH(1,1), normal or Student-t (unit variance) errors */
function garchReturns(n: number, a: number, b: number, nu = Infinity, seed = 1) {
  const rnd = rngOf(seed);
  const V = 1e-4;
  const w = V * (1 - a - b);
  let h = V;
  let e = 0;
  const r: number[] = [];
  for (let t = 0; t < n; t++) {
    h = w + a * e * e + b * h;
    let z = gauss(rnd);
    if (Number.isFinite(nu)) {
      let chi = 0;
      for (let k = 0; k < nu; k++) chi += gauss(rnd) ** 2;
      z = (z / Math.sqrt(chi / nu)) * Math.sqrt((nu - 2) / nu);
    }
    e = Math.sqrt(h) * z;
    r.push(e);
  }
  return r;
}

function market(n: number, seed: number): Market {
  const r = garchReturns(n, 0.08, 0.9, Infinity, seed);
  const rnd = rngOf(seed + 5);
  let p = 100;
  const t0 = Date.UTC(2024, 0, 1);
  return {
    coin: 'X',
    tfH: 1,
    funding: null,
    bars: r.map((x, i) => {
      const o = p;
      p = o * Math.exp(x);
      return { time: t0 + i * 3_600_000, open: o, high: Math.max(o, p) * (1 + Math.abs(gauss(rnd)) * 0.002), low: Math.min(o, p) * (1 - Math.abs(gauss(rnd)) * 0.002), close: p, volume: 100 + 50 * rnd() };
    }),
  };
}

describe('GARCH', () => {
  it('has the log-gamma it needs', () => {
    expect(lgamma(5)).toBeCloseTo(Math.log(24), 8);
    expect(lgamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 8);
  });

  it('recovers the parameters of a known GARCH(1,1)', () => {
    const f = fitGarch(garchReturns(8000, 0.08, 0.9), 'garch', 'normal')!;
    expect(f.alpha).toBeGreaterThan(0.05);
    expect(f.alpha).toBeLessThan(0.12);
    expect(f.beta).toBeGreaterThan(0.85);
    expect(f.beta).toBeLessThan(0.94);
    expect(f.persistence).toBeLessThan(1);
    expect(f.halfLife).toBeGreaterThan(10);
  });

  it('finds fat tails and prefers the t distribution when they are there', () => {
    const r = garchReturns(8000, 0.08, 0.9, 5, 3);
    const t = fitGarch(r, 'garch', 't')!;
    expect(t.nu).toBeGreaterThan(3);
    expect(t.nu).toBeLessThan(10);
    expect(fitBest(r)!.dist).toBe('t');
  });

  it('forecasts mean-revert to the long run, and value at risk grows with confidence and horizon', () => {
    const f = fitGarch(garchReturns(4000, 0.08, 0.9), 'garch', 'normal')!;
    const path = forecastPath(f, f.longRun * 4, 500);
    expect(path[0]).toBeCloseTo(f.longRun * 4, 12);
    expect(path[499] / f.longRun).toBeCloseTo(1, 2);
    expect(valueAtRisk(f, f.longRun, 24, 0.99)).toBeGreaterThan(valueAtRisk(f, f.longRun, 24, 0.95));
    expect(valueAtRisk(f, f.longRun, 24, 0.99)).toBeGreaterThan(valueAtRisk(f, f.longRun, 1, 0.99));
    // the filter uses only earlier shocks: a shock moves the next variance, not its own
    const h = garchVar(f, [0, 0, 0.05, 0, 0]);
    // (garchVar works on shocks around the mean, so a zero return is a tiny shock of −μ)
    expect(h[2] / (h[1] * f.beta + f.omega)).toBeCloseTo(1, 4);
    expect(h[3]).toBeGreaterThan(h[2]);
  });

  it('beats simple volatility forecasts on data that really is GARCH', () => {
    const t = forecastTest(garchReturns(6000, 0.1, 0.88, Infinity, 7), 4000)!;
    expect(t.winner).toBe('GARCH');
    expect(t.qlike.garch).toBeLessThan(t.qlike.rolling);
  });

  it('reads the hour-of-day pattern', () => {
    const times = Array.from({ length: 2400 }, (_, i) => i * 3_600_000);
    const r = times.map((_, i) => (new Date(times[i]).getUTCHours() === 14 ? 0.03 : 0.01) * (i % 2 ? 1 : -1));
    const p = hourProfile(times, r);
    expect(p[14]).toBeGreaterThan(5);
    expect(p[3]).toBeLessThan(1);
  });

  it('gives each bar the volatility of the NEXT bar, known at its close', () => {
    const m = market(1500, 2);
    const a = garchSigma(ctxOf(m, 1000));
    const changed: Market = { ...m, bars: m.bars.map((b, i) => (i > 1200 ? { ...b, close: b.close * 2 } : b)) };
    const b = garchSigma(ctxOf(changed, 1000));
    for (let i = 0; i <= 1200; i++) expect(a[i]).toBe(b[i]);
  });
});

describe('candles', () => {
  it('describes candle shapes and patterns', () => {
    const bars = [
      { time: 0, open: 10, high: 10.2, low: 8.9, close: 9, volume: 1 },
      { time: 1, open: 8.9, high: 10.6, low: 8.8, close: 10.5, volume: 1 }, // bullish engulfing
      { time: 2, open: 10.5, high: 10.9, low: 10.1, close: 10.52, volume: 1 }, // doji
      { time: 3, open: 10.5, high: 10.55, low: 9.6, close: 10.52, volume: 1 }, // hammer
    ];
    const s = candleShape(bars, [1, 1, 1, 1]);
    expect(s[1][7]).toBe(1);
    expect(s[2][8]).toBe(1);
    expect(s[3][9]).toBe(1);
    expect(s[1][0]).toBeGreaterThan(0.8);
    void atr;
  });

  it('forecasts the next candle and scores itself out of sample', () => {
    const m = market(3000, 4);
    const r = candleForecast(m, 2100);
    expect(r.eval!.n).toBeGreaterThan(500);
    expect(r.eval!.importance.length).toBeGreaterThan(20);
    // the range is predictable here (GARCH data): the model beats the last candle's range
    expect(r.eval!.rangeMae.model).toBeLessThan(r.eval!.rangeMae.naive);
    const nx = r.next!;
    expect(nx.high).toBeGreaterThanOrEqual(nx.open);
    expect(nx.low).toBeLessThanOrEqual(nx.open);
    expect(nx.pUp).toBeGreaterThan(0);
    expect(nx.pUp).toBeLessThan(1);
  });
});

describe('GARCH in the research', () => {
  it('builds GARCH worlds that keep the real past and simulate the rest', () => {
    const m = market(2000, 6);
    const c = ctxOf(m, 1400);
    const w = garchWorld(c, 1)!;
    expect(w.bars).toHaveLength(m.bars.length);
    expect(w.bars[1399]).toEqual(m.bars[1399]);
    expect(w.bars[1700].close).not.toBe(m.bars[1700].close);
    expect(w.bars[1700].time).toBe(m.bars[1700].time);
  });

  it('reports each coin’s volatility model and candle forecasts, and tests the leaders in GARCH worlds', async () => {
    const r = await research([market(3000, 8), { ...market(3000, 9), coin: 'Y' }], { combos: 30, finalists: 6, meta: false });
    expect(r.forecasting).toHaveLength(2);
    const g = r.forecasting[0].garch!;
    expect(g.persistence).toBeGreaterThan(0.8);
    expect(g.longRunAnn).toBeGreaterThan(0);
    expect(r.forecasting[0].candles?.eval).toBeTruthy();
    expect(r.top[0].checks.some((x) => /GARCH worlds/.test(x.name))).toBe(true);
    expect(r.top.filter((t) => t.garchNull).length).toBeGreaterThan(0);
    // GARCH data has no edge in it: nothing should be called one
    expect(r.top.filter((t) => t.verdict === 'edge')).toHaveLength(0);
  }, 180_000);
});
