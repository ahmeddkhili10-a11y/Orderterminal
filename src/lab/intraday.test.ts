// 15-minute candles through the Lab, and the rules that trade the day's own
// structure: the VWAP, the opening range, the move beyond the noise, the fade.
import { describe, expect, it } from 'vitest';
import { backtest } from './backtest';
import { buildSpec, checkFlow, FLOW_DEFAULT, forStyle, historyWords, STRATEGIES, STYLE_MAP, type Flow } from './flow';
import { ctxOf, EXIT_DEFAULT, gridOf, sessionVwap, SIGNAL_MAP, SIGNALS, type Market } from './library';
import { rngOf } from './ml';
import { evaluate } from './research';

const M15 = 900_000;
const DAY = 96; // 15-minute candles in a day
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());

/** 15-minute candles from closes, starting at a UTC midnight (a Monday) */
function m15(closes: number[], vol: (i: number) => number = (i) => 100 + ((i * 37) % 11) * 20, wick = 0.0005): Market {
  const t0 = Date.UTC(2024, 0, 1);
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c;
    return { time: t0 + i * M15, open: o, high: Math.max(o, c) * (1 + wick), low: Math.min(o, c) * (1 - wick), close: c, volume: vol(i) };
  });
  return { coin: 'X', tfH: 0.25, bars, funding: null };
}
function walk(n: number, seed: number, sd = 0.002): number[] {
  const g = gauss(rngOf(seed));
  let p = 100;
  return Array.from({ length: n }, () => (p *= Math.exp(sd * g())));
}
const hm = (m: Market, i: number) => {
  const d = new Date(m.bars[i].time);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
};
const sum = (x: ArrayLike<number>) => Array.from(x).reduce((a, b) => a + Math.abs(b), 0);

describe('15-minute candles', () => {
  it('no rule looks ahead on them', () => {
    const m = m15(walk(DAY * 40, 3));
    const cut = DAY * 32;
    const future: Market = { ...m, bars: m.bars.map((b, i) => (i > cut ? { ...b, close: b.close * 1.3, high: b.high * 1.3, low: b.low * 0.8, volume: b.volume * 5 } : b)) };
    for (const s of SIGNALS) {
      if (s.needsFunding || s.needsBench) continue;
      const p = gridOf(s.grid)[0];
      const a = s.compute(ctxOf(m, DAY * 28), p);
      const b = s.compute(ctxOf(future, DAY * 28), p);
      for (let i = 0; i <= cut; i++) expect(a[i], `${s.id} at ${i}`).toBe(b[i]);
    }
  });

  it('timed rules fire on the right candle: the one that closes at the hour', () => {
    const m = m15(walk(DAY * 15, 5));
    const night = SIGNAL_MAP.night.compute(ctxOf(m), { hour: 21 });
    m.bars.forEach((_, i) => expect(night[i], `night at ${i}`).toBe(hm(m, i) === 20.75 ? 1 : 0));
    // end-of-day momentum: the candle closing at 21:00, with the day's direction since midnight
    const it2 = SIGNAL_MAP.itsm.compute(ctxOf(m), { hour: 21 });
    m.bars.forEach((b, i) => {
      if (hm(m, i) !== 20.75) return expect(it2[i]).toBe(0);
      const open = m.bars[i - 83].open;
      expect(it2[i]).toBe(Math.sign(b.close / open - 1));
    });
    // the Monday rule: once a week, on the candle that closes at Monday 00:00
    const dow = SIGNAL_MAP.dow.compute(ctxOf(m), { day: 1 });
    const fired = Array.from(dow).flatMap((x, i) => (x ? [i] : []));
    expect(fired.length).toBe(2);
    for (const i of fired) {
      const close = new Date(m.bars[i].time + M15);
      expect([close.getUTCDay(), close.getUTCHours(), close.getUTCMinutes()]).toEqual([1, 0, 0]);
    }
  });

  it('the bot builder has two 15-minute styles, with their own pace', () => {
    const flow = (p: Partial<Flow>): Flow => ({ ...FLOW_DEFAULT, ...p });
    const s = buildSpec(flow({ style: 'scalp15', strategies: ['tsmom'] }));
    expect(s.timeframe).toBe('15m');
    expect(s.years).toBe(0.5);
    expect(s.spec.exit.maxBars).toBe(8); // two hours
    expect(s.spec.signal.p.lookback).toBe(3);
    expect(historyWords(STYLE_MAP.scalp15)).toBe('6 months');
    expect(historyWords(STYLE_MAP.intraday15)).toBe('1 year');
    expect(historyWords(STYLE_MAP.swing)).toBe('3 years');
    const i = buildSpec(flow({ style: 'intraday15', strategies: ['vwap'] }));
    expect(i.spec.exit.maxBars).toBe(48); // twelve hours
    // look-back floors written for hourly candles are a quarter as long here
    expect(buildSpec(flow({ style: 'scalp15', strategies: ['donchian'] })).spec.signal.p.n).toBe(5);
    expect(buildSpec(flow({ style: 'scalp', strategies: ['donchian'] })).spec.signal.p.n).toBe(20);
    // what suits scalping and intraday suits their 15-minute versions
    const fits = forStyle(STRATEGIES, 'scalp15').filter((x) => x.fits).map((x) => x.id);
    for (const id of ['vwap', 'orb', 'noise', 'fade', 'rsi2', 'night']) expect(fits, id).toContain(id);
    expect(checkFlow(flow({ style: 'scalp15', strategies: ['vwap'] })).some((x) => x.tone === 'info' && /usually traded/.test(x.text))).toBe(false);
    expect(checkFlow(flow({ style: 'intraday', strategies: ['fade'] })).some((x) => /15-minute candles/.test(x.text))).toBe(true);
    // a daily style still refuses them
    expect(checkFlow(flow({ style: 'position', strategies: ['orb'] })).some((x) => x.tone === 'clash')).toBe(true);
  });

  it('a full bot test runs on 15-minute candles', () => {
    const m = m15(walk(DAY * 80, 9));
    for (const id of ['vwap', 'orb', 'noise', 'fade']) {
      const built = buildSpec({ ...FLOW_DEFAULT, style: 'intraday15', strategies: [id], models: [], risks: [], coins: 'X' });
      const r = evaluate([m], built.spec, 0.7);
      expect(r.curve.length, id).toBeGreaterThan(10);
      expect(r.trades, id).toBeGreaterThan(0);
    }
  });
});

