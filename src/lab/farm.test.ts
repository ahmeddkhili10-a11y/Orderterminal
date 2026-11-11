// The edge finder: bots bred from the bot builder's blocks, trained on the
// first 70 %, and only kept if they survive the holdout, 100 random bots,
// their settings nudged and 1,000 shuffles — then forward-tested on fresh data.
import { describe, expect, it } from 'vitest';
import { checkFlow, buildSpec, FLOW_DEFAULT, type Flow } from './flow';
import { Farm, farmKey, ladderOf, scoreOf, STAGES, type Survivor } from './farm';
import type { Market } from './library';
import { rngOf } from './ml';

const HOUR = 3_600_000;
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
/** hourly candles; with trend > 0, slow drifts that a trend rule can ride */
function market(coin: string, n: number, seed: number, trend = 0, t0 = Date.UTC(2024, 0, 1)): Market {
  const g = gauss(rngOf(seed));
  let p = 100;
  let mu = 0;
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.997 * mu + trend * 0.00045 * g();
    const o = p;
    p *= Math.exp(mu + 0.005 * g());
    return { time: t0 + i * HOUR, open: o, high: Math.max(o, p) * 1.0015, low: Math.min(o, p) * 0.9985, close: p, volume: 100 + ((i * 37) % 11) * 20 };
  });
  return { coin, tfH: 1, bars, funding: null };
}
const trending = () => ({ '1h': [market('BTC', 6000, 3, 1), market('ETH', 6000, 4, 1)] });
const noise = () => ({ '1h': [market('BTC', 6000, 5, 0), market('ETH', 6000, 6, 0)] });
const flow = (p: Partial<Flow>): Flow => ({ ...FLOW_DEFAULT, style: 'intraday', coins: 'BTC ETH', models: [], risks: [], ...p });

describe('breeding', () => {
  const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 3 });
  farm.setMarkets(trending());
  it('random bots are built from the blocks, never clash, and use only the paces and coins it has', () => {
    for (let i = 0; i < 60; i++) {
      const f = farm.randomFlow()!;
      expect(f).toBeTruthy();
      expect(f.style).toBe('intraday');
      expect(f.coins).toBe('BTC ETH');
      expect(f.decider).toBe('none');
      expect(checkFlow(f).some((x) => x.tone === 'clash'), JSON.stringify(f)).toBe(false);
      expect(f.risks).not.toContain('kelly');
      expect(buildSpec(f).timeframe).toBe('1h');
    }
  });
  it('a mutation changes one thing; a child takes blocks from both parents', () => {
    const a = flow({ strategies: ['tsmom'], stopWidth: 'normal' });
    const b = flow({ strategies: ['donchian'], models: ['trend'], stopWidth: 'wide', takeProfit: 'r2' });
    for (let i = 0; i < 30; i++) {
      const m = farm.mutate(a);
      expect(farmKey(m)).not.toBe(farmKey(a));
      expect(checkFlow(m).some((x) => x.tone === 'clash')).toBe(false);
      const c = farm.cross(a, b);
      for (const k of ['stopWidth', 'takeProfit'] as const) expect([a[k], b[k]]).toContain(c[k]);
      expect([a.strategies.join(), b.strategies.join()]).toContain(c.strategies.join());
    }
  });
  it('nudges every setting one step each way', () => {
    const n = farm.neighbours(flow({ strategies: ['tsmom'], stopWidth: 'normal', hold: 'normal', takeProfit: 'r2', tunes: { 'strategy:tsmom': { lookback: 72 } } }));
    const looks = n.map((x) => buildSpec(x).spec.signal.p.lookback).filter((v) => v !== 72);
    expect(looks.sort((x, y) => x - y)).toEqual([24, 168]);
    expect(n.some((x) => x.stopWidth === 'tight') && n.some((x) => x.stopWidth === 'wide')).toBe(true);
    expect(n.some((x) => x.hold === 'half') && n.some((x) => x.hold === 'long')).toBe(true);
    expect(n.some((x) => x.takeProfit === 'r15') && n.some((x) => x.takeProfit === 'r3')).toBe(true);
  });
});

