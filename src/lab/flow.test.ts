import { describe, expect, it } from 'vitest';
import { backtest } from './backtest';
import { buildSpec, FLOW_DEFAULT, FORECASTS, MODELS, RISKS, STRATEGIES, STYLES, verdictWords, type Flow } from './flow';
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
    for (const m of MODELS) if (m.filter) expect(FILTER_MAP[(typeof m.filter === 'function' ? m.filter(STYLES[0]) : m.filter).id], m.id).toBeTruthy();
    for (const f of FORECASTS) if (f.filter) expect(FILTER_MAP[f.filter.id], f.id).toBeTruthy();
    // every option explains itself
    for (const x of [...STRATEGIES, ...MODELS, ...FORECASTS, ...RISKS]) expect(x.plain.length, x.id).toBeGreaterThan(20);
  });

  it('builds a valid strategy for every style × strategy, and it runs', () => {
    for (const style of STYLES) {
      const m = market('X', style.tfH >= 24 ? 900 : 1500, style.tfH, 3);
      for (const s of STRATEGIES) {
        if (SIGNAL_MAP[s.signal].intraday && style.tfH >= 24) continue;
        if (SIGNAL_MAP[s.signal].needsFunding) continue;
        const { spec } = buildSpec({ ...FLOW_DEFAULT, style: style.id, strategy: s.id, model: 'none', forecast: 'none' });
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
      for (const fc of FORECASTS.filter((f) => !f.autoMeta))
        for (const r of RISKS.filter((x) => !x.hedge)) {
          const { spec } = buildSpec({ ...FLOW_DEFAULT, style: 'intraday', strategy: 'tsmom', model: mo.id, forecast: fc.id, risk: r.id });
          const c = ctxOf(m, 1050);
          const res = backtest(c, spec, 50, 1500);
          expect(res.rets.every(Number.isFinite), `${mo.id}/${fc.id}/${r.id}`).toBe(true);
        }
  });

  it('the hedge brings bitcoin along; the style sets the candles and the history', () => {
    const b = buildSpec({ ...FLOW_DEFAULT, risk: 'hedged', coins: 'ETH SOL' });
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
    const f: Flow = { ...FLOW_DEFAULT, style: 'intraday', strategy: 'rsi2', model: 'none', forecast: 'meta', risk: 'fixed', coins: 'X Y' };
    const { spec } = buildSpec(f);
    expect(spec.autoMeta).toBe(true);
    const r = evaluate([market('X', 3000, 1, 5), market('Y', 3000, 1, 6)], spec);
    expect(r.meta).toBeTruthy();
    expect(r.spec.autoMeta).toBeUndefined();
    if (r.meta!.used) expect(r.spec.meta?.model).toBeTruthy();
    else expect(r.spec.meta).toBeUndefined();
    expect(r.bh.bars).toBeGreaterThan(0);
    expect(r.perCoin).toHaveLength(2);
  }, 60_000);

  it('says what the result means', () => {
    expect(verdictWords(1.5, 3, 80).tone).toBe('good');
    expect(verdictWords(0.7, 1.7, 80).tone).toBe('ok');
    expect(verdictWords(-0.5, -1, 80).tone).toBe('bad');
    expect(verdictWords(2, 3, 4).tone).toBe('bad');
  });
});
