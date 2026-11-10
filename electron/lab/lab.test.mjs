import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSwarm } from '../cswarm/cswarm.mjs';
import { evaluate, research, scoreVariants } from '../../src/lab/research.ts';
import { alignFunding, LabService } from './lab.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** hourly candles: a random walk ending at `now` */
function walk(n, now, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  let p = 100;
  return Array.from({ length: n }, (_, i) => {
    const o = p;
    p *= Math.exp((rnd() - 0.5) * 0.02);
    return { time: now - (n - i) * HOUR, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 10 + rnd() * 10 };
  });
}

/** a worker that runs in-process, as labWorker.mjs does */
function inlineWorker() {
  const w = new EventEmitter();
  w.terminate = async () => {};
  w.postMessage = async (msg) => {
    try {
      const result =
        msg.type === 'score'
          ? scoreVariants(msg.markets, msg.specs, msg.isShare, msg.costs, (done, total) => w.emit('message', { type: 'progress', progress: { stage: 'Trying changes', done, total } }))
          : msg.type === 'evaluate'
            ? evaluate(msg.markets, msg.spec, msg.isShare, msg.costs)
            : await research(msg.markets, msg.cfg, (progress) => w.emit('message', { type: 'progress', progress }));
      w.emit('message', { type: 'result', result });
    } catch (err) {
      w.emit('message', { type: 'error', error: String(err.message) });
    }
  };
  return w;
}

describe('the optimizer and 15-minute history', () => {
  it('scores versions of a strategy in the worker and leaves no progress behind', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => walk(3000, now, 7).filter((b) => b.time >= since)), fundingHistory: vi.fn(async () => []) };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const exit = { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 24, onFlip: true, stopVol: 0 };
    const spec = { name: 'mom', signal: { id: 'tsmom', p: { lookback: 24 } }, filters: [], exit, sides: 'both' };
    const scores = await lab.optimize([{ id: 'base', spec }, { id: 'side:long', spec: { ...spec, sides: 'long' } }, { id: 'stop:wide', spec: { ...spec, exit: { ...exit, stopAtr: 3 } } }], { coins: ['BTC'], years: 0.33, timeframe: '1h', funding: false });
    expect(scores.map((s) => s.id)).toEqual(['base', 'side:long', 'stop:wide']);
    expect(scores[0].trades).toBeGreaterThan(3);
    expect(Number.isFinite(scores[0].sharpe)).toBe(true);
    expect(lab.status().progress).toBeNull();
    await expect(lab.optimize([], {})).rejects.toThrow(/nothing to try/);
  });

  it('downloads 15-minute candles, a year at most', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const M15 = HOUR / 4;
    const ccxt = {
      history: vi.fn(async (_id, _sym, tf, since) => {
        const n = Math.floor((now - since) / M15);
        return Array.from({ length: n }, (_, i) => ({ time: since + i * M15, open: 100, high: 101, low: 99, close: 100 + (i % 7), volume: 5 }));
      }),
    };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const { bars } = await lab.candles('BTC', '15m', 3, 'binance');
    expect(ccxt.history.mock.calls[0][2]).toBe('15m');
    // asked for three years, given one
    expect(now - ccxt.history.mock.calls[0][3]).toBe(365 * DAY);
    expect(bars.length).toBeGreaterThan(34_000);
    expect(bars.length).toBeLessThanOrEqual(35_040);
    expect(bars[1].time - bars[0].time).toBe(M15);
  });
});

