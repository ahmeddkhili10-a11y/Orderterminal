import { describe, expect, it } from 'vitest';
import type { Bar } from '../lab/series';
import { buildReport, coinOf, newsFor, swings, toneOf, verdictOf, volumeProfile } from './report';

/** a random walk with drift (per bar), seeded */
function walk(n: number, drift: number, vol: number, tfH: number, seed = 3, p0 = 100): Bar[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const out: Bar[] = [];
  let p = p0;
  const t0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * Math.exp(drift + vol * gauss());
    const hi = Math.max(o, p) * (1 + Math.abs(vol * gauss()) * 0.5);
    const lo = Math.min(o, p) * (1 - Math.abs(vol * gauss()) * 0.5);
    out.push({ time: t0 + i * tfH * 3_600_000, open: o, high: hi, low: lo, close: p, volume: 1000 + 500 * rnd() });
  }
  return out;
}

/** hourly candles of the same coin: rescaled so they end where the daily candles end */
function hourlyOf(daily: Bar[], h: Bar[]): Bar[] {
  const k = daily[daily.length - 1].close / h[h.length - 1].close;
  const t = daily[daily.length - 1].time - (h.length - 1) * 3_600_000;
  return h.map((b, i) => ({ ...b, time: t + i * 3_600_000, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k }));
}

