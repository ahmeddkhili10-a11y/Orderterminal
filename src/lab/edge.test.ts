// The Quant desk's newer functions (pairs and cointegration, lead and lag,
// seasonality, the Monte Carlo on trades) and the bridge that carries a
// model from the desk into a bot.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySend, sendToBot, startLabBridge, styleFor, takeSends, tuneWords, useLabInbox, type LabSend } from './bridge';
import { buildSpec, FLOW_DEFAULT, migrateFlow, type Flow } from './flow';
import { ctxOf, SIGNAL_MAP, type Market } from './library';
import { rngOf } from './ml';
import { cointegration, EG_CRIT, leadLag, ruinSim, seasonality, tradesFrom } from './quant';

const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
function logWalk(n: number, seed: number, sd = 0.01): number[] {
  const g = gauss(rngOf(seed));
  let p = 4;
  return Array.from({ length: n }, () => (p += sd * g()));
}

describe('pairs and cointegration', () => {
  it('finds the tie, the hedge ratio and the speed of a pair that is tied', () => {
    const x = logWalk(1500, 1);
    const g = gauss(rngOf(2));
    let s = 0;
    // the gap closes 10 % a bar: half of it in about 6.6 bars
    const y = x.map((v) => 0.5 + 1.3 * v + (s = 0.9 * s + 0.01 * g()));
    const c = cointegration(y, x)!;
    expect(c.beta).toBeCloseTo(1.3, 1);
    expect(c.adf).toBeLessThan(EG_CRIT[1]);
    expect(c.level).toBe(1);
    expect(c.halfLife).toBeGreaterThan(4);
    expect(c.halfLife).toBeLessThan(10);
    expect(c.r2).toBeGreaterThan(0.9);
    expect(c.resid.length).toBe(1500);
    expect(c.z).toBeCloseTo(c.resid[1499] / c.sd, 9);
  });

  it('does not call two unrelated walks tied', () => {
    let tied = 0;
    for (let k = 0; k < 20; k++) {
      const c = cointegration(logWalk(800, 100 + k), logWalk(800, 500 + k))!;
      if (c.level !== null && c.level <= 5) tied++;
    }
    // a 5 % test is wrong about one time in twenty; never most of the time
    expect(tied).toBeLessThanOrEqual(3);
  });

  it('needs enough clean data', () => {
    expect(cointegration([1, 2, 3], [1, 2, 3])).toBeNull();
    expect(cointegration(logWalk(100, 1), logWalk(100, 2).map((v, i) => (i === 50 ? NaN : v)))).toBeNull();
    expect(cointegration(logWalk(100, 1), Array(100).fill(1))).toBeNull();
  });

  it('lead and lag: says who moves first, and by how many bars', () => {
    const g = gauss(rngOf(5));
    const x = Array.from({ length: 3000 }, () => g());
    const h = gauss(rngOf(6));
    const y = x.map((_, i) => (i >= 2 ? 0.6 * x[i - 2] : 0) + 0.8 * h());
    const ll = leadLag(x, y, 4);
    expect(ll.map((l) => l.lag)).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
    const best = ll.slice().sort((a, b) => Math.abs(b.corr) - Math.abs(a.corr))[0];
    expect(best.lag).toBe(2);
    expect(best.corr).toBeGreaterThan(0.4);
    for (const l of ll) if (l.lag !== 2) expect(Math.abs(l.corr)).toBeLessThan(0.1);
  });
});

