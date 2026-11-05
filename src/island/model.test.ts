import { describe, expect, it } from 'vitest';
import type { HeatmapSnapshot } from '../core/heatmap';
import type { Trade } from '../core/types';
import { bookBars, gauges, islandMask, lights, liquidityGrid, percentile, priceWindow, profileRidge, riverCols, tapeCloud, terrain, volWave } from './model';

const T = Date.UTC(2026, 10, 5, 12);
const snap = (t: number, wall: number): HeatmapSnapshot => ({
  time: t,
  bestBid: 99.9,
  bestAsk: 100.1,
  res: 0.1,
  // an even book, with one big wall at 100.2
  bids: new Float32Array([99.9, 1, 99.8, 1, 99.7, 1]),
  asks: new Float32Array([100.1, 1, 100.25, wall, 100.35, 1]),
});
const w = { lo: 99.5, hi: 100.5, t0: T - 60_000, t1: T };

describe('the market island', () => {
  it('puts the book in a grid of time × price, carrying it forward through quiet rows', () => {
    const g = liquidityGrid([snap(T - 59_000, 50), snap(T - 1000, 50)], w, 10, 6);
    // 100.25 falls in column 7 of 10 across 99.5–100.5
    expect(g[0 * 10 + 7]).toBe(50);
    expect(g[3 * 10 + 7]).toBe(50); // a quiet row keeps the last book
    expect(g[5 * 10 + 4]).toBe(1);
  });

  it('raises the wall as a mountain, sinks the coast into the sea, carves the river', () => {
    const snaps = Array.from({ length: 60 }, (_, i) => snap(T - 60_000 + i * 1000, 60));
    const mids = Array.from({ length: 60 }, (_, i) => ({ time: T - 60_000 + i * 1000, value: 99.8 }));
    const tr = terrain(snaps, mids, w, 40, 20);
    const at = (r: number, c: number) => tr.h[r * 40 + c];
    const wallCol = Math.floor(((100.25 - 99.5) / 1) * 40);
    const mid = 10;
    expect(at(mid, wallCol)).toBeGreaterThan(at(mid, 20) + 0.2);
    // the edge is under the sea
    expect(at(0, 0)).toBeLessThan(0);
    // the river (at 99.8 → column 12) runs lower than the land beside it
    expect(Number.isFinite(tr.river[mid])).toBe(true);
    expect(at(mid, 12)).toBeLessThan(at(mid, 17));
    expect(islandMask(0.5, 0.5)).toBe(1);
    expect(islandMask(0, 0)).toBe(0);
  });

  it('follows the price with the river, row by row', () => {
    const mids = [
      { time: T - 50_000, value: 99.6 },
      { time: T - 10_000, value: 100.4 },
    ];
    const rc = riverCols(mids, w, 10, 5);
    expect(rc[0]).toBeNaN(); // before the first price
    expect(rc[1]).toBeCloseTo(1);
    expect(rc[4]).toBeCloseTo(9);
  });

  it('turns trades into lights, the biggest brightest, and the tape into a cloud and a ridge', () => {
    const trades: Trade[] = Array.from({ length: 100 }, (_, i) => ({ venue: 'sim', price: 99.6 + (i % 10) * 0.08, qty: i === 99 ? 50 : 1 + (i % 7), side: i % 2 ? 'buy' : 'sell', time: T - 50_000 + i * 400 }));
    const l = lights(trades, w).lights;
    expect(l).toHaveLength(100);
    expect(l[99].size).toBe(1);
    expect(l[0].size).toBeLessThan(0.5);
    expect(l[1].buy).toBe(true);
    const cloud = tapeCloud(trades);
    expect(cloud.every((p) => p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1 && p.z >= 0 && p.z <= 1)).toBe(true);
    const ridge = profileRidge(trades, w, 10, 4);
    expect(Math.max(...ridge.v)).toBe(1);
    expect(ridge.poc).toBeGreaterThanOrEqual(0);
  });

  it('groups the book into bars a side, nearest first', () => {
    const b = bookBars(
      [
        [99.99, 2],
        [99.95, 3],
      ],
      [
        [100.01, 1],
        [100.2, 4],
      ],
      8,
      0.05,
    );
    expect(b.mid).toBeCloseTo(100);
    expect(b.bids[0]).toBe(5);
    expect(b.asks[0]).toBe(1);
    expect(b.asks[4]).toBe(4);
  });

  it('measures volatility over three horizons', () => {
    const mids = Array.from({ length: 1800 }, (_, i) => ({ time: T - 1800_000 + i * 1000, value: 100 * (1 + 0.001 * Math.sin(i / 60)) }));
    const v = volWave(mids, T, 20, 40);
    expect(v.curves).toHaveLength(3);
    expect(v.curves[2].some((x) => x !== 0)).toBe(true);
    expect(v.realized).toBeGreaterThan(0);
  });

  it('a gauge per agent', () => {
    const g = gauges(null, 'BTC', { buyShare: 0.62, spreadBps: 1 });
    expect(g.map((x) => x.name)).toEqual(['Scalper', 'Auctioneer', 'Trend', 'Tape', 'Crowd', 'Guardian', 'Forest', 'Risk']);
    expect(g[3]).toMatchObject({ value: 0.62, text: '62%', sub: 'buyers lifting' });
    expect(g[5].value).toBeCloseTo(0.875);
    expect(priceWindow(100_000).hi - priceWindow(100_000).lo).toBeCloseTo(700);
    expect(percentile([0, 1, 2, 3], 0.5)).toBe(2);
  });
});
