// The optimizer: the diagnosis of a test, the changes it tries, how they are
// measured (inside the training years, never on the unseen data) and ranked.
import { describe, expect, it } from 'vitest';
import { advise, rankVariants, specsOf, specVariants, triesWords, variantsOf, type Variant } from './advisor';
import { buildSpec, checkFlow, FLOW_DEFAULT, type Flow } from './flow';
import type { Market } from './library';
import { rngOf } from './ml';
import { evaluate, periodsOf, scoreVariants, type Diag, type Periods, type VariantScore } from './research';

const HOUR = 3_600_000;
const gauss = (rnd: () => number) => () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(2 * Math.PI * rnd());
function market(coin: string, n: number, seed: number, drift = 0, trend = 0): Market {
  const g = gauss(rngOf(seed));
  let p = 100;
  let mu = 0;
  const bars = Array.from({ length: n }, (_, i) => {
    mu = 0.995 * mu + trend * 0.0006 * g();
    const o = p;
    p *= Math.exp(drift + mu + 0.006 * g());
    return { time: Date.UTC(2023, 0, 2) + i * HOUR, open: o, high: Math.max(o, p) * 1.002, low: Math.min(o, p) * 0.998, close: p, volume: 100 + ((i * 37) % 11) * 20 };
  });
  return { coin, tfH: 1, bars, funding: null };
}
const flow = (p: Partial<Flow> = {}): Flow => ({ ...FLOW_DEFAULT, ...p });

describe('results by period', () => {
  it('groups by calendar month over a long stretch and by week over a short one', () => {
    const day = 86_400_000;
    const t0 = Date.UTC(2024, 0, 1);
    const long = Array.from({ length: 200 }, (_, i) => t0 + i * day);
    const m = periodsOf(long.map((t) => (new Date(t).getUTCMonth() === 1 ? -0.001 : 0.001)), long);
    expect(m.unit).toBe('month');
    expect(m.list.length).toBe(7);
    expect(m.list[1].ret).toBeLessThan(0);
    expect(m.list[0].ret).toBeCloseTo(1.001 ** 31 - 1, 9);
    expect(m.up).toBeCloseTo(6 / 7, 9);
    expect(m.worst).toBeCloseTo(0.999 ** 29 - 1, 9);
    const short = Array.from({ length: 28 }, (_, i) => t0 + i * day); // 1 Jan 2024 is a Monday
    const w = periodsOf(short.map((_, i) => (i < 7 ? -0.01 : 0.01)), short);
    expect(w.unit).toBe('week');
    expect(w.list.length).toBe(4);
    expect(w.up).toBe(0.75);
    expect(new Date(w.list[0].t).getUTCDay()).toBe(1);
  });
  it('a test reports them, with the diagnosis of its training trades', () => {
    const r = evaluate([market('X', 4000, 5, 0, 1)], buildSpec(flow({ style: 'intraday', coins: 'X', models: [] })).spec, 0.7);
    expect(r.periods.list.length).toBeGreaterThan(3);
    expect(r.diag.trades).toBeGreaterThan(10);
    expect(r.diag.exits.reduce((a, e) => a + e.n, 0)).toBe(r.diag.trades);
    expect(r.diag.long.n + r.diag.short.n).toBe(r.diag.trades);
    expect(r.diag.coins.map((c) => c.coin)).toEqual(['X']);
    expect(r.diag.costShare).toBeGreaterThan(0);
    expect(r.diag.tradesPerMonth).toBeGreaterThan(1);
  });
});

