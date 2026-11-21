// The re-tuner: stable settings, offered only when they also do better on the newest candles.
import { describe, expect, it } from 'vitest';
import { rngOf } from './ml';
import { retune } from './retune';
import type { Market } from './library';
import type { StrategySpec } from './backtest';

const HOUR = 3_600_000;
function market(coin: string, n: number, seed: number, trend: number): Market {
  const rnd = rngOf(seed);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  let p = 100;
  let mu = 0;
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.998 * mu + trend * 0.0004 * g();
    const o = p;
    p *= Math.exp(mu + 0.005 * g());
    return { time: Date.UTC(2024, 0, 1) + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 + (i % 7) * 10 };
  });
  return { coin, tfH: 1, bars, funding: null };
}
const spec = (lookback: number): StrategySpec => ({ name: 'Ride the trend', signal: { id: 'tsmom', p: { lookback } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true, stopVol: 0 }, sides: 'both' });

describe('the re-tuner', () => {
  it('tries each setting on its grid, says why it changes nothing, and never offers a change that did worse on the newest candles', () => {
    const ms = [market('BTC', 9000, 3, 0), market('ETH', 9000, 4, 0)];
    const r = retune(ms, spec(72));
    expect(r.tried).toBeGreaterThan(2);
    expect(r.why.length).toBeGreaterThan(20);
    if (r.changed) {
      expect(r.proposed!.sharpe).toBeGreaterThanOrEqual(r.current!.sharpe + 0.25);
      expect(r.proposed!.ret).toBeGreaterThan(r.current!.ret);
    } else expect(r.spec).toBeUndefined();
  });
  it('a deliberately slow setting on trending prices: the faster one is offered, named, the rest of the strategy kept, and it beat the current one on the newest stretch', () => {
    const ms = [market('BTC', 9000, 5, 0.5), market('ETH', 9000, 6, 0.5)];
    const r = retune(ms, spec(720));
    expect(r.changed).toBe(true);
    expect(r.changes![0]).toMatch(/lookback 720 → 24/);
    expect(r.spec!.signal).toEqual({ id: 'tsmom', p: { lookback: 24 } });
    expect(r.spec!.exit).toEqual(spec(720).exit);
    expect(r.proposed!.sharpe).toBeGreaterThanOrEqual(r.current!.sharpe + 0.25);
    expect(r.proposed!.ret).toBeGreaterThan(r.current!.ret);
  });
});