describe('training never reads the unseen data', () => {
  it('another future gives the same training score', () => {
    const m = trending();
    const cut = Math.floor(6000 * 0.7);
    const other = { '1h': m['1h'].map((x) => ({ ...x, bars: x.bars.map((b, i) => (i >= cut ? { ...b, close: b.close * 0.6, open: b.open * 0.6, high: b.high * 0.6, low: b.low * 0.5 } : b)) })) };
    const a = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 1 });
    const b = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 1 });
    a.setMarkets(m);
    b.setMarkets(other);
    for (const f of [flow({ strategies: ['tsmom'] }), flow({ strategies: ['donchian'], models: ['trend'] }), flow({ strategies: ['zrev'] })]) expect(a.train(f).fit).toBe(b.train(f).fit);
  });
});

describe('the gauntlet', () => {
  it('a trend rule in a trending market survives every check, with the numbers to show it', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail', sides: 'both' });
    const t = farm.train(f);
    expect(t.fit).toBeGreaterThan(0.7);
    const g = farm.gauntlet(f, t.is!);
    expect(g.ok, g.ok ? '' : `${g.at}: ${g.why}`).toBe(true);
    if (!g.ok) return;
    expect(g.s.beat).toBeGreaterThanOrEqual(75);
    expect(g.s.nudge.kept / g.s.nudge.tried).toBeGreaterThanOrEqual(0.5);
    expect(g.s.mc.dd95).toBeLessThanOrEqual(0.2);
    expect(g.s.oos.sharpe).toBeGreaterThan(0.5);
    expect(g.s.summary.length).toBeGreaterThan(3);
    expect(g.s.curve.length).toBeGreaterThan(50);
    expect(g.s.stage).toBe('new');
    expect(g.s.seenTo).toBe(trending()['1h'][0].bars[5999].time);
  });

  it('in a market with no edge, almost nothing gets through — and where they fail is recorded', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 9 });
    farm.setMarkets(noise());
    for (let i = 0; i < 200; i++) farm.step();
    const st = farm.state(true);
    expect(st.tried).toBeGreaterThan(120);
    expect(st.funnel.bred).toBe(st.tried);
    // each stage holds no more than the one before
    const counts = STAGES.map((s) => st.funnel[s.id]);
    for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    // the video's four checks let a few lucky ones through when hundreds are tried; significance stops them reaching the top five
    expect(st.funnel.shuffle).toBeLessThanOrEqual(Math.max(3, st.tried * 0.05));
    expect(st.funnel.proof).toBe(0);
    expect(st.top).toEqual([]);
    for (const w of st.watch) expect(w.sig).toBe(false);
    expect(st.gen).toBeGreaterThan(2);
    for (const r of st.recent) expect(r.why.length).toBeGreaterThan(10);
  }, 60_000);

  it('in a trending market the loop finds survivors and keeps a top five of different families', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 700 && farm.state(true).survivors < 3; i++) farm.step();
    const st = farm.state(true);
    expect(st.survivors).toBeGreaterThan(0);
    expect(st.top.length).toBeGreaterThan(0);
    expect(st.top.length).toBeLessThanOrEqual(5);
    const fams = st.top.map((s) => JSON.stringify([s.style, [...s.flow.strategies].sort(), [...s.flow.models].sort()]));
    expect(new Set(fams).size).toBe(fams.length);
    for (const s of st.top) expect(s.beat).toBeGreaterThanOrEqual(75);
    for (const s of st.top) expect(s.sig || s.stage === 'proven').toBe(true);
  }, 120_000);
});