describe('seasonality', () => {
  const HOUR = 3_600_000;
  const t0 = Date.UTC(2024, 0, 1); // a Monday
  it('finds an hour that really is different and holds the others to the bar for 24 tries', () => {
    const g = gauss(rngOf(9));
    const n = 24 * 365;
    const times = Array.from({ length: n }, (_, i) => t0 + i * HOUR);
    const rets = times.map((t) => 0.004 * g() + (new Date(t).getUTCHours() === 21 ? 0.0015 : 0));
    const s = seasonality(times, rets);
    expect(s.hours.length).toBe(24);
    expect(s.days.length).toBe(7);
    expect(s.hours[21].n).toBe(365);
    expect(s.hours[21].t).toBeGreaterThan(s.tBar);
    expect(s.hours[21].up).toBeGreaterThan(0.55);
    const others = s.hours.filter((_, h) => h !== 21);
    expect(others.filter((h) => Math.abs(h.t) > s.tBar).length).toBe(0);
    // the grid is weekday × hour, Monday the first day of this sample
    expect(s.grid.length).toBe(7);
    expect(s.grid[1].length).toBe(24);
    expect(s.days[1].n).toBeGreaterThan(1200);
  });

  it('skips bad returns and copes with an empty cell', () => {
    const s = seasonality([t0, t0 + HOUR, t0 + 2 * HOUR], [0.01, NaN, -0.01]);
    expect(s.hours[0].n).toBe(1);
    expect(s.hours[1].n).toBe(0);
    expect(Number.isNaN(s.hours[1].mean)).toBe(true);
    expect(Number.isNaN(s.grid[0][5])).toBe(true);
  });
});

describe('Monte Carlo on trades', () => {
  it('builds a trade list with the win rate and payoff asked for', () => {
    const rs = tradesFrom(0.45, 2, 1, 400);
    expect(rs.length).toBe(400);
    expect(rs.filter((r) => r > 0).length).toBe(180);
    expect(new Set(rs)).toEqual(new Set([2, -1]));
  });

  it('a real edge at small risk grows and survives; the same edge at high risk is ruined far more often', () => {
    const rs = tradesFrom(0.45, 2);
    const small = ruinSim(rs, { risk: 0.01, trades: 300, target: 2, ruin: 0.5 })!;
    const big = ruinSim(rs, { risk: 0.15, trades: 300, target: 2, ruin: 0.5 })!;
    expect(small.p50).toBeGreaterThan(1.5);
    expect(small.pRuin).toBeLessThan(0.01);
    expect(small.pLoss).toBeLessThan(0.1);
    expect(big.pRuin).toBeGreaterThan(0.5);
    expect(big.dd95).toBeGreaterThan(small.dd95);
    expect(small.p5).toBeLessThanOrEqual(small.p50);
    expect(small.p50).toBeLessThanOrEqual(small.p95);
    expect(small.fan[0]).toEqual([1, 1, 1, 1, 1]);
    expect(small.fan.length).toBe(41);
    for (const row of small.fan) for (let i = 1; i < 5; i++) expect(row[i]).toBeGreaterThanOrEqual(row[i - 1]);
    expect(small.streak95).toBeGreaterThanOrEqual(small.streakMed);
    expect(small.streakMed).toBeGreaterThanOrEqual(3);
  });

  it('no edge: more trades and more risk only lose', () => {
    const rs = tradesFrom(0.3, 2);
    const s = ruinSim(rs, { risk: 0.02, trades: 300 })!;
    expect(s.p50).toBeLessThan(1);
    expect(s.pLoss).toBeGreaterThan(0.8);
    expect(s.pTarget).toBeLessThan(0.02);
  });

  it('gives the same futures for the same inputs, keeps streaks when asked, and refuses too little', () => {
    const rs = [...Array(30).fill(-1), ...Array(30).fill(2)];
    const a = ruinSim(rs, { risk: 0.02, trades: 120, seed: 4 })!;
    const b = ruinSim(rs, { risk: 0.02, trades: 120, seed: 4 })!;
    expect(a).toEqual(b);
    // the list has its losses in one long run: kept in blocks, losing streaks are longer than when shuffled
    const blocks = ruinSim(rs, { risk: 0.02, trades: 120, seed: 4, block: 10 })!;
    expect(blocks.streakMed).toBeGreaterThan(a.streakMed);
    expect(ruinSim([1, -1, 1], { risk: 0.01, trades: 50 })).toBeNull();
    expect(ruinSim(rs, { risk: 0, trades: 50 })).toBeNull();
  });
});