describe('the changes the optimizer tries', () => {
  it('are one step from the bot, never clash, and cover stops, exits, sides, filters, sizing, settings and pace', () => {
    const f = flow({ style: 'intraday', strategies: ['tsmom'], models: ['trend'], risks: ['voltarget'] });
    const vs = variantsOf(f);
    expect(new Set(vs.map((v) => v.id)).size).toBe(vs.length);
    expect(vs.length).toBeGreaterThan(30);
    for (const v of vs) expect(checkFlow(v.flow).some((x) => x.tone === 'clash'), v.id).toBe(false);
    const ids = vs.map((v) => v.id);
    for (const id of ['stop:wide', 'stop:tight', 'tp:r2', 'hold:long', 'flip:off', 'side:long', 'model-:trend', 'model+:garch-calm', 'fc+:kalman', 'risk-:voltarget', 'risk+:garchstop', 'style:scalp']) expect(ids, id).toContain(id);
    // a trend rule is not offered the filters that fight it; the pace stays on the same candles; Kelly is left to the test
    expect(ids).not.toContain('model+:adx-range');
    expect(ids).not.toContain('style:swing');
    expect(ids).not.toContain('risk+:kelly');
    // its look-back, one step each way along the published grid (24 hours → 72)
    const up = vs.find((v) => v.id === 'set:tsmom:lookback:72')!;
    expect(buildSpec(up.flow).spec.signal.p.lookback).toBe(72);
    expect(ids.filter((x) => x.startsWith('set:tsmom:lookback')).length).toBe(1);
    // every one differs from the bot
    const base = JSON.stringify(buildSpec(f).spec);
    for (const v of vs) expect(JSON.stringify(buildSpec(v.flow).spec) + buildSpec(v.flow).coins.join() !== base + buildSpec(f).coins.join(), v.id).toBe(true);
  });

  it('offers to leave out a coin that lost in training, and to change how strategies are joined', () => {
    const f = flow({ strategies: ['tsmom', 'donchian'], combine: 'all', coins: 'BTC ETH SOL' });
    const diag = { coins: [{ coin: 'BTC', sharpe: 0.9, trades: 30 }, { coin: 'ETH', sharpe: 0.4, trades: 30 }, { coin: 'SOL', sharpe: -0.7, trades: 30 }] } as Diag;
    const ids = variantsOf(f, diag).map((v) => v.id);
    expect(ids).toContain('coin-:SOL');
    expect(ids).not.toContain('coin-:BTC');
    expect(ids).toContain('join:majority');
    // a trend rule and a dip rule only work joined by "all": the other joins clash, so they are not offered
    expect(variantsOf(flow({ strategies: ['tsmom', 'rsi2'], combine: 'all' })).map((v) => v.id).filter((x) => x.startsWith('join:'))).toEqual([]);
    // the bitcoin hedge keeps bitcoin in
    const hedged = variantsOf(flow({ coins: 'BTC ETH', risks: ['hedged'] }), { coins: [{ coin: 'BTC', sharpe: -1, trades: 30 }, { coin: 'ETH', sharpe: 1, trades: 30 }] } as Diag).map((v) => v.id);
    expect(hedged).not.toContain('coin-:BTC');
  });

  it('are sent with the bot itself first, on the same candles only', () => {
    const f = flow({ style: 'intraday' });
    const specs = specsOf(f, variantsOf(f));
    expect(specs[0].id).toBe('base');
    expect(specs.length).toBeGreaterThan(30);
  });
});