describe('the instrument report', () => {
  it('knows coins by name', () => {
    expect(coinOf('bitcoin')).toBe('BTC');
    expect(coinOf('Solana')).toBe('SOL');
    expect(coinOf('avalanche')).toBe('AVAX');
    expect(coinOf('ETH')).toBe('ETH');
    expect(coinOf('pepe')).toBe('PEPE');
  });

  it('a steady rise reads bullish, a steady fall bearish, both horizons', () => {
    const dU = walk(500, 0.006, 0.02, 24);
    const up = buildReport({ coin: 'SOL', daily: dU, hourly: hourlyOf(dU, walk(1000, 0.0006, 0.004, 1, 5)), btcDaily: walk(500, 0.002, 0.02, 24, 11), candles: false });
    expect(up.medium.score).toBeGreaterThan(0.45);
    expect(up.medium.lean).toBe('Bullish');
    expect(up.short.score).toBeGreaterThan(0.15);
    expect(up.trend.ma200).toBeLessThan(up.price);
    const dD = walk(500, -0.006, 0.02, 24, 7, 1000);
    const dn = buildReport({ coin: 'SOL', daily: dD, hourly: hourlyOf(dD, walk(1000, -0.0006, 0.004, 1, 9, 1000)), candles: false });
    expect(dn.medium.lean).toBe('Bearish');
    expect(dn.short.score).toBeLessThan(-0.15);
    // every vote explains itself
    for (const s of [...up.medium.signals, ...up.short.signals]) {
      expect(s.why.length, s.id).toBeGreaterThan(20);
      expect(Math.abs(s.vote)).toBeLessThanOrEqual(1);
    }
  });

  it('pure noise is not called a strong trend', () => {
    let strong = 0;
    for (let k = 0; k < 8; k++) {
      const d = walk(500, 0, 0.02, 24, 100 + k);
      const r = buildReport({ coin: 'X', daily: d, hourly: hourlyOf(d, walk(1000, 0, 0.004, 1, 200 + k)), candles: false });
      if (Math.abs(r.medium.score) > 0.8) strong++;
    }
    expect(strong).toBeLessThanOrEqual(2);
  });

  it('forecast ranges bracket the price and widen with time; levels sit either side', () => {
    const daily = walk(500, 0.001, 0.03, 24);
    const r = buildReport({ coin: 'ETH', daily, hourly: hourlyOf(daily, walk(1000, 0, 0.005, 1)), candles: false });
    const { day, week } = r.forecast;
    expect(day && week).toBeTruthy();
    expect(day!.lo95).toBeLessThan(day!.lo68);
    expect(day!.lo68).toBeLessThan(r.price);
    expect(day!.hi68).toBeGreaterThan(r.price);
    expect(week!.hi95 - week!.lo95).toBeGreaterThan(day!.hi95 - day!.lo95);
    // a 3 % daily walk: about 3 % a day, about 57 % a year
    expect(r.vol!.dayMove).toBeGreaterThan(0.015);
    expect(r.vol!.dayMove).toBeLessThan(0.06);
    for (const l of r.levels.above) expect(l.price).toBeGreaterThan(r.price);
    for (const l of r.levels.below) expect(l.price).toBeLessThan(r.price);
    expect(r.summary.length).toBeGreaterThan(3);
    expect(r.perf.find((p) => p.label === '30 days')!.pct).toBeCloseTo(r.price / daily[daily.length - 31].close - 1, 6);
  });

  it('reads crowded funding and one-sided flow as short-term signals', () => {
    const d = walk(300, 0, 0.02, 24);
    const base = { coin: 'AVAX', daily: d, hourly: hourlyOf(d, walk(600, 0, 0.004, 1)), candles: false };
    const crowded = buildReport({ ...base, live: { perp: true, fundingRate: 0.0005, fundingIntervalH: 8 } });
    expect(crowded.short.signals.find((s) => s.id === 'funding')!.vote).toBe(-1);
    expect(crowded.positioning!.fundingApr).toBeCloseTo(0.05 * 3 * 365, 6);
    const buyers = buildReport({ ...base, flow: { buyUsd: 800_000, sellUsd: 200_000, trades: 900, minutes: 60 } });
    expect(buyers.short.signals.find((s) => s.id === 'flow')!.vote).toBe(1);
  });

  it('compares with bitcoin: an amplified copy has a beta near its multiple', () => {
    const btc = walk(400, 0.001, 0.02, 24, 21);
    // the coin: twice bitcoin's daily move plus a little of its own
    const own = walk(400, 0, 0.005, 24, 22);
    const coin: Bar[] = [];
    let p = 10;
    for (let i = 0; i < btc.length; i++) {
      if (i > 0) p *= Math.exp(2 * Math.log(btc[i].close / btc[i - 1].close) + Math.log(own[i].close / own[i - 1].close));
      coin.push({ ...btc[i], open: p, high: p * 1.01, low: p * 0.99, close: p });
    }
    const r = buildReport({ coin: 'SOL', daily: coin, hourly: [], btcDaily: btc, candles: false });
    expect(r.vsBtc!.beta).toBeGreaterThan(1.8);
    expect(r.vsBtc!.beta).toBeLessThan(2.2);
    expect(r.vsBtc!.corr).toBeGreaterThan(0.9);
    expect(r.gaps.join(' ')).toMatch(/hourly/);
  });

  it('copes with almost no data', () => {
    const r = buildReport({ coin: 'NEW', daily: walk(10, 0, 0.02, 24), hourly: walk(30, 0, 0.004, 1), candles: false });
    expect(r.price).toBeGreaterThan(0);
    expect(r.vol).toBeNull();
    expect(r.gaps.length).toBeGreaterThan(0);
    expect(r.medium.lean).toBeTruthy();
  });

  it('finds news by ticker and by name, and reads the tone', () => {
    const now = Date.UTC(2026, 10, 11);
    const items = [
      { id: '1', time: now - 3_600_000, title: 'Solana ETF approval lifts SOL', source: 'x', coins: [] },
      { id: '2', time: now - 7_200_000, title: 'Exploit drains a Solana lending protocol', source: 'x', coins: [] },
      { id: '3', time: now - 3_600_000, title: 'Bitcoin rallies', source: 'x', coins: ['BTC'] },
      { id: '4', time: now - 10 * 86_400_000, title: 'Old SOL news', source: 'x', coins: ['SOL'] },
      { id: '5', time: now - 1000, title: 'SOLVE token launches', source: 'x', coins: [] },
    ];
    const n = newsFor('SOL', items, now);
    expect(n.items.map((i) => i.id)).toEqual(['1', '2']);
    expect(n.good).toBe(1);
    expect(n.bad).toBe(1);
    expect(toneOf('Bitcoin hits record high')).toBe(1);
    expect(toneOf('Exchange hacked')).toBe(-1);
  });

  it('volume profile and swings', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 100; i++) {
      const mid = i % 10 < 8 ? 100 : 110;
      bars.push({ time: i, open: mid, high: mid + 1, low: mid - 1, close: mid, volume: 10 });
    }
    const vp = volumeProfile(bars, 22);
    expect(Math.abs(vp.poc - 100)).toBeLessThan(1.1);
    expect(vp.val).toBeLessThan(100);
    expect(vp.vah).toBeGreaterThan(100);
    const zig: Bar[] = [1, 2, 3, 6, 3, 2, 1, 0.5, 1, 2, 3].map((v, i) => ({ time: i, open: v, high: v, low: v, close: v, volume: 1 }));
    const s = swings(zig, 2);
    expect(s.highs).toEqual([6]);
    expect(s.lows).toEqual([0.5]);
  });

  it('a verdict with no votes is neutral', () => {
    const v = verdictOf('short', []);
    expect(v.lean).toBe('Neutral');
    expect(v.score).toBe(0);
  });
});
