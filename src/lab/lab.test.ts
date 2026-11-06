import { describe, expect, it } from 'vitest';
import { backtest, COSTS, type StrategySpec } from './backtest';
import { ctxOf, EXIT_DEFAULT, FILTERS, gridOf, SIGNALS, type Market } from './library';
import { liveSignal, manageLab } from './live';
import { fitForest, fitRidge, predictForest, predictRidge, regress, rngOf } from './ml';
import { PAPERS } from './papers';
import { research } from './research';
import { atr, hiPrev, loPrev, rsi, sma } from './series';
import { deflatedSharpe, expectedMaxSharpe, monteCarlo, ncdf, ninv, nwT, pbo, perf, psr } from './stats';

/** hourly candles: a random walk, optionally with a slowly drifting trend that momentum can find */
function market(coin: string, n: number, seed: number, trend = 0): Market {
  const rnd = rngOf(seed);
  const g = () => {
    const u = Math.max(1e-9, rnd());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  let p = 100;
  let mu = 0;
  const t0 = Date.UTC(2023, 0, 1);
  const bars = [];
  for (let i = 0; i < n; i++) {
    mu = 0.995 * mu + trend * 0.0006 * g();
    const r = mu + 0.006 * g();
    const o = p;
    p = p * Math.exp(r);
    const hi = Math.max(o, p) * (1 + Math.abs(g()) * 0.002);
    const lo = Math.min(o, p) * (1 - Math.abs(g()) * 0.002);
    bars.push({ time: t0 + i * 3_600_000, open: o, high: hi, low: lo, close: p, volume: 100 * (1 + Math.abs(g())) });
  }
  return { coin, tfH: 1, bars, funding: null };
}

describe('series', () => {
  it('computes averages, RSI, ATR and channels without looking ahead', () => {
    expect(Array.from(sma([1, 2, 3, 4], 2)).slice(1)).toEqual([1.5, 2.5, 3.5]);
    const up = rsi([1, 2, 3, 4, 5, 6], 3);
    expect(up[5]).toBe(100);
    const bars = [5, 7, 6, 9, 8].map((c, i) => ({ time: i, open: c, high: c + 1, low: c - 1, close: c, volume: 1 }));
    const hi = hiPrev(bars, 2);
    const lo = loPrev(bars, 2);
    // bar 3's channel is bars 1 and 2 only
    expect(hi[3]).toBe(8);
    expect(lo[3]).toBe(5);
    expect(atr(bars, 2)[4]).toBeGreaterThan(0);
  });
});

describe('the library', () => {
  it('cites a paper for every rule and filter', () => {
    for (const s of [...SIGNALS, ...FILTERS]) {
      expect(s.papers.length).toBeGreaterThan(0);
      for (const p of s.papers) expect(PAPERS[p], `${s.id} cites ${p}`).toBeTruthy();
      expect(s.rationale.length).toBeGreaterThan(20);
    }
    expect(SIGNALS.length).toBeGreaterThanOrEqual(15);
  });

  it('never uses a future bar: changing the future does not change past signals', () => {
    const m = market('X', 1500, 3, 1);
    const cut = 1200;
    const future: Market = { ...m, bars: m.bars.map((b, i) => (i > cut ? { ...b, close: b.close * 1.5, high: b.high * 1.5, low: b.low * 0.6 } : b)) };
    for (const s of SIGNALS) {
      if (s.needsFunding) continue;
      const p = gridOf(s.grid)[0];
      // learned rules train before trainEnd; give both the same training window
      const a = s.compute(ctxOf(m, 1000), p);
      const b = s.compute(ctxOf(future, 1000), p);
      for (let i = 0; i <= cut; i++) expect(a[i], `${s.id} at ${i}`).toBe(b[i]);
    }
  });
});

describe('the backtester', () => {
  const spec = (id: string, p: Record<string, number>, exit = {}): StrategySpec => ({ name: id, signal: { id, p }, filters: [], exit: { ...EXIT_DEFAULT, ...exit }, sides: 'both' });

  it('enters at the next bar open and charges fees and slippage', () => {
    const m = market('X', 2000, 9, 1);
    const c = ctxOf(m);
    const r = backtest(c, spec('tsmom', { lookback: 72 }), 50, 2000);
    expect(r.trades.length).toBeGreaterThan(5);
    for (const t of r.trades) {
      expect(t.entryI).toBe(t.sig + 1);
      expect(t.exitI).toBeGreaterThanOrEqual(t.entryI);
    }
    const free = backtest(ctxOf(m), spec('tsmom', { lookback: 72 }), 50, 2000, { feeBps: 0, slipBps: 0 });
    const sum = (x: Float64Array) => x.reduce((a, b) => a + b, 0);
    expect(sum(free.rets)).toBeGreaterThan(sum(r.rets));
  });

  it('honours stops and targets', () => {
    const m = market('X', 2000, 4, 1);
    const r = backtest(ctxOf(m), spec('zrev', { lookback: 24, k: 2 }, { stopAtr: 1, targetR: 1, maxBars: 1000, onFlip: false }), 50, 2000);
    for (const t of r.trades) {
      if (t.reason === 'target') expect(t.r).toBeGreaterThan(0.5);
      if (t.reason === 'stop') expect(t.r).toBeLessThan(0);
    }
  });
});

describe('statistics', () => {
  it('has a consistent normal distribution', () => {
    for (const p of [0.01, 0.2, 0.5, 0.9, 0.999]) expect(ncdf(ninv(p))).toBeCloseTo(p, 4);
  });
  it('reads significance honestly', () => {
    const rnd = rngOf(1);
    const noise = Array.from({ length: 5000 }, () => rnd() - 0.5);
    expect(Math.abs(nwT(noise))).toBeLessThan(3);
    const drift = noise.map((x) => x + 0.05);
    expect(nwT(drift)).toBeGreaterThan(5);
    expect(psr(0, 1000, 0, 3)).toBeCloseTo(0.5, 5);
    // the more strategies tried, the higher the bar
    expect(expectedMaxSharpe(1000, 0.01)).toBeGreaterThan(expectedMaxSharpe(10, 0.01));
    const p = perf(drift.map((x) => x / 100), [], 8760);
    expect(deflatedSharpe(p, 500, 0.0004)).toBeLessThanOrEqual(p.psr);
  });
  it('simulates trade sequences and overfitting', () => {
    const mc = monteCarlo([1, -1, 2, -1, 1.5, -1, 1, -1, 2, -1], 500);
    expect(mc!.p5).toBeLessThan(mc!.p50);
    expect(mc!.p50).toBeLessThan(mc!.p95);
    expect(mc!.fan.length).toBeGreaterThan(5);
    // candidate 0 is best everywhere: never overfit
    const blocks = [Array(8).fill(0.01), ...Array.from({ length: 5 }, (_, k) => Array(8).fill(-0.001 * k))];
    expect(pbo(blocks)).toBe(0);
  });
});

describe('learners', () => {
  it('ridge regression recovers a linear rule and regress() measures alpha', () => {
    const rnd = rngOf(2);
    const X = Array.from({ length: 500 }, () => [rnd(), rnd()]);
    const y = X.map(([a, b]) => 2 * a - b + 0.5);
    const m = fitRidge(X, y, 1e-6);
    expect(predictRidge(m, [0.5, 0.5])).toBeCloseTo(1, 2);
    const x = Array.from({ length: 2000 }, () => rnd() - 0.5);
    const g = regress(x.map((v) => 0.01 + 0.5 * v), x);
    expect(g.beta).toBeCloseTo(0.5, 5);
    expect(g.alpha).toBeCloseTo(0.01, 5);
  });
  it('a random forest learns a threshold rule', () => {
    const rnd = rngOf(5);
    const X = Array.from({ length: 600 }, () => [rnd() - 0.5, rnd(), rnd()]);
    const y = X.map(([a]) => (a > 0 ? 1 : 0));
    const f = fitForest(X, y, { trees: 30 });
    expect(predictForest(f, [0.3, 0.5, 0.5])).toBeGreaterThan(0.8);
    expect(predictForest(f, [-0.3, 0.5, 0.5])).toBeLessThan(0.2);
    expect(f.oob!).toBeGreaterThan(0.9);
    expect(f.importance[0]).toBeGreaterThan(0.5);
  });
});

describe('research', () => {
  it('does not call a random walk an edge', async () => {
    const r = await research([market('A', 3000, 11), market('B', 3000, 12)], { combos: 40, finalists: 8, meta: false });
    expect(r.top.length).toBeGreaterThan(0);
    expect(r.top.filter((t) => t.verdict === 'edge').length).toBe(0);
    expect(r.library.length).toBe(SIGNALS.length);
    expect(r.trials).toBeGreaterThan(40);
  }, 60_000);

  it('finds momentum where momentum exists, and the result deploys live', async () => {
    const ms = [market('A', 4000, 21, 3), market('B', 4000, 22, 3)];
    const r = await research(ms, { combos: 60, finalists: 10, meta: true });
    const best = r.top[0];
    expect(best.oos.sharpe).toBeGreaterThan(0);
    expect(['momentum', 'trend', 'breakout', 'ml']).toContain(best.family);
    expect(best.rules[0]).toMatch(/^Entry: /);
    expect(best.curve.length).toBeGreaterThan(10);
    // live: on the last bar there is either no new signal or a complete one
    const s = liveSignal(best.spec, ms[0]);
    if (s) {
      expect(['buy', 'sell']).toContain(s.side);
      expect((s.price - s.stop) * (s.side === 'buy' ? 1 : -1)).toBeGreaterThan(0);
    }
    const pos = { side: 'buy' as const, entry: 100, stop: 95, target: 110, risk: 5, atr: 2, openedAt: 0 };
    expect(manageLab({ ...pos }, best.spec, 1, 94, 1000)).toEqual({ exit: 'stop' });
  }, 120_000);
});

void COSTS;
