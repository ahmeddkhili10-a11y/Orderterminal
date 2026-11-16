// The ICT and Candle Range Theory rules, each on a hand-built pattern.
import { describe, expect, it } from 'vitest';
import { ctxOf, FILTER_MAP, nyHour, nyOffset, SIGNAL_MAP } from './library';
import { STRATEGIES, MODELS } from './flow';
import { PAPERS } from './papers';

const HOUR = 3_600_000;
type B = { time: number; open: number; high: number; low: number; close: number; volume: number };
/** hourly bars from t0, each [open, high, low, close] */
const bars = (t0: number, rows: number[][]): B[] => rows.map(([o, h, l, c], i) => ({ time: t0 + i * HOUR, open: o, high: h, low: l, close: c, volume: 100 }));
const flat = (n: number, px = 100): number[][] => Array.from({ length: n }, () => [px, px + 0.5, px - 0.5, px]);
const ctx = (b: B[], tfH = 1) => ctxOf({ coin: 'BTC', tfH, bars: b, funding: null } as never);
const at = (sig: Int8Array) => [...sig].map((x, i) => [i, x]).filter(([, x]) => x !== 0);

describe('the New York clock', () => {
  it('knows daylight saving', () => {
    expect(nyOffset(Date.UTC(2026, 0, 15, 12))).toBe(-5);
    expect(nyOffset(Date.UTC(2026, 6, 1, 12))).toBe(-4);
    // 2026: daylight saving starts Sunday 8 March at 07:00 UTC and ends Sunday 1 November at 06:00 UTC
    expect(nyOffset(Date.UTC(2026, 2, 8, 6, 59))).toBe(-5);
    expect(nyOffset(Date.UTC(2026, 2, 8, 7))).toBe(-4);
    expect(nyOffset(Date.UTC(2026, 10, 1, 5, 59))).toBe(-4);
    expect(nyOffset(Date.UTC(2026, 10, 1, 6))).toBe(-5);
    expect(nyHour(Date.UTC(2026, 6, 1, 14))).toBe(10);
    expect(nyHour(Date.UTC(2026, 0, 15, 15))).toBe(10);
  });
});

describe('Candle Range Theory', () => {
  it('a sweep of the last 4-hour candle that closes back inside is sold', () => {
    // a 4-hour candle from 00:00 with range 99.5–101, then the next one runs to 103 and closes back at 100.5
    const t0 = Date.UTC(2026, 0, 5);
    const rows = [...flat(4).map((r, i) => (i === 2 ? [100, 101, 99.5, 100.5] : r)), [100.5, 103, 100.4, 100.6], [100.6, 100.8, 100, 100.2]];
    const pre = flat(20).map((r) => r);
    const b = bars(t0 - 20 * HOUR, [...pre, ...rows]);
    const s = SIGNAL_MAP.crt.compute(ctx(b), { htf: 4, depth: 0 });
    // bar 23 already swept the 20:00 candle (its 101 high, then a close at 100); bar 24 sweeps the 00:00 one
    expect(at(s)).toEqual([[23, -1], [24, -1]]);
    // on 4-hour candles a 4-hour range means nothing
    expect(at(SIGNAL_MAP.crt.compute(ctx(b, 4), { htf: 4, depth: 0 }))).toEqual([]);
  });

  it('the Monday range: a false break later in the week is faded; a true break is followed', () => {
    // Monday 5 January 2026: 24 hourly candles between 99 and 101
    const mon = Date.UTC(2026, 0, 5);
    const rows = [...Array.from({ length: 24 }, () => [100, 101, 99, 100]), [100, 102, 99.8, 100.5], [100.5, 100.7, 100, 100.2], [100.2, 103, 100, 102]];
    const b = bars(mon, rows);
    expect(at(SIGNAL_MAP.monday.compute(ctx(b), { mode: 0 }))).toEqual([[24, -1]]);
    expect(at(SIGNAL_MAP.monday.compute(ctx(b), { mode: 1 }))).toEqual([[26, 1]]);
  });
});