describe('the bridge from the Quant desk to the bot builder', () => {
  const flow = (p: Partial<Flow> = {}): Flow => ({ ...FLOW_DEFAULT, ...p });
  const send = (p: Partial<LabSend> & Pick<LabSend, 'block' | 'id'>): LabSend => ({ from: 'NNET', ...p });

  it('a network trained on the desk becomes the bot’s strategy, with its size, horizon, candles and coin', () => {
    const r = applySend(flow(), send({ block: 'strategy', id: 'nn', tune: { h1: 32, h2: 16, horizon: 24, edge: 0.05 }, coins: ['DOGE'], style: styleFor(4, 24), solo: true }));
    expect(r.ok).toBe(true);
    expect(r.block).toBe('strategy');
    expect(r.flow.strategies).toEqual(['nn']);
    expect(r.flow.tunes).toEqual({ 'strategy:nn': { h1: 32, h2: 16, horizon: 24, edge: 0.05 } });
    expect(r.flow.coins).toBe('BTC ETH SOL DOGE');
    expect(r.text).toMatch(/From NNET/);
    expect(r.text).toMatch(/32 → 16 hidden units/);
    expect(r.text).toMatch(/looks 24 hours ahead/);
    const built = buildSpec(r.flow);
    expect(built.spec.signal).toEqual({ id: 'nn', p: { horizon: 24, edge: 0.05, h1: 32, h2: 16 } });
    expect(built.timeframe).toBe('4h');
    expect(built.summary.join(' ')).toMatch(/32 and 16 hidden units/);
  });

  it('joins the strategies already picked unless told to replace them', () => {
    const r = applySend(flow({ strategies: ['tsmom'] }), send({ block: 'strategy', id: 'nn', tune: { h1: 8, h2: 4, horizon: 4 } }));
    expect(r.flow.strategies).toEqual(['tsmom', 'nn']);
    expect(r.flow.style).toBe('swing');
    const again = applySend(r.flow, send({ block: 'strategy', id: 'nn', tune: { h1: 16, h2: 8, horizon: 12 } }));
    expect(again.flow.strategies).toEqual(['tsmom', 'nn']);
    expect(again.flow.tunes!['strategy:nn']).toEqual({ h1: 16, h2: 8, horizon: 12 });
  });

  it('a second opinion and a decision maker carry the network’s size too', () => {
    const a = applySend(flow(), send({ block: 'forecast', id: 'nn', tune: { h1: 32, h2: 16, horizon: 12 } }));
    expect(a.flow.forecasts).toEqual(['nn']);
    const spec = buildSpec(a.flow).spec;
    expect(spec.filters.find((f) => f.id === 'agree')!.p).toEqual({ model: 4, h1: 32, h2: 16, horizon: 12 });
    const b = applySend(a.flow, send({ block: 'decider', id: 'both', tune: { h1: 32, h2: 16 } }));
    expect(b.flow.decider).toBe('both');
    expect(buildSpec(b.flow).spec.metaNet).toEqual([32, 16]);
    expect(buildSpec(b.flow).spec.autoMeta).toBe('both');
    // the forest alone has no network to size
    expect(buildSpec({ ...b.flow, decider: 'forest' }).spec.metaNet).toBeUndefined();
  });

  it('risk and portfolio picks: a target travels with the sizing rule, a third sizing rule replaces the oldest', () => {
    const a = applySend(flow({ risks: [] }), send({ from: 'VTGT', block: 'risk', id: 'voltarget', tune: { target: 0.4 } }));
    expect(buildSpec(a.flow).spec.sizing).toEqual({ mode: 'vol', target: 0.4 });
    const b = applySend(applySend(a.flow, send({ from: 'VAR', block: 'risk', id: 'var' })).flow, send({ from: 'KELLY', block: 'risk', id: 'kelly' }));
    expect(b.flow.risks).toEqual(['var', 'kelly']);
    expect(b.text).toMatch(/made way/);
    expect(b.flow.tunes).toBeUndefined();
    const p = applySend(flow(), send({ from: 'EF', block: 'portfolio', id: 'tangency' }));
    expect(p.flow.portfolio).toBe('tangency');
    expect(p.block).toBe('risk');
  });

  it('refuses what the bot builder does not have, and changes nothing', () => {
    const f = flow();
    const r = applySend(f, send({ block: 'strategy', id: 'nope' }));
    expect(r.ok).toBe(false);
    expect(r.flow).toEqual(migrateFlow(f as Flow & Record<string, unknown>));
  });

  it('settings live and die with their pick, and only numbers are kept', () => {
    const f = migrateFlow({ ...flow({ strategies: ['nn'] }), tunes: { 'strategy:nn': { h1: 32, bad: 'x' as unknown as number }, 'strategy:tsmom': { lookback: 24 }, decider: { h1: 8 } } } as Flow & Record<string, unknown>);
    expect(f.tunes).toEqual({ 'strategy:nn': { h1: 32 } });
    expect(migrateFlow({ ...f, strategies: ['tsmom'] } as Flow & Record<string, unknown>).tunes).toBeUndefined();
  });

  it('picks the style a model was studied at', () => {
    expect(styleFor(1, 4)).toBe('scalp');
    expect(styleFor(1, 24)).toBe('intraday');
    expect(styleFor(4, 24)).toBe('swing');
    expect(styleFor(4, 168)).toBe('week');
    expect(styleFor(24, 24 * 30)).toBe('position');
    expect(tuneWords({ target: 0.4 })).toBe('target 40 %');
    expect(tuneWords({ window: 168, k: 2 })).toBe('7-day window, 2 standard deviations');
    expect(tuneWords(undefined)).toBe('');
  });

  describe('delivery', () => {
    beforeEach(() => useLabInbox.setState({ queue: [] }));
    it('what is sent waits for the bot builder, which is opened, and is taken once', () => {
      const open = vi.fn();
      startLabBridge(open);
      sendToBot(send({ block: 'model', id: 'garch-calm', from: 'GV' }));
      sendToBot(send({ block: 'risk', id: 'kelly', from: 'KELLY' }));
      expect(open).toHaveBeenCalledTimes(2);
      expect(useLabInbox.getState().queue.length).toBe(2);
      const got = takeSends();
      expect(got.map((s) => s.id)).toEqual(['garch-calm', 'kelly']);
      expect(takeSends()).toEqual([]);
      // applied in order to the bot being built
      let f = flow();
      for (const s of got) f = applySend(f, s).flow;
      expect(f.models).toContain('garch-calm');
      expect(f.risks).toContain('kelly');
    });
  });
});

