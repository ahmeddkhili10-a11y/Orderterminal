// The blocks added for the edge finder: the volatility squeeze, the ATR trend
// line, relative strength against bitcoin, and the two new ways to join rules
// (the regime switch; setup, then trigger).
import { describe, expect, it } from 'vitest';
import { combineSignals, rawSignal, regimeSide, switchSignals, thenSignals, trendRegime, type StrategySpec } from './backtest';
import { buildSpec, checkFlow, COMBINES, FLOW_DEFAULT, STRATEGIES, STYLE_MAP, thenWindow, type Flow } from './flow';
import { ctxOf, EXIT_DEFAULT, SIGNAL_MAP, type Market } from './library';
import { rngOf } from './ml';
import { withBench } from './research';

const HOUR = 3_600_000;
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());

function market(coin: string, closes: number[], tfH = 1, range = 0.001): Market {
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: Date.UTC(2024, 0, 1) + i * tfH * HOUR, open: o, high: Math.max(o, c) * (1 + range), low: Math.min(o, c) * (1 - range), close: c, volume: 100 };
  });
  return { coin, tfH, bars, funding: null };
}

/** a walk whose volatility is set bar by bar */
function walk(n: number, seed: number, sd: (i: number) => number, drift: (i: number) => number = () => 0): number[] {
  const g = gauss(rngOf(seed));
  const out: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    p *= Math.exp(drift(i) + sd(i) * g());
    out.push(p);
  }
  return out;
}

const spec = (id: string, p: Record<string, number>): StrategySpec => ({ name: id, signal: { id, p }, filters: [], exit: { ...EXIT_DEFAULT }, sides: 'both' });

/** a rule may only use bars up to the one it speaks at: cutting the future off must not change the past */
function noLookAhead(m: Market, id: string, p: Record<string, number>, cut: number) {
  const full = SIGNAL_MAP[id].compute(ctxOf(m), p);
  const part = SIGNAL_MAP[id].compute(ctxOf({ ...m, bars: m.bars.slice(0, cut), bench: m.bench ? m.bench.slice(0, cut) : m.bench }), p);
  for (let i = 0; i < cut; i++) expect(part[i], `${id} at bar ${i}`).toBe(full[i]);
}

describe('the volatility squeeze', () => {
  // quiet for a long while, then a run up
  const closes = walk(1500, 4, (i) => (i > 900 && i < 1200 ? 0.0004 : i >= 1200 && i < 1260 ? 0.001 : 0.006), (i) => (i >= 1200 && i < 1260 ? 0.004 : 0));
  const m = market('ETH', closes);
  const p = { lookback: 20, squeeze: 240, k: 2 };
  const sig = SIGNAL_MAP.squeeze.compute(ctxOf(m), p);

  it('goes with the first break out of a squeeze, and is quiet before it', () => {
    const during = Array.from(sig.slice(1000, 1195));
    const after = Array.from(sig.slice(1200, 1250));
    expect(after.filter((x) => x === 1).length).toBeGreaterThan(25);
    expect(after.filter((x) => x === -1).length).toBe(0);
    // inside the quiet stretch itself the bands hold nearly every close: few signals
    expect(during.filter((x) => x !== 0).length).toBeLessThan(during.length * 0.5);
  });
  it('does not fire in ordinary volatility far from any squeeze', () => {
    const noisy = market('ETH', walk(1200, 9, () => 0.006));
    const s = SIGNAL_MAP.squeeze.compute(ctxOf(noisy), { lookback: 20, squeeze: 480, k: 2.5 });
    // a steady market is squeezed only a fifth of the time: it trades less than a plain band breakout
    const plain = SIGNAL_MAP.bbreak.compute(ctxOf(noisy), { lookback: 20, k: 2.5 });
    const onsets = (x: Int8Array) => Array.from(x).filter((v, i) => v !== 0 && v !== x[i - 1]).length;
    expect(onsets(s)).toBeLessThan(onsets(plain));
  });
  it('never looks ahead', () => noLookAhead(m, 'squeeze', p, 1215));
});

