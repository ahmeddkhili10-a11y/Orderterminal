import { describe, expect, it } from 'vitest';
import { backtest, type StrategySpec } from './backtest';
import { barsPerYear, ctxOf, EXIT_DEFAULT, features, FEATURES, SIGNAL_MAP, type Market } from './library';
import { liveSignal } from './live';
import { rngOf } from './ml';
import { rulesOf } from './research';

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** bitcoin with clustered volatility, and a coin that is 1.2 × bitcoin plus its own noise */
function pair(n: number, seed: number) {
  const rnd = rngOf(seed);
  let b = 50000;
  let c = 10;
  let h = 1;
  let z = 0;
  const t0 = Date.UTC(2024, 0, 1);
  const btc: Market['bars'] = [];
  const coin: Market['bars'] = [];
  for (let i = 0; i < n; i++) {
    h = 0.05 + 0.1 * z * z + 0.85 * h;
    z = gauss(rnd);
    const rb = 0.006 * Math.sqrt(h) * z;
    const rc = 1.2 * rb + 0.004 * gauss(rnd);
    const ob = b;
    const oc = c;
    b *= Math.exp(rb);
    c *= Math.exp(rc);
    const t = t0 + i * 3_600_000;
    btc.push({ time: t, open: ob, high: Math.max(ob, b) * 1.001, low: Math.min(ob, b) * 0.999, close: b, volume: 100 });
    coin.push({ time: t, open: oc, high: Math.max(oc, c) * 1.001, low: Math.min(oc, c) * 0.999, close: c, volume: 100 });
  }
  return { btc, coin };
}

const corr = (a: number[], b: number[]) => {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let s = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] - ma) * (b[i] - mb);
    va += (a[i] - ma) ** 2;
    vb += (b[i] - mb) ** 2;
  }
  return s / Math.sqrt(va * vb);
};
const sd = (a: number[]) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
};

describe('sizing and hedging in the backtest', () => {
  const { btc, coin } = pair(4000, 3);
  const m: Market = { coin: 'X', tfH: 1, bars: coin, funding: null, bench: Float64Array.from(btc, (b) => b.close) };
  // hold one long position for the whole test (a signal that switches on once)
  const sig = Int8Array.from(coin, (_, i) => (i < 1601 ? 0 : 1));
  const spec = (over: Partial<StrategySpec>): StrategySpec => ({ name: 't', signal: { id: 'tsmom', p: { lookback: 24 } }, filters: [], exit: { ...EXIT_DEFAULT, stopAtr: 1000, maxBars: 100000, onFlip: false }, sides: 'both', ...over });
  const run = (over: Partial<StrategySpec>) => Array.from(backtest(ctxOf(m, 1400), spec(over), 1600, 4000, { feeBps: 0, slipBps: 0 }, undefined, sig).rets);
  const rb = Array.from({ length: 2400 }, (_, k) => btc[1600 + k].close / btc[1599 + k].close - 1);
  const live = (x: number[]) => x.slice(3);

  it('a delta hedge against bitcoin removes the market', () => {
    expect(corr(live(run({})), live(rb))).toBeGreaterThan(0.8);
    expect(Math.abs(corr(live(run({ hedge: 'btc' })), live(rb)))).toBeLessThan(0.2);
  });

  it('a volatility target runs the position near the target, steadier than unit size', () => {
    const target = 0.5;
    const v = live(run({ sizing: { mode: 'vol', target } }));
    const ann = sd(v) * Math.sqrt(barsPerYear(1));
    expect(ann / target).toBeGreaterThan(0.75);
    expect(ann / target).toBeLessThan(1.3);
    // rolling 100-bar volatility varies less than unit size's
    const roll = (x: number[]) => Array.from({ length: 23 }, (_, k) => sd(x.slice(k * 100, k * 100 + 100)));
    const cv = (x: number[]) => sd(x) / (x.reduce((a, b) => a + b, 0) / x.length);
    expect(cv(roll(v))).toBeLessThan(cv(roll(live(run({})))));
  });

  it('a VaR budget holds the day’s 99 % loss near the budget', () => {
    const v = live(run({ sizing: { mode: 'var', target: 0.05 } }));
    const day = Array.from({ length: 100 }, (_, k) => v.slice(k * 24, k * 24 + 24).reduce((a, b) => a + b, 0));
    const losses = day.map((x) => -x).sort((a, b) => b - a);
    // the worst day of 100 is about the 99 % loss
    expect(losses[0]).toBeGreaterThan(0.025);
    expect(losses[0]).toBeLessThan(0.1);
  });

  it('describes the sizing and the hedge, and the live signal carries the sizing', () => {
    const s = spec({ sizing: { mode: 'vol', target: 0.6 }, hedge: 'btc' });
    const rules = rulesOf(s, 1).join(' | ');
    expect(rules).toMatch(/60 % annual volatility/);
    expect(rules).toMatch(/short β × the position in bitcoin/);
    // live: find a bar where the rule fires
    const noBench = { ...m, bench: null };
    let found = null;
    for (let n = 1700; n < 4000 && !found; n += 7) found = liveSignal({ ...s, signal: { id: 'tsmom', p: { lookback: 24 } } }, { ...noBench, bars: coin.slice(0, n) });
    expect(found).toBeTruthy();
    expect(found!.sizeMult).toBeGreaterThanOrEqual(0.5);
    expect(found!.sizeMult).toBeLessThanOrEqual(1.5);
    expect(found!.why).toMatch(/volatility target/);
    expect(found!.why).toMatch(/does not place hedges/);
  });

  it('the new quant rules and features compute without looking ahead', () => {
    const c = ctxOf(m, 2000);
    const F = features(c);
    expect(F[3000]).toHaveLength(FEATURES.length);
    for (const id of ['kalman', 'ou']) {
      const def = SIGNAL_MAP[id];
      const p = Object.fromEntries(Object.entries(def.grid).map(([k, v]) => [k, v[0]]));
      const a = def.compute(ctxOf(m, 2000), p);
      const cut: Market = { ...m, bars: m.bars.map((b, i) => (i > 3000 ? { ...b, close: b.close * 3, open: b.open * 3, high: b.high * 3, low: b.low * 3 } : b)) };
      const b = def.compute(ctxOf(cut, 2000), p);
      for (let i = 0; i <= 3000; i++) expect(b[i]).toBe(a[i]);
    }
  });
});