describe('the Strategy Lab service', () => {
  it('turns funding per interval into funding per bar', () => {
    const bars = Array.from({ length: 24 }, (_, i) => ({ time: i * HOUR }));
    const rows = [0, 8, 16].map((h) => ({ time: h * HOUR, rate: 0.0008 }));
    const f = alignFunding(bars, rows, 1);
    expect(f[0]).toBeCloseTo(0.0001, 8);
    expect(f[23]).toBeCloseTo(0.0001, 8);
    expect(alignFunding(bars, [], 1)).toBeNull();
  });

  it('downloads history, researches in a worker, keeps the result and deploys a strategy', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = {
      history: vi.fn(async (_id, _sym, _tf, since) => walk(3000, now, Math.round(since / 1e9) % 97).filter((b) => b.time >= since)),
      fundingHistory: vi.fn(async () => {
        throw new Error('no funding here');
      }),
    };
    const events = [];
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: (ch, m) => events.push([ch, m]), makeWorker: inlineWorker, now: () => now });
    const last = await lab.run({ coins: ['BTC', 'ETH'], years: 0.35, combos: 20, meta: false });
    expect(last.top).toBeGreaterThan(0);
    expect(ccxt.history).toHaveBeenCalled();
    const r = lab.result();
    expect(r.top[0].rules[0]).toMatch(/^Entry: /);
    expect(r.notes.some((n) => /funding/.test(n))).toBe(true);
    expect(events.some(([ch, m]) => ch === 'lab:event' && m.kind === 'done')).toBe(true);
    // the cache: a second download fetches only what is new
    ccxt.history.mockClear();
    await lab.candles('BTC', '1h', 0.35, 'binance');
    expect(ccxt.history.mock.calls.every((c) => c[3] > now - 2 * HOUR)).toBe(true);
    // deploy the best into the crypto swarm, then switch it off
    const id = lab.deploy({ rank: 1 }, { crypto: true, meme: false });
    expect(lab.deployed('crypto').map((d) => d.id)).toEqual([id]);
    expect(lab.status().deployed[0].stats.verdict).toBe(r.top[0].verdict);
    lab.toggle(id, false);
    expect(lab.deployed('crypto')).toHaveLength(0);
    lab.undeploy(id);
    expect(lab.status().deployed).toHaveLength(0);
  }, 120_000);
});

let sw;
afterEach(async () => {
  await sw?.stop();
  sw = null;
});

describe('the Lab agent in the crypto swarm', () => {
  it('proposes a deployed strategy’s new signal and manages the trade by its rules', async () => {
    let now = Date.UTC(2026, 10, 6, 12);
    // a quiet range, then a breakout on the last closed hour
    const hourly = Array.from({ length: 300 }, (_, i) => {
      const c = i === 299 ? 306 : 300 + Math.sin(i / 3);
      return { time: now - (300 - i) * HOUR, open: i === 299 ? 300.5 : c - 0.1, high: c + 0.4, low: (i === 299 ? 300.3 : c) - 0.4, close: c, volume: 1 };
    });
    const daily = Array.from({ length: 200 }, (_, i) => ({ time: now - (200 - i) * DAY, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1 }));
    const subs = new Map();
    const ccxt = {
      subscribe: vi.fn((sid, ex, symbol, cb) => subs.set(symbol, cb)),
      unsubscribe: vi.fn(),
      ohlcv: vi.fn(async (_ex, _s, tf) => (tf === '1d' ? daily : hourly.slice(-10))),
      history: vi.fn(async () => hourly),
    };
    const deployed = [
      {
        id: 'd1',
        spec: { name: 'Channel breakout', signal: { id: 'donchian', p: { n: 20 } }, filters: [], exit: { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 24, onFlip: true }, sides: 'both' },
        tfH: 1,
        coins: ['BTC'],
        targets: { crypto: true, meme: false },
        stats: { sharpe: 1.2, t: 2.4, dsr: 0.9, trades: 60, verdict: 'promising' },
        on: true,
      },
    ];
    const db = { m: new Map(), get(k) { return this.m.get(k); }, set(k, v) { this.m.set(k, JSON.parse(JSON.stringify(v))); } };
    sw = new CryptoSwarm({ ccxt, db, now: () => now, labDeployed: () => deployed });
    sw.setConfig({ coins: ['BTC'], agents: { scalper: false, auction: false, trend: false, lab: true } });
    await sw.start();
    subs.get('BTC/USDC:USDC')?.({ kind: 'trades', trades: [{ p: 306, q: 1, s: 'buy', t: now }] });
    await sw.slow();
    const pos = sw.open()[0];
    expect(pos).toMatchObject({ coin: 'BTC', agent: 'lab', side: 'buy', labId: 'd1', owner: 'swarm' });
    expect(sw.lines.some((l) => /Lab · Channel breakout/.test(l.text))).toBe(true);
    // the same signal is not proposed twice
    await sw.slow();
    expect(sw.lines.filter((l) => /proposes a LONG/.test(l.text))).toHaveLength(1);
    // its time limit (24 bars of 1 hour) closes it
    now += 25 * HOUR;
    subs.get('BTC/USDC:USDC')?.({ kind: 'trades', trades: [{ p: 306.5, q: 1, s: 'buy', t: now }] });
    await vi.waitFor(() => expect(pos.closedAt).toBeTruthy());
    expect(pos.reason).toBe('time');
  });
});