describe('the ATR trend line', () => {
  const closes = walk(900, 12, () => 0.004, (i) => (i < 450 ? 0.003 : -0.004));
  const m = market('SOL', closes, 4, 0.004);
  const p = { n: 40, k: 3 };
  const sig = SIGNAL_MAP.atrtrend.compute(ctxOf(m), p);
  it('is long through a rise, short through the fall, and flips once near the turn', () => {
    const up = Array.from(sig.slice(100, 440));
    const dn = Array.from(sig.slice(520, 900));
    expect(up.filter((x) => x === 1).length / up.length).toBeGreaterThan(0.85);
    expect(dn.filter((x) => x === -1).length / dn.length).toBeGreaterThan(0.85);
    const flips = Array.from(sig).filter((v, i) => i > 60 && v !== sig[i - 1]).length;
    expect(flips).toBeLessThan(12);
  });
  it('a wider line flips less often', () => {
    const flips = (k: number) => {
      const s = SIGNAL_MAP.atrtrend.compute(ctxOf(m), { n: 40, k });
      return Array.from(s).filter((v, i) => i > 60 && v !== s[i - 1]).length;
    };
    expect(flips(4)).toBeLessThanOrEqual(flips(2));
  });
  it('never looks ahead', () => noLookAhead(m, 'atrtrend', p, 600));
});

describe('relative strength against bitcoin', () => {
  const n = 1400;
  const btc = walk(n, 21, () => 0.005);
  const g = gauss(rngOf(22));
  // the coin: bitcoin's move plus its own drift — ahead of bitcoin in the first half, behind in the second
  const coin: number[] = [];
  let p0 = 50;
  for (let i = 0; i < n; i++) {
    const rb = i ? Math.log(btc[i] / btc[i - 1]) : 0;
    p0 *= Math.exp(rb + (i < 700 ? 0.0012 : -0.0012) + 0.002 * g());
    coin.push(p0);
  }
  const [mb, mc] = withBench([market('BTC', btc, 4), market('SOL', coin, 4)]);
  const p = { lookback: 168, k: 0.5 };
  it('buys the coin that is beating bitcoin and sells the one that lags', () => {
    const s = SIGNAL_MAP.rsbtc.compute(ctxOf(mc), p);
    const first = Array.from(s.slice(300, 680));
    const second = Array.from(s.slice(900, 1400));
    expect(first.filter((x) => x === 1).length / first.length).toBeGreaterThan(0.8);
    expect(second.filter((x) => x === -1).length / second.length).toBeGreaterThan(0.8);
  });
  it('never trades bitcoin itself, and never looks ahead', () => {
    expect(Array.from(SIGNAL_MAP.rsbtc.compute(ctxOf(mb), p)).every((x) => x === 0)).toBe(true);
    noLookAhead(mc, 'rsbtc', p, 800);
  });
  it('is in the bot builder, needing bitcoin, and clashes with the pairs trade (the opposite bet)', () => {
    const opt = STRATEGIES.find((s) => s.id === 'rsbtc')!;
    expect(opt.needsBtc).toBe(true);
    expect(buildSpec({ ...FLOW_DEFAULT, strategies: ['rsbtc'], coins: 'SOL' }).coins).toContain('BTC');
    const f: Flow = { ...FLOW_DEFAULT, strategies: ['rsbtc', 'pairs'], models: [], risks: [] };
    expect(checkFlow(f).some((x) => x.tone === 'clash')).toBe(true);
  });
});