describe('VWAP trend', () => {
  it('the average starts again each day and weighs each candle by its volume', () => {
    const m = m15(walk(DAY * 3, 2), (i) => (i % 7) + 1);
    const vw = sessionVwap(ctxOf(m), 0);
    for (const d of [0, 1, 2]) {
      let pv = 0;
      let v = 0;
      for (let k = 0; k < DAY; k++) {
        const b = m.bars[d * DAY + k];
        pv += ((b.high + b.low + b.close) / 3) * b.volume;
        v += b.volume;
        if (k === 0 || k === 50 || k === DAY - 1) expect(vw[d * DAY + k]).toBeCloseTo(pv / v, 8);
      }
    }
    // a day that starts with the US session instead
    const us = sessionVwap(ctxOf(m), 13);
    const b = m.bars[52]; // 13:00
    expect(us[52]).toBeCloseTo((b.high + b.low + b.close) / 3, 8);
  });

  it('long above it, short below, and silent in the day’s first hour', () => {
    const up = Array.from({ length: DAY * 20 }, (_, i) => 100 + (i % DAY) * 0.05 + Math.floor(i / DAY));
    const m = m15(up);
    const s = SIGNAL_MAP.vwap.compute(ctxOf(m), { anchor: 0, band: 0 });
    for (let d = 2; d < 20; d++) {
      for (let k = 0; k < 4; k++) expect(s[d * DAY + k]).toBe(0);
      expect(s[d * DAY + 60]).toBe(1);
    }
    const down = m15(up.map((x, i) => 300 - x + 2 * Math.floor(i / DAY)));
    expect(SIGNAL_MAP.vwap.compute(ctxOf(down), { anchor: 0, band: 0 })[10 * DAY + 60]).toBe(-1);
  });
});