describe('the neural network rule at the size it is given', () => {
  it('trains at any size, on the training bars only, and says its size', () => {
    const g = gauss(rngOf(3));
    let p = 100;
    const bars = Array.from({ length: 1400 }, (_, i) => {
      const o = p;
      p *= Math.exp(0.006 * g());
      return { time: Date.UTC(2024, 0, 1) + i * 3_600_000, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 100 + (i % 9) * 10 };
    });
    const m: Market = { coin: 'X', tfH: 1, bars, funding: null };
    const small = SIGNAL_MAP.nn.compute(ctxOf(m, 1000), { horizon: 4, edge: 0.02, h1: 8, h2: 4 });
    const large = SIGNAL_MAP.nn.compute(ctxOf(m, 1000), { horizon: 4, edge: 0.02, h1: 32, h2: 16 });
    expect(small.length).toBe(1400);
    // two different networks: they do not make identical calls
    expect(Array.from(small).join('')).not.toBe(Array.from(large).join(''));
    // the same settings give the same network
    expect(Array.from(SIGNAL_MAP.nn.compute(ctxOf(m, 1000), { horizon: 4, edge: 0.02, h1: 8, h2: 4 }))).toEqual(Array.from(small));
    expect(SIGNAL_MAP.nn.describe({ horizon: 4, edge: 0.02, h1: 8, h2: 4 })).toMatch(/8 and 4 hidden units/);
    expect(SIGNAL_MAP.nn.describe({ horizon: 4, edge: 0.02 })).toMatch(/16 and 8 hidden units/);
  });
});