describe('new ways to join rules', () => {
  const I = (xs: number[]) => Int8Array.from(xs);
  it('setup, then trigger: the trigger counts within the window of the setup, in its direction only', () => {
    //                     0  1  2  3  4  5  6  7  8  9
    const setup = I([0, 1, 0, 0, 0, 0, 0, 0, -1, 0]);
    const trig = I([0, 0, 0, 1, 0, 0, 1, -1, 0, -1]);
    const out = Array.from(thenSignals([setup, trig], 3));
    expect(out).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, -1]);
    // on the same candle counts too, and with two triggers both must point the way
    expect(Array.from(thenSignals([I([1, 0]), I([1, 1])], 2))).toEqual([1, 1]);
    expect(Array.from(thenSignals([I([1, 0, 0]), I([1, 1, 0]), I([0, 1, 1])], 2))).toEqual([0, 1, 0]);
  });
  it('regime switch: trend rules are read in trends, dip rules in ranges, the rest always', () => {
    const trend = I([1, 1, 1, 1]);
    const dip = I([-1, -1, -1, -1]);
    const season = I([0, 0, 1, 0]);
    const regime = Uint8Array.from([1, 1, 0, 0]);
    expect(Array.from(switchSignals([trend, dip], ['trend', 'range'], regime))).toEqual([1, 1, -1, -1]);
    // a rule for both regimes joins as “any one, unless another disagrees”
    expect(Array.from(switchSignals([trend, dip, season], ['trend', 'range', 'both'], regime))).toEqual([1, 1, 0, -1]);
    expect(regimeSide('breakout')).toBe('trend');
    expect(regimeSide('reversion')).toBe('range');
    expect(regimeSide('seasonal')).toBe('both');
  });
  it('the regime comes from ADX with hysteresis and is known at each close', () => {
    const closes = walk(900, 31, () => 0.003, (i) => (i > 300 && i < 600 ? 0.004 : 0));
    const m = market('BTC', closes, 1, 0.002);
    const r = trendRegime(ctxOf(m));
    const share = (a: number, b: number) => Array.from(r.slice(a, b)).reduce((x, y) => x + y, 0) / (b - a);
    expect(share(360, 600)).toBeGreaterThan(0.8);
    expect(share(700, 900)).toBeLessThan(share(360, 600));
    const cut = trendRegime(ctxOf({ ...m, bars: m.bars.slice(0, 500) }));
    for (let i = 0; i < 500; i++) expect(cut[i]).toBe(r[i]);
  });
  it('a strategy joined by the switch trades its trend rule in the trend and its dip rule in the range', () => {
    const closes = walk(1200, 41, () => 0.003, (i) => (i > 400 && i < 800 ? 0.003 : 0));
    const m = market('BTC', closes, 1, 0.002);
    const c = ctxOf(m);
    const s: StrategySpec = { ...spec('tsmom', { lookback: 24 }), also: [{ id: 'rsi2', p: { n: 2, lo: 10, hi: 90 } }], combine: 'switch' };
    const joined = rawSignal(c, s);
    const a = SIGNAL_MAP.tsmom.compute(c, { lookback: 24 });
    const b = SIGNAL_MAP.rsi2.compute(c, { n: 2, lo: 10, hi: 90 });
    const r = trendRegime(c);
    for (let i = 0; i < joined.length; i++) expect(joined[i]).toBe(r[i] ? a[i] : b[i]);
    // and the old joins are untouched
    expect(Array.from(combineSignals([I([1, 1, 0]), I([1, -1, 0])], 'any'))).toEqual([1, 0, 0]);
  });
  it('the bot builder offers both joins, sets the window, and says how they fit', () => {
    expect(COMBINES.map((c) => c.id)).toEqual(['all', 'majority', 'any', 'switch', 'then']);
    const then: Flow = { ...FLOW_DEFAULT, style: 'intraday', strategies: ['donchian', 'volbrk'], combine: 'then', models: [], risks: [] };
    const built = buildSpec(then);
    expect(built.spec.window).toBe(thenWindow(STYLE_MAP.intraday));
    expect(built.spec.window).toBe(6);
    expect(built.spec.name).toContain('→');
    expect(checkFlow(then).some((x) => /sets the direction/.test(x.text))).toBe(true);
    // a trend rule with a dip rule: a clash with “any one”, a pair with the regime switch
    const sw: Flow = { ...FLOW_DEFAULT, style: 'intraday', strategies: ['tma', 'rsi2'], combine: 'any', models: [], risks: [] };
    expect(checkFlow(sw).some((x) => x.tone === 'clash')).toBe(true);
    const ok = checkFlow({ ...sw, combine: 'switch' });
    expect(ok.some((x) => x.tone === 'clash')).toBe(false);
    expect(ok.some((x) => x.tone === 'pair' && /regime switch/.test(x.text))).toBe(true);
    // a breakout with a dip rule too
    expect(checkFlow({ ...sw, strategies: ['donchian', 'zrev'], combine: 'switch' }).some((x) => x.tone === 'clash')).toBe(false);
    // the switch with nothing to switch between says so
    expect(checkFlow({ ...sw, strategies: ['tma', 'macd'], combine: 'switch' }).some((x) => /needs a trend or breakout strategy and a dip-buying one/.test(x.text))).toBe(true);
  });
  it('every new strategy is in the bot builder with a rule in the library', () => {
    for (const id of ['squeeze', 'atrtrend', 'rsbtc']) {
      const opt = STRATEGIES.find((s) => s.id === id)!;
      expect(opt, id).toBeTruthy();
      const sig = SIGNAL_MAP[opt.signal];
      for (const style of Object.values(STYLE_MAP)) {
        const p = opt.params(style);
        for (const k of Object.keys(sig.grid)) expect(p[k], `${id}.${k} on ${style.id}`).toBeGreaterThan(0);
        expect(sig.describe(p).length).toBeGreaterThan(20);
      }
    }
  });
});
