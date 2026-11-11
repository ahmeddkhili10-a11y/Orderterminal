import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CryptoSwarm } from '../cswarm/cswarm.mjs';
import { evaluate, research, scoreVariants } from '../../src/lab/research.ts';
import { alignFunding, LabService } from './lab.mjs';
import { createFarmRunner } from './farmLoop.mjs';

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

/** the edge finder's thread, run in-process: the same loop farmWorker.mjs runs */
function inlineFarmWorker() {
  const w = new EventEmitter();
  const runner = createFarmRunner((m) => setImmediate(() => w.emit('message', m)), { sleep: () => new Promise((r) => setImmediate(r)) });
  w.postMessage = (msg) => void runner.onMessage(msg);
  w.terminate = async () => {};
  w.runner = runner;
  return w;
}

/** hourly candles with slow trends a trend rule can ride */
function trendWalk(n, now, seed) {
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const g = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
  let p = 100;
  let mu = 0;
  return Array.from({ length: n }, (_, i) => {
    mu = 0.997 * mu + 0.00045 * g();
    const o = p;
    p *= Math.exp(mu + 0.005 * g());
    return { time: now - (n - i) * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 + ((i * 37) % 11) * 20 };
  });
}

describe('the edge finder service', () => {
  it('starts, runs by itself, finds and keeps survivors, stops, and carries on after a restart', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, sym, _tf, since) => trendWalk(6000, now, sym.startsWith('BTC') ? 3 : 4).filter((b) => b.time >= since)), fundingHistory: vi.fn(async () => []) };
    const dir = mkdtempSync(join(tmpdir(), 'lab-'));
    const pushed = [];
    let worker;
    const lab = new LabService({ ccxt, dir, emit: (ch, m) => ch === 'lab:farm' && pushed.push(m), makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now });
    // never started: wanted by default, nothing found yet
    expect(lab.farmState()).toMatchObject({ running: false, wanted: true, tried: 0, top: [] });
    await expect(lab.farmStart({ coins: [], styles: ['intraday'] })).rejects.toThrow(/at least one coin/);
    const st = await lab.farmStart({ coins: ['btc', 'ETH'], styles: ['intraday'] });
    expect(st.running).toBe(true);
    expect(st.cfg.coins).toEqual(['BTC', 'ETH']);
    expect(ccxt.history.mock.calls.every((c) => c[2] === '1h')).toBe(true);
    // it runs on its own until it has survivors
    for (let i = 0; i < 20000 && !(worker.runner.farm?.survivors.length >= 1 && worker.runner.farm?.tried > 10); i++) await new Promise((r) => setImmediate(r));
    expect(worker.runner.farm.tried).toBeGreaterThan(10);
    expect(worker.runner.farm.survivors.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 1600));
    expect(pushed.length).toBeGreaterThan(1);
    expect(lab.farmState().tried).toBeGreaterThan(0);
    // stop: it saves, and stays stopped when the terminal opens again
    const stopped = await lab.farmStop();
    expect(stopped).toMatchObject({ running: false, wanted: false });
    const tried = stopped.tried;
    expect(tried).toBeGreaterThan(10);
    const lab2 = new LabService({ ccxt, dir, emit: () => {}, makeWorker: inlineWorker, makeFarmWorker: () => (worker = inlineFarmWorker()), now: () => now });
    expect(lab2.farmState()).toMatchObject({ running: false, wanted: false });
    expect(lab2.farmState().tried).toBe(tried);
    expect(lab2.farmState().survivors).toBeGreaterThan(0);
    // started again, it carries on from where it was
    await lab2.farmStart();
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.runner.farm.tried).toBeGreaterThanOrEqual(tried);
    expect(worker.runner.farm.survivors.length).toBeGreaterThan(0);
    // a strategy deployed is watched on fresh data
    const s = worker.runner.farm.survivors[0];
    const { buildSpec } = await import('../../src/lab/flow.ts');
    lab2.deploy({ spec: buildSpec(s.flow).spec, tfH: 1, stats: { sharpe: 1, t: 2, dsr: 0.9, trades: 30, verdict: 'edge finder' } }, { crypto: true, meme: false }, ['BTC', 'ETH']);
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.runner.farm.fleet.length).toBe(1);
    await lab2.farmStop();
  }, 120_000);
});

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

  it('a shorter request keeps the longer history in the cache', async () => {
    const now = Date.UTC(2026, 10, 6, 12);
    const ccxt = { history: vi.fn(async (_id, _sym, _tf, since) => walk(Math.floor((now - since) / HOUR), now, 3)) };
    const lab = new LabService({ ccxt, dir: mkdtempSync(join(tmpdir(), 'lab-')), emit: () => {}, makeWorker: inlineWorker, now: () => now });
    const two = await lab.candles('BTC', '1h', 2, 'binance');
    expect(ccxt.history).toHaveBeenCalledTimes(1);
    const one = await lab.candles('BTC', '1h', 1, 'binance');
    expect(one.bars.length).toBeLessThan(two.bars.length);
    // two years again: served from the cache, nothing downloaded again
    const again = await lab.candles('BTC', '1h', 2, 'binance');
    expect(ccxt.history).toHaveBeenCalledTimes(1);
    expect(again.bars.length).toBe(two.bars.length);
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
