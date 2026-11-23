// The heavy panel maths, as the worker runs it: each task gives the same answer as before and
// its answer survives the trip back from the worker (structured clone) unchanged.
import { describe, expect, it } from 'vitest';
import { runTask } from './compute';
import { dataKey, TASKS } from './heavy';

let seed = 11;
const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
const candles = (n: number) => {
  let p = 60000;
  let v = 0.006;
  return Array.from({ length: n }, (_, i) => {
    v = Math.sqrt(0.000002 + 0.08 * (v * gauss()) ** 2 + 0.9 * v * v);
    const o = p;
    p *= Math.exp(v * gauss());
    return { time: 1.7e12 + i * 3_600_000, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 100 };
  });
};
const data = { BTC: candles(1000), ETH: candles(1000), TINY: candles(50) };

describe('the heavy panel maths', () => {
  it('fits GARCH for each coin with enough candles, leaving out the rest', () => {
    const rows = TASKS.garchRows({ coins: ['BTC', 'ETH', 'TINY', 'NONE'], data, ahead: 24, model: 'best' });
    expect(rows.map((r) => r.coin)).toEqual(['BTC', 'ETH']);
    expect(rows[0].hours).toHaveLength(24);
    expect(rows[0].longAnn).toBeGreaterThan(0);
  });

  it('every task answers with plain data the worker can send back', () => {
    const v = TASKS.varRows({ coins: ['BTC'], data, conf: 0.99, horizon: 24 });
    const answers = [
      TASKS.garchRows({ coins: ['BTC'], data, ahead: 48, model: 'gjr' }),
      v,
      TASKS.varBacktest({ r: v[0].r, fit: v[0].fit, conf: 0.99 }),
      TASKS.regimeRows({ coins: ['BTC', 'ETH'], data }),
      TASKS.garchModel({ bars: data.BTC }),
      TASKS.volTarget({ bars: data.BTC, tgt: 0.4, cap: 3 }),
    ];
    for (const a of answers) {
      expect(a).toBeTruthy();
      expect(structuredClone(a)).toEqual(a);
    }
  });

  it('runs on the page after the frame when there is no worker (tests, old browsers)', async () => {
    const rows = await runTask('regimeRows', { coins: ['ETH'], data });
    expect(rows).toEqual(TASKS.regimeRows({ coins: ['ETH'], data }));
  });

  it('notices a new or moved candle in its fingerprint', () => {
    const a = dataKey(data, ['BTC', 'ETH']);
    const moved = { ...data, BTC: [...data.BTC.slice(0, -1), { ...data.BTC[999], close: 1 }] };
    expect(dataKey(moved, ['BTC', 'ETH'])).not.toBe(a);
    expect(dataKey(data, ['BTC', 'ETH'])).toBe(a);
  });
});
