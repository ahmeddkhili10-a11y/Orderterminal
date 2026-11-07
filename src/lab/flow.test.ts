import { describe, expect, it } from 'vitest';
import { backtest } from './backtest';
import { blockTone, buildSpec, checkFlow, FLOW_DEFAULT, FORECASTS, migrateFlow, MODELS, PORTFOLIOS, RISKS, STRATEGIES, STYLES, verdictWords, type Flow } from './flow';
import { ctxOf, FILTER_MAP, SIGNAL_MAP, type Market } from './library';
import { rngOf } from './ml';
import { evaluate } from './research';

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

function market(coin: string, n: number, tfH: number, seed: number): Market {
  const rnd = rngOf(seed);
  let p = 100;
  let h = 1;
  let z = 0;
  const t0 = Date.UTC(2022, 0, 1);
  return {
    coin,
    tfH,
    funding: null,
    bars: Array.from({ length: n }, (_, i) => {
      h = 0.05 + 0.1 * z * z + 0.85 * h;
      z = gauss(rnd);
      const o = p;
      p = o * Math.exp(0.0001 + 0.01 * Math.sqrt(h * tfH) * z);
      return { time: t0 + i * tfH * 3_600_000, open: o, high: Math.max(o, p) * 1.003, low: Math.min(o, p) * 0.997, close: p, volume: 100 + 50 * rnd() };
    }),
  };
}