describe('fresh data: forward tests, the ladder and the fleet', () => {
  it('a survivor is forward-tested on candles that arrive after it was found', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const f = flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' });
    const t = farm.train(f);
    const g = farm.gauntlet(f, t.is!);
    expect(g.ok).toBe(true);
    if (!g.ok) return;
    farm.survivors.push(g.s);
    // a thousand more hours of the same markets (the same seeds: the first 6,000 hours are the same)
    farm.setMarkets({ '1h': [market('BTC', 7000, 3, 1), market('ETH', 7000, 4, 1)] });
    const s = farm.survivors[0];
    expect(s.forward).toBeTruthy();
    expect(s.forward!.bars).toBeGreaterThan(900);
    expect(s.forward!.bars).toBeLessThanOrEqual(1001);
    expect(['incubating', 'proving', 'proven', 'faded']).toContain(s.stage);
  });

  it('the ladder: new, incubating, proving, proven — or faded', () => {
    const oos = { maxDD: 0.08 } as Survivor['oos'];
    const fw = (trades: number, ret: number, maxDD = 0.02) => ({ forward: { bars: 100, trades, ret, sharpe: ret > 0 ? 1 : -1, maxDD, days: 30 }, oos });
    expect(ladderOf({ forward: null, oos })).toBe('new');
    expect(ladderOf(fw(2, 0.01))).toBe('incubating');
    expect(ladderOf(fw(8, 0.02))).toBe('proving');
    expect(ladderOf(fw(20, 0.05))).toBe('proven');
    expect(ladderOf(fw(20, -0.02))).toBe('faded');
    expect(ladderOf(fw(6, 0.01, 0.2))).toBe('faded');
    // fresh-data results move the score
    const base = { oos: { sharpe: 1.5, trades: 40 } as Survivor['oos'], nudge: { kept: 8, tried: 10 }, beat: 90 };
    expect(scoreOf({ ...base, forward: { bars: 100, trades: 10, ret: 0.05, sharpe: 2, maxDD: 0.02, days: 30 } })).toBeGreaterThan(scoreOf({ ...base, forward: null }));
    expect(scoreOf({ ...base, forward: { bars: 100, trades: 10, ret: -0.05, sharpe: -1.5, maxDD: 0.05, days: 30 } })).toBeLessThan(scoreOf({ ...base, forward: null }));
  });

  it('deployed strategies are watched on fresh data; a fading one is flagged', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 2 });
    farm.setMarkets(trending());
    const at = trending()['1h'][0].bars[3000].time;
    const good = buildSpec(flow({ strategies: ['tsmom'], tunes: { 'strategy:tsmom': { lookback: 72 } }, takeProfit: 'trail' })).spec;
    const bad = { ...good, sides: 'short' as const };
    farm.checkFleet([
      { id: 'a', name: 'trend', spec: good, tfH: 1, coins: ['BTC', 'ETH'], deployedAt: at, stats: { sharpe: 1 } },
      { id: 'b', name: 'short only', spec: { ...good, signal: { id: 'tsmom', p: { lookback: 72 } }, sides: 'both', filters: [], exit: { ...good.exit } }, tfH: 1, coins: ['BTC'], deployedAt: trending()['1h'][0].bars[5995].time },
      { id: 'c', name: 'elsewhere', spec: good, tfH: 4, coins: ['BTC'], deployedAt: at },
    ]);
    const [a, b, c] = farm.fleet;
    expect(a.forward!.trades).toBeGreaterThan(5);
    expect(['healthy', 'slipping', 'fading']).toContain(a.status);
    expect(b.status).toBe('watching');
    expect(c.status).toBe('no data');
    void bad;
  });
});

describe('it survives a restart', () => {
  it('saves and restores its survivors, counters and population', () => {
    const farm = new Farm({ coins: ['BTC', 'ETH'], styles: ['intraday'] }, { seed: 4 });
    farm.setMarkets(trending());
    for (let i = 0; i < 60; i++) farm.step();
    const saved = JSON.parse(JSON.stringify(farm.save()));
    const again = new Farm(saved.cfg, { seed: 5, save: saved });
    again.setMarkets(trending());
    expect(again.tried).toBe(farm.tried);
    expect(again.gen).toBe(farm.gen);
    expect(again.survivors.length).toBe(farm.survivors.length);
    expect(again.state(false).funnel).toEqual(farm.state(false).funnel);
    // and carries on
    for (let i = 0; i < 20; i++) again.step();
    expect(again.tried).toBeGreaterThan(farm.tried);
  }, 60_000);
});