describe('measuring the changes', () => {
  // a steep, steady climb with noise around it
  const up = market('X', 5000, 11, 0.0006, 0);
  // a dip-buying rule, both ways, in a market that only rises: buying dips pays, selling rallies does not
  const f = flow({ style: 'intraday', strategies: ['rsi2'], models: [], risks: [], coins: 'X', flip: false, takeProfit: 'r15' });
  const vs = variantsOf(f);
  const specs = specsOf(f, vs);

  it('never reads the unseen data: another future gives the same scores', () => {
    const cut = Math.floor(5000 * 0.7);
    const other: Market = { ...up, bars: up.bars.map((b, i) => (i >= cut ? { ...b, open: b.open * 0.5, high: b.high * 0.5, low: b.low * 0.4, close: b.close * 0.5 * (1 + 0.01 * Math.sin(i)) } : b)) };
    const a = scoreVariants([up], specs.slice(0, 12), 0.7);
    const b = scoreVariants([other], specs.slice(0, 12), 0.7);
    expect(a).toEqual(b);
    expect(a[0].id).toBe('base');
    expect(a[0].trades).toBeGreaterThan(5);
  });

  it('in a market that only rises, finds that long only beats trading both ways', () => {
    // (the bot fades moves both ways; the shorts fight the drift)
    const scores = scoreVariants([up], specs, 0.7);
    const { base, ranked, tried } = rankVariants(vs, scores, 'sharpe');
    expect(base).toBeTruthy();
    expect(tried).toBeGreaterThan(25);
    const long = ranked.find((r) => r.variant.id === 'side:long');
    expect(long, ranked.map((r) => r.variant.id).join(',')).toBeTruthy();
    expect(long!.score.sharpe).toBeGreaterThan(base!.sharpe);
    // short only is no improvement at all
    expect(ranked.find((r) => r.variant.id === 'side:short')).toBeUndefined();
    expect(scores.find((x) => x.id === 'side:short')!.sharpe).toBeLessThan(base!.sharpe);
    expect(long!.text).toMatch(/Sharpe .* → /);
    // best first among those that also held on the earlier years
    const cons = ranked.filter((r) => r.consistent);
    for (let i = 1; i < cons.length; i++) expect(cons[i - 1].gain).toBeGreaterThanOrEqual(cons[i].gain);
  });

  it('reports a version that cannot run instead of failing the rest', () => {
    const s = scoreVariants([up], [specs[0], { id: 'broken', spec: { ...specs[0].spec, signal: { id: 'nope', p: {} } } }], 0.7);
    expect(s[0].error).toBeUndefined();
    expect(s[1].error).toBeTruthy();
    expect(rankVariants([{ id: 'broken' } as Variant], s, 'sharpe').ranked).toEqual([]);
  });
});

describe('changes to a research result', () => {
  it('cover the rule’s settings, the stop, exits, sides, filters and sizing — each a strategy that runs', () => {
    const spec = buildSpec(flow({ style: 'intraday', strategies: ['donchian'], models: ['trend'], risks: [], coins: 'X' })).spec;
    const vs = specVariants(spec);
    expect(new Set(vs.map((v) => v.id)).size).toBe(vs.length);
    const ids = vs.map((v) => v.id);
    for (const id of ['stop:wide', 'stop:tight', 'stop:garch', 'tp:2', 'hold:long', 'hold:short', 'flip:off', 'side:long', 'filter-:0', 'size:vol']) expect(ids, id).toContain(id);
    expect(ids.some((x) => x.startsWith('set:n:'))).toBe(true);
    expect(ids.some((x) => x.startsWith('filter+:garch'))).toBe(true);
    expect(ids.some((x) => x.startsWith('filter+:crowd'))).toBe(false); // needs funding history
    expect(ids.some((x) => x.startsWith('filter+:trend'))).toBe(false); // already there
    const m = market('X', 3000, 4, 0, 1);
    const scores = scoreVariants([m], [{ id: 'base', spec }, ...vs.map((v) => ({ id: v.id, spec: v.spec }))], 0.7);
    expect(scores.filter((x) => x.error).map((x) => `${x.id}: ${x.error}`)).toEqual([]);
    const { tried } = rankVariants(vs, scores, 'sharpe');
    expect(tried).toBe(vs.length);
  });
});