describe('ICT', () => {
  it('a liquidity sweep of the recent high that closes back below is sold', () => {
    const b = bars(Date.UTC(2026, 0, 5), [...flat(30), [100, 102, 99.8, 100.2]]);
    expect(at(SIGNAL_MAP.sweep.compute(ctx(b), { lookback: 24 }))).toEqual([[30, -1]]);
  });

  it('a fair value gap is bought on its first retrace', () => {
    // a displacement: candle 31's low (103) far above candle 29's high (100.5), then price comes back to 102.8
    const rows = [...flat(30), [100, 101, 99.8, 100.9], [101, 104, 101, 103.8], [103.8, 105, 103, 104.5], [104.5, 104.6, 102.8, 103.5]];
    const b = bars(Date.UTC(2026, 0, 5), rows);
    const s = SIGNAL_MAP.fvg.compute(ctx(b), { k: 0.3, age: 12 });
    expect(at(s)).toEqual([[33, 1]]);
  });

  it('a market structure shift: a sweep of the low, then a close above the swing high before it', () => {
    const rows = [...flat(30), [100, 100.2, 98, 99], [99, 100.4, 98.8, 100.3], [100.3, 101.5, 100.2, 101.2]];
    const b = bars(Date.UTC(2026, 0, 5), rows);
    expect(at(SIGNAL_MAP.mss.compute(ctx(b), { lookback: 24, window: 6 }))).toEqual([[32, 1]]);
  });

  it('the London Judas swing: a false run above the Asian range that closes back inside is sold', () => {
    const day = Date.UTC(2026, 0, 6);
    // 00–05 UTC: the Asian range 99.5–100.5; 07:00 runs to 101.5 and closes back at 100.2
    const rows = [...flat(6), [100, 100.3, 99.8, 100.1], [100.1, 101.5, 100, 100.2], [100.2, 100.4, 99.6, 99.8]];
    const b = bars(day - 20 * HOUR, [...flat(20), ...rows]);
    expect(at(SIGNAL_MAP.judas.compute(ctx(b), { depth: 0 }))).toEqual([[27, -1]]);
  });

  it('the Silver Bullet trades the first fair value gap in its New York window, once a day', () => {
    // 15:00 UTC on 15 January is 10:00 in New York (winter)
    const t0 = Date.UTC(2026, 0, 15, 0);
    const rows = flat(40);
    // bars 14, 15, 16 (14:00–16:00 UTC): a bullish gap whose third candle opens at 15:00 UTC = 10:00 New York
    rows[13] = [100, 100.4, 99.6, 100.2];
    rows[15] = [101.5, 102, 101.2, 101.8];
    rows[16] = [101.8, 103, 101.6, 102.9];
    const s = SIGNAL_MAP.silver.compute(ctx(bars(t0, rows)), { win: 1, k: 0.1 });
    expect(at(s)).toEqual([[15, 1]]);
  });

  it('the kill zones, premium and discount, and the bias from the open', () => {
    const t0 = Date.UTC(2026, 0, 15, 0);
    const b = bars(t0, flat(30));
    const kz = FILTER_MAP.killzone.compute(ctx(b), { z: 1 });
    // 07:00–10:00 New York is 12:00–15:00 UTC in winter
    expect([...kz.long].map((x, i) => (x ? i : -1)).filter((i) => i >= 0)).toEqual([12, 13, 14]);
    const up = bars(t0, [...flat(30), [100, 106, 100, 105]]);
    const pd = FILTER_MAP.pd.compute(ctx(up), { lookback: 24 });
    expect([pd.long[30], pd.short[30]]).toEqual([0, 1]);
    const bias = FILTER_MAP.bias.compute(ctx(up), { anchor: 0 });
    expect([bias.long[30], bias.short[30]]).toEqual([1, 0]);
  });

  it('every new block is in the bot builder, describes itself and cites its sources', () => {
    for (const id of ['crt', 'monday', 'sweep', 'fvg', 'mss', 'silver', 'judas']) {
      const sig = SIGNAL_MAP[id];
      expect(STRATEGIES.some((s) => s.signal === id)).toBe(true);
      expect(sig.papers.every((p) => PAPERS[p])).toBe(true);
      expect(sig.rationale).toMatch(/not a peer-reviewed one/);
      for (const [k, vs] of Object.entries(sig.grid)) expect(sig.describe({ ...Object.fromEntries(Object.entries(sig.grid).map(([a, v]) => [a, v[0]])), [k]: vs[vs.length - 1] }).length).toBeGreaterThan(20);
    }
    for (const id of ['killzone', 'pd', 'bias']) {
      expect(FILTER_MAP[id].papers.every((p) => PAPERS[p])).toBe(true);
      expect(MODELS.some((m) => (typeof m.filter === 'function' ? m.filter({ L: 24 } as never).id : m.filter.id) === id)).toBe(true);
    }
  });
});

describe('the edge finder breeds them, and shows what an edge is worth sized up', () => {
  it('ICT and CRT blocks are drawn into new bots, beside the quant ones', async () => {
    const { Farm, sizedUp } = await import('./farm');
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday', 'scalp'] }, { seed: 3 });
    const t0 = Date.UTC(2025, 0, 1);
    const walk = (seed: number) => {
      let s = seed;
      let p = 100;
      return Array.from({ length: 3000 }, (_, i) => {
        s = (s * 16807) % 2147483647;
        const r = (s / 2147483647 - 0.5) * 0.01;
        const o = p;
        p *= 1 + r;
        return { time: t0 + i * HOUR, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 100 };
      });
    };
    farm.setMarkets({ '1h': [{ coin: 'BTC', tfH: 1, bars: walk(3), funding: null }, { coin: 'ETH', tfH: 1, bars: walk(5), funding: null }] } as never);
    const seen = new Set<string>();
    const models = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const f = farm.randomFlow();
      if (!f) continue;
      f.strategies.forEach((x) => seen.add(x));
      f.models.forEach((x) => models.add(x));
    }
    for (const id of ['crt4', 'crtd', 'sweep', 'fvg', 'mss', 'judas', 'monday']) expect(seen.has(id)).toBe(true);
    for (const id of ['kz', 'pd', 'bias-day']) expect(models.has(id)).toBe(true);
    // a steady 9 % a year with a 0.8 % worst drop: 5× (the cap) for 45 % with a 4 % drop
    const a = sizedUp(0.09, 0.008);
    expect([a.lev, a.ret, a.maxDD].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([5, 0.45, 0.04]);
    // a jumpy 30 % with a 30 % drop: halved to a 15 % drop
    const b = sizedUp(0.3, 0.3);
    expect([b.lev, b.ret, b.maxDD].map((x) => Math.round(x * 1e9) / 1e9)).toEqual([0.5, 0.15, 0.15]);
  });
});
