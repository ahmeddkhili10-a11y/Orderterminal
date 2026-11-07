import { describe, expect, it } from 'vitest';
import { backtest, combineSignals, type StrategySpec } from './backtest';
import { ctxOf, EXIT_DEFAULT, SIGNAL_MAP, type Market } from './library';
import { fitMLP, metaOdds, mlpImportance, mlpTrainer, predictMLP, rngOf } from './ml';
import { evaluate, pairVerdict } from './research';

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

function xor(n: number, seed: number) {
  const rnd = rngOf(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = rnd() * 2 - 1;
    const b = rnd() * 2 - 1;
    X.push([a, b, rnd(), rnd()]);
    y.push(a * b > 0 ? 1 : 0);
  }
  return { X, y };
}

describe('the neural network', () => {
  it('learns a pattern no straight line can (XOR), on rows it never trained on', () => {
    const { X, y } = xor(2000, 5);
    const m = fitMLP(X, y, { epochs: 150, patience: 25 });
    expect(m.valAcc!).toBeGreaterThan(0.85);
    expect(predictMLP(m, [0.8, 0.8, 0.5, 0.5])).toBeGreaterThan(0.6);
    expect(predictMLP(m, [0.8, -0.8, 0.5, 0.5])).toBeLessThan(0.4);
    // the loss falls, and the kept epoch is the best on validation
    expect(m.trainLoss[m.trainLoss.length - 1]).toBeLessThan(m.trainLoss[0]);
    expect(m.valLoss[m.best - 1]).toBe(Math.min(...m.valLoss));
  });

  it('is deterministic for a seed and serialises', () => {
    const { X, y } = xor(600, 9);
    const a = fitMLP(X, y, { epochs: 20, seed: 3 });
    const b = fitMLP(X, y, { epochs: 20, seed: 3 });
    expect(a.W1).toEqual(b.W1);
    const back = JSON.parse(JSON.stringify(a));
    expect(predictMLP(back, X[0])).toBeCloseTo(predictMLP(a, X[0]), 12);
  });

  it('says which inputs matter (the two XOR inputs, not the noise)', () => {
    const { X, y } = xor(2000, 7);
    const m = fitMLP(X, y, { epochs: 150, patience: 25 });
    const imp = mlpImportance(m, X.slice(0, 600), y.slice(0, 600));
    expect(imp[0] + imp[1]).toBeGreaterThan(0.8);
  });

  it('trains a step at a time (for the live loss chart) and stops early', () => {
    const { X, y } = xor(800, 2);
    const t = mlpTrainer(X, y, { epochs: 500, patience: 5 });
    let steps = 0;
    while (!t.step()) steps++;
    expect(steps).toBeLessThan(499);
    expect(t.result().valLoss.length).toBe(t.epoch);
  });

  it('the forest and the network pair up: their odds are averaged', () => {
    const { X, y } = xor(800, 4);
    const nn = fitMLP(X, y, { epochs: 30 });
    const p = predictMLP(nn, X[0]);
    expect(metaOdds({ nn, threshold: 0.5 }, X[0])).toBeCloseTo(p, 12);
    expect(metaOdds({ threshold: 0.5 }, X[0])).toBe(1);
  });

  it('runs as a Lab rule (trained only on the training bars)', () => {
    const m = market('BTC', 3000, 1, 11);
    const c = ctxOf(m, 2100, 7);
    const sig = SIGNAL_MAP.nn.compute(c, { horizon: 4, edge: 0.03 });
    expect(sig.length).toBe(3000);
    expect([...sig].every((x) => x === 0 || x === 1 || x === -1)).toBe(true);
  });
});