describe('the bot builder', () => {
  it('every block names a real rule, filter or setting', () => {
    for (const s of STRATEGIES) expect(SIGNAL_MAP[s.signal], s.id).toBeTruthy();
    for (const m of MODELS) expect(FILTER_MAP[(typeof m.filter === 'function' ? m.filter(STYLES[0]) : m.filter).id], m.id).toBeTruthy();
    for (const f of FORECASTS) expect(FILTER_MAP[f.filter.id], f.id).toBeTruthy();
    // every rule in the Lab's library is offered as a strategy, and every filter as a market model or forecast
    for (const id of Object.keys(SIGNAL_MAP)) expect(STRATEGIES.some((s) => s.signal === id), `strategy ${id}`).toBe(true);
    const used = new Set([...MODELS.map((m) => (typeof m.filter === 'function' ? m.filter(STYLES[0]) : m.filter).id), ...FORECASTS.map((f) => f.filter.id)]);
    for (const id of Object.keys(FILTER_MAP)) expect(used.has(id), `filter ${id}`).toBe(true);
    // every option explains itself
    for (const x of [...STRATEGIES, ...MODELS, ...FORECASTS, ...RISKS]) expect(x.plain.length, x.id).toBeGreaterThan(20);
  });

  it('builds a valid strategy for every style × strategy, and it runs', () => {
    for (const style of STYLES) {
      const m = market('X', style.tfH >= 24 ? 900 : 1500, style.tfH, 3);
      for (const s of STRATEGIES) {
        if (SIGNAL_MAP[s.signal].intraday && style.tfH >= 24) continue;
        if (SIGNAL_MAP[s.signal].needsFunding) continue;
        const { spec } = buildSpec({ ...FLOW_DEFAULT, style: style.id, strategies: [s.id], models: [], forecasts: [] });
        expect(spec.exit.maxBars, `${style.id}/${s.id}`).toBeGreaterThanOrEqual(1);
        const c = ctxOf(m, Math.floor(m.bars.length * 0.7));
        const r = backtest(c, spec, 50, m.bars.length);
        expect(r.rets.length).toBe(m.bars.length - 50);
        expect(r.rets.every(Number.isFinite), `${style.id}/${s.id}`).toBe(true);
      }
    }
  });

  it('every market model, forecast and risk choice computes', () => {
    const m = market('X', 1500, 1, 4);
    for (const mo of MODELS)
      for (const fc of FORECASTS.filter((f) => f.id !== 'nn' && f.id !== 'forest'))
        for (const r of RISKS.filter((x) => !x.hedge && x.id !== 'kelly')) {
          const { spec } = buildSpec({ ...FLOW_DEFAULT, style: 'intraday', strategies: ['tsmom'], models: [mo.id], forecasts: [fc.id], risks: [r.id] });
          const c = ctxOf(m, 1050);
          const res = backtest(c, spec, 50, 1500);
          expect(res.rets.every(Number.isFinite), `${mo.id}/${fc.id}/${r.id}`).toBe(true);
        }
  });

  it('the hedge brings bitcoin along; the style sets the candles and the history', () => {
    const b = buildSpec({ ...FLOW_DEFAULT, risks: ['hedged'], coins: 'ETH SOL' });
    expect(b.coins[0]).toBe('BTC');
    expect(b.spec.hedge).toBe('btc');
    const hold = buildSpec({ ...FLOW_DEFAULT, style: 'hold' });
    expect(hold.timeframe).toBe('1d');
    expect(hold.spec.exit.maxBars).toBe(365);
    const scalp = buildSpec({ ...FLOW_DEFAULT, style: 'scalp' });
    expect(scalp.timeframe).toBe('1h');
    expect(scalp.spec.exit.maxBars).toBe(6);
    expect(scalp.summary.length).toBeGreaterThan(4);
  });

  it('the AI trade filter is trained in sample and kept only if it helps out of sample', () => {
    const f: Flow = { ...FLOW_DEFAULT, style: 'intraday', strategies: ['rsi2'], models: [], forecasts: [], decider: 'forest', risks: [], coins: 'X Y' };
    const { spec } = buildSpec(f);
    expect(spec.autoMeta).toBe('forest');
    const r = evaluate([market('X', 3000, 1, 5), market('Y', 3000, 1, 6)], spec);
    expect(r.meta).toBeTruthy();
    expect(r.spec.autoMeta).toBeUndefined();
    if (r.meta!.used) expect(r.spec.meta?.model).toBeTruthy();
    else expect(r.spec.meta).toBeUndefined();
    expect(r.bh.bars).toBeGreaterThan(0);
    expect(r.perCoin).toHaveLength(2);
  }, 60_000);

  it('every pick can be stacked: several strategies, filters, opinions, two sizings, a decision maker, a coin split', () => {
    const f: Flow = { ...FLOW_DEFAULT, style: 'swing', strategies: ['tsmom', 'rsi2', 'nn'], combine: 'majority', models: ['trend', 'garch-calm', 'hurst-trend'], forecasts: ['kalman', 'nn'], decider: 'both', risks: ['voltarget', 'var', 'garchstop'], portfolio: 'invvol', coins: 'BTC ETH' };
    const { spec, summary } = buildSpec(f);
    expect(spec.signal.id).toBe('tsmom');
    expect(spec.also!.map((r) => r.id)).toEqual(['rsi2', 'nn']);
    expect(spec.combine).toBe('majority');
    // two "agree" second opinions with different models are both kept
    expect(spec.filters.filter((x) => x.id === 'agree')).toHaveLength(2);
    expect(spec.sizing!.mode).toBe('vol');
    expect(spec.sizing2!.mode).toBe('var');
    expect(spec.exit.stopVol).toBeGreaterThan(0);
    expect(spec.autoMeta).toBe('both');
    expect(spec.weights).toBe('invvol');
    expect(summary.join(' ')).toMatch(/majority vote/);
    const m = market('X', 1500, 4, 9);
    const r = backtest(ctxOf(m, 1050), spec, 50, 1500);
    expect(r.rets.every(Number.isFinite)).toBe(true);
    for (const p of PORTFOLIOS) expect(p.plain.length).toBeGreaterThan(20);
  });

  it('reads a saved bot from the first builder (one pick per block)', () => {
    const old = { style: 'swing', strategy: 'rsi2', model: 'trend', model2: 'garch-calm', forecast: 'meta', risk: 'steady-garch', stopWidth: 'normal', sides: 'both', takeProfit: 'trail', hold: 'normal', flip: true, coins: 'BTC' } as unknown as Flow & Record<string, unknown>;
    const f = migrateFlow(old);
    expect(f.strategies).toEqual(['rsi2']);
    expect(f.models).toEqual(['trend', 'garch-calm']);
    expect(f.decider).toBe('forest');
    expect(f.risks).toEqual(['voltarget', 'garchstop']);
    expect(buildSpec(f).spec.signal.id).toBe('rsi2');
  });

  it('says which picks clash, overlap or pair well', () => {
    const tone = (f: Partial<Flow>, a: string, b?: string) => checkFlow({ ...FLOW_DEFAULT, models: [], ...f }).find((x) => x.picks.includes(a) && (!b || x.picks.includes(b)))?.tone;
    // a trend rule and a dip rule: they pair when all must agree, they fight when any one can trade
    expect(tone({ strategies: ['tsmom', 'rsi2'], combine: 'all' }, 'tsmom', 'rsi2')).toBe('pair');
    expect(tone({ strategies: ['tsmom', 'rsi2'], combine: 'any' }, 'tsmom', 'rsi2')).toBe('clash');
    // a breakout and a dip rule fight; two trend rules overlap; two AI models pair
    expect(tone({ strategies: ['donchian', 'zrev'] }, 'donchian', 'zrev')).toBe('clash');
    expect(tone({ strategies: ['tsmom', 'mac'] }, 'tsmom', 'mac')).toBe('overlap');
    expect(tone({ strategies: ['nn', 'rf'] }, 'nn', 'rf')).toBe('pair');
    // a trend rule only allowed in a range clashes; a dip rule with the big trend pairs; a breakout in calm clashes
    expect(tone({ strategies: ['tsmom'], models: ['adx-range'] }, 'tsmom', 'adx-range')).toBe('clash');
    expect(tone({ strategies: ['rsi2'], models: ['trend'] }, 'rsi2', 'trend')).toBe('pair');
    expect(tone({ strategies: ['donchian'], models: ['garch-calm'] }, 'donchian', 'garch-calm')).toBe('clash');
    // opposite filters never trade; two calm filters overlap
    expect(tone({ models: ['garch-calm', 'garch-storm'] }, 'garch-calm', 'garch-storm')).toBe('clash');
    expect(tone({ models: ['garch-calm', 'hmm-calm'] }, 'garch-calm', 'hmm-calm')).toBe('overlap');
    // a second opinion from the same model adds nothing; the forest and the network paired
    expect(tone({ strategies: ['nn'], forecasts: ['nn'] }, 'nn')).toBe('overlap');
    expect(tone({ decider: 'both' }, 'both')).toBe('pair');
    // two sizing rules combine (the smaller wins); three is one too many
    expect(tone({ risks: ['voltarget', 'var'] }, 'voltarget', 'var')).toBe('pair');
    expect(tone({ risks: ['voltarget', 'var', 'kelly'] }, 'kelly')).toBe('clash');
    // a day has no hours
    expect(tone({ style: 'position', models: ['us'] }, 'us')).toBe('clash');
    const fs = checkFlow({ ...FLOW_DEFAULT, strategies: ['tsmom'], models: ['adx-range'] });
    expect(blockTone(fs, 'model')).toBe('clash');
    expect(blockTone(fs, 'deploy')).toBeNull();
  });

  it('says what the result means', () => {
    expect(verdictWords(1.5, 3, 80).tone).toBe('good');
    expect(verdictWords(0.7, 1.7, 80).tone).toBe('ok');
    expect(verdictWords(-0.5, -1, 80).tone).toBe('bad');
    expect(verdictWords(2, 3, 4).tone).toBe('bad');
  });
});