describe('ranking by goal', () => {
  const v = (id: string): Variant => ({ id, label: id, why: '', kind: 'stop', flow: flow() });
  const s = (id: string, o: Partial<VariantScore>): VariantScore => ({ id, sharpe: 1, ret: 0.1, maxDD: 0.2, trades: 40, weeksUp: 0.5, worstWeek: -0.05, early: 1, ...o });
  const scores = [s('base', {}), s('a', { sharpe: 1.6 }), s('b', { sharpe: 1.1, maxDD: 0.1 }), s('c', { sharpe: 0.9, weeksUp: 0.7, worstWeek: -0.02 }), s('d', { sharpe: 3, trades: 4 }), s('e', { sharpe: 1.9, early: 0.2 })];
  const vs = ['a', 'b', 'c', 'd', 'e'].map(v);
  it('each goal picks its own winners, and too few trades are never a winner', () => {
    expect(rankVariants(vs, scores, 'sharpe').ranked.map((r) => r.variant.id)).toEqual(['a', 'e']);
    expect(rankVariants(vs, scores, 'drawdown').ranked.map((r) => r.variant.id)).toEqual(['b']);
    expect(rankVariants(vs, scores, 'steady').ranked.map((r) => r.variant.id)).toEqual(['c']);
  });
  it('a change that only worked on the latest stretch is marked and listed after the consistent ones', () => {
    const r = rankVariants(vs, scores, 'sharpe').ranked;
    expect(r[0].consistent).toBe(true);
    expect(r[1].consistent).toBe(false);
  });
});

describe('the diagnosis in words', () => {
  const diag = (o: Partial<Diag>): Diag => ({ trades: 100, exits: [{ reason: 'flip', n: 100, avgR: 0.1 }], long: { n: 50, avgR: 0.1, win: 0.5 }, short: { n: 50, avgR: 0.1, win: 0.5 }, heldWin: 10, heldLoss: 10, coins: [{ coin: 'BTC', sharpe: 1, trades: 100 }], costShare: 0.2, tradesPerMonth: 8, exposure: 0.4, ...o });
  const titles = (d: Diag | null, p?: Periods | null, f = flow()) => advise(d, p, f).map((a) => a.title).join(' | ');
  it('says what ended the trades', () => {
    expect(titles(diag({ exits: [{ reason: 'stop', n: 70, avgR: -1 }, { reason: 'trail', n: 30, avgR: 2.5 }] }))).toMatch(/70 % of trades end at the stop/);
    expect(titles(diag({ exits: [{ reason: 'time', n: 60, avgR: 0.4 }, { reason: 'stop', n: 40, avgR: -1 }] }))).toMatch(/run out of time while ahead/);
    expect(titles(diag({ exits: [{ reason: 'time', n: 60, avgR: -0.1 }, { reason: 'stop', n: 40, avgR: -1 }] }))).toMatch(/go nowhere/);
  });
  it('notices a losing side, held losers, costs, a losing coin and too few trades', () => {
    expect(titles(diag({ short: { n: 50, avgR: -0.3, win: 0.3 } }))).toMatch(/short trades lose/);
    expect(titles(diag({ heldWin: 5, heldLoss: 20 }))).toMatch(/Losers are held longer/);
    expect(titles(diag({ costShare: 0.7 }))).toMatch(/eat 70 % of the profit/);
    expect(titles(diag({ costShare: Infinity }))).toMatch(/eat all the profit/);
    expect(titles(diag({ coins: [{ coin: 'BTC', sharpe: 1, trades: 50 }, { coin: 'DOGE', sharpe: -0.8, trades: 50 }] }))).toMatch(/loses on DOGE/);
    expect(titles(diag({ tradesPerMonth: 1 }))).toMatch(/Fewer than two trades a month/);
    expect(titles(diag({ trades: 4 }))).toMatch(/Too few trades/);
    expect(titles(null)).toMatch(/Too few trades/);
    expect(titles(diag({}))).toMatch(/Nothing stands out/);
  });
  it('describes how regular the unseen result was', () => {
    const p = (rets: number[]): Periods => ({ unit: 'month', list: rets.map((ret, i) => ({ t: i, ret })), up: rets.filter((x) => x > 0).length / rets.length, worst: Math.min(...rets), avg: rets.reduce((a, b) => a + b, 0) / rets.length });
    expect(titles(diag({}), p([0.02, 0.03, -0.01, 0.04, 0.02]))).toMatch(/80 % of months made money/);
    expect(titles(diag({}), p([0.2, -0.03, -0.01, -0.04, -0.02]))).toMatch(/Only 20 % of months/);
  });
  it('counts the versions tried', () => {
    expect(triesWords(1)).toMatch(/first version/);
    expect(triesWords(4)).toMatch(/version 4/);
  });
});