describe('opening range breakout', () => {
  // each day: two flat hours around 100, then a break (up on even days, down on odd), then drift
  const closes: number[] = [];
  for (let d = 0; d < 12; d++)
    for (let k = 0; k < DAY; k++) {
      const dir = d % 2 === 0 ? 1 : -1;
      closes.push(k < 8 ? 100 + (k % 2 ? 0.05 : -0.05) : k < 20 ? 100 + (k % 2 ? 0.04 : -0.04) : 100 + dir * (0.6 + (k - 20) * 0.01));
    }
  const m = m15(closes, undefined, 0);
  it('trades the first close beyond the first hours’ range, once a day, in its direction', () => {
    const s = SIGNAL_MAP.orb.compute(ctxOf(m), { anchor: 0, range: 2 });
    for (let d = 0; d < 12; d++) {
      const dir = d % 2 === 0 ? 1 : -1;
      for (let k = 0; k < 20; k++) expect(s[d * DAY + k], `day ${d} candle ${k}`).toBe(0);
      for (let k = 20; k < DAY; k++) expect(s[d * DAY + k], `day ${d} candle ${k}`).toBe(dir);
    }
  });
  it('a first break late in the day is left alone', () => {
    const late = closes.map((x, i) => (i % DAY < 90 ? 100 + (i % 2 ? 0.04 : -0.04) : x));
    const s = SIGNAL_MAP.orb.compute(ctxOf(m15(late, undefined, 0)), { anchor: 0, range: 2 });
    expect(sum(s)).toBe(0);
  });
  it('earns on days that follow their opening break', () => {
    const r = backtest(ctxOf(m), { name: 'orb', signal: { id: 'orb', p: { anchor: 0, range: 2 } }, filters: [], exit: { ...EXIT_DEFAULT, stopAtr: 6, maxBars: 60, onFlip: false }, sides: 'both' }, 30, closes.length, { feeBps: 0, slipBps: 0 });
    expect(r.trades.length).toBeGreaterThanOrEqual(9);
    expect(r.trades.filter((t) => t.r > 0).length).toBe(r.trades.length);
  });
});

describe('intraday momentum beyond the noise', () => {
  it('ignores a normal day and follows one that has moved more than is usual for the hour', () => {
    const g = gauss(rngOf(8));
    const closes: number[] = [];
    let base = 100;
    for (let d = 0; d < 30; d++) {
      let p = base;
      for (let k = 0; k < DAY; k++) {
        // quiet days; on day 25 a steady climb of 4 % by the close, on day 27 a fall
        const drift = d === 25 ? 0.0004 : d === 27 ? -0.0004 : 0;
        p *= Math.exp(drift + 0.0006 * g());
        closes.push(p);
      }
      base = p;
    }
    const m = m15(closes);
    const s = SIGNAL_MAP.noise.compute(ctxOf(m), { anchor: 0, k: 1.5 });
    expect(s[25 * DAY + 70]).toBe(1);
    expect(s[27 * DAY + 70]).toBe(-1);
    // no call before two weeks of days exist
    expect(sum(s.slice(0, 10 * DAY))).toBe(0);
    // on the quiet days it is mostly flat
    const quiet = [20, 21, 22, 23].flatMap((d) => Array.from(s.slice(d * DAY, (d + 1) * DAY)));
    expect(quiet.filter((x) => x !== 0).length / quiet.length).toBeLessThan(0.35);
  });
});

describe('fade a stretched candle', () => {
  it('trades against one big candle — on heavy volume only, when asked', () => {
    const closes = walk(DAY * 12, 4, 0.0005);
    const at = DAY * 10 + 40;
    for (let i = at; i < closes.length; i++) closes[i] *= 1.02;
    const loud = m15(closes, (i) => (i === at ? 5000 : 100 + (i % 5) * 10));
    const quiet = m15(closes);
    expect(SIGNAL_MAP.fade.compute(ctxOf(loud), { k: 2, vol: 1 })[at]).toBe(-1);
    expect(SIGNAL_MAP.fade.compute(ctxOf(quiet), { k: 2, vol: 1 })[at]).toBe(0);
    expect(SIGNAL_MAP.fade.compute(ctxOf(quiet), { k: 2, vol: 0 })[at]).toBe(-1);
    const fall = closes.map((x, i) => (i >= at ? (x / 1.02) * 0.98 : x));
    expect(SIGNAL_MAP.fade.compute(ctxOf(m15(fall)), { k: 2, vol: 0 })[at]).toBe(1);
  });
});