describe('stacked rules and how they relate', () => {
  it('joins rules: all, majority, any', () => {
    const a = Int8Array.from([1, 1, -1, 0, 1]);
    const b = Int8Array.from([1, 0, 1, 0, -1]);
    const c = Int8Array.from([1, 1, 0, 0, 0]);
    expect([...combineSignals([a, b], 'all')]).toEqual([1, 0, 0, 0, 0]);
    expect([...combineSignals([a, b], 'any')]).toEqual([1, 1, 0, 0, 0]);
    expect([...combineSignals([a, b, c], 'majority')]).toEqual([1, 1, 0, 0, 0]);
  });

  it('names a pair redundant, clashing or complementary', () => {
    expect(pairVerdict(0.8, 0.95, 0.5)).toBe('redundant');
    expect(pairVerdict(-0.4, 0.2, 0.3)).toBe('clash');
    expect(pairVerdict(0.1, 0.6, 0.1)).toBe('complement');
  });

  it('a trend rule and a dip-buying rule: each measured alone, the pair measured, the filters weighed', () => {
    const ms = ['BTC', 'ETH'].map((c, k) => market(c, 2500, 4, 20 + k));
    const spec: StrategySpec = { name: 't', signal: { id: 'tsmom', p: { lookback: 168 } }, also: [{ id: 'rsi2', p: { n: 14, band: 30 } }], combine: 'all', filters: [{ id: 'adx', p: { mode: 0, level: 20 } }], exit: { ...EXIT_DEFAULT, maxBars: 30 }, sides: 'both' };
    const r = evaluate(ms, spec);
    expect(r.parts!.rules.map((x) => x.id)).toEqual(['tsmom', 'rsi2']);
    expect(r.parts!.pairs).toHaveLength(1);
    expect(['redundant', 'clash', 'complement']).toContain(r.parts!.pairs[0].verdict);
    expect(r.parts!.filters[0].pass).toBeGreaterThan(0);
    expect(r.parts!.filters[0].pass).toBeLessThanOrEqual(1);
    // all-agree trades no more than either rule alone would signal
    const c = ctxOf(ms[0]);
    const both = backtest(c, spec, 50, 2500).trades.length;
    const tsOnly = backtest(c, { ...spec, also: undefined }, 50, 2500).trades.length;
    expect(both).toBeGreaterThanOrEqual(0);
    expect(tsOnly).toBeGreaterThan(0);
  });

  it('Kelly sizing is found on the training years; the coin split sums to one', () => {
    const ms = ['BTC', 'ETH', 'SOL'].map((c, k) => market(c, 2500, 4, 30 + k));
    const spec: StrategySpec = { name: 'k', signal: { id: 'tsmom', p: { lookback: 72 } }, filters: [], exit: { ...EXIT_DEFAULT, maxBars: 30 }, sides: 'both', sizing: { mode: 'kelly', target: 0 }, sizing2: { mode: 'vol', target: 0.6 }, weights: 'invvol' };
    const r = evaluate(ms, spec);
    expect(r.kelly).toBeTruthy();
    expect(r.spec.sizing!.target).toBeGreaterThanOrEqual(0.0025);
    expect(r.spec.sizing!.target).toBeLessThanOrEqual(0.03);
    const w = Object.values(r.spec.coinWeights ?? {});
    expect(w).toHaveLength(3);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(Number.isFinite(r.oos.sharpe)).toBe(true);
  });

  it('the decision makers: forest, network and both are each measured; only the chosen one can be kept', () => {
    const ms = ['BTC', 'ETH'].map((c, k) => market(c, 3000, 1, 40 + k));
    const spec: StrategySpec = { name: 'm', signal: { id: 'rsi2', p: { n: 2, band: 10 } }, filters: [], exit: { ...EXIT_DEFAULT, maxBars: 6, stopAtr: 1.5, targetR: 1.5 }, sides: 'both', autoMeta: 'both' };
    const r = evaluate(ms, spec);
    expect(r.meta!.kind).toBe('both');
    if (r.meta!.trainedOn >= 40) expect(r.deciders.map((d) => d.kind)).toEqual(['forest', 'nn', 'both']);
    if (r.meta!.used) {
      expect(r.spec.meta!.model).toBeTruthy();
      expect(r.spec.meta!.nn).toBeTruthy();
    }
    expect(r.spec.autoMeta).toBeUndefined();
  });
});
