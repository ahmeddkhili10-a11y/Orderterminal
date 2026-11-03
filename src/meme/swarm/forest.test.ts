import { describe, expect, it } from 'vitest';
import { classOf, Forest, oddsOf, PRIOR_WEIGHT, priorTree, type Sample } from './forest';
import { FEATURES } from './features';

/** Made-up coins with a known pattern: strong insider buying and high viability run; low viability dies. */
function synthetic(n: number, seed = 3): Sample[] {
  let s = seed;
  const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => {
    const x = FEATURES.map(() => r() * 100);
    const insider = x[3];
    const viability = x[2];
    const noise = r();
    const y = viability < 30 ? (noise < 0.85 ? 0 : 1) : insider > 70 ? (noise < 0.6 ? 3 : 2) : insider > 40 ? (noise < 0.7 ? 2 : 1) : noise < 0.7 ? 1 : 0;
    return { x, y };
  });
}

describe('Decision forest', () => {
  it('learns a pattern it was not told, and says how well (out of bag)', async () => {
    const f = await Forest.train(synthetic(600), undefined, 0, 0);
    expect(f.size).toBe(40);
    expect(f.stats.n).toBe(600);
    expect(f.stats.accuracy!).toBeGreaterThan(f.stats.baseline! + 0.2);
    expect(f.stats.brier!).toBeLessThan(0.6);
    // the features it split on most are the ones that matter
    const top = f.stats.importance.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]).slice(0, 2).map(([, i]) => i);
    expect(top.sort()).toEqual([2, 3]);
    const runner = FEATURES.map(() => 50);
    runner[2] = 90;
    runner[3] = 90;
    const rug = FEATURES.map(() => 50);
    rug[2] = 10;
    expect(f.predict(runner)[3]).toBeGreaterThan(0.4);
    expect(f.predict(rug)[0]).toBeGreaterThan(0.6);
  });

  it('is the same forest for the same data (seeded)', async () => {
    const a = await Forest.train(synthetic(200), undefined, 0, 0);
    const b = await Forest.train(synthetic(200), undefined, 0, 0);
    const x = FEATURES.map((_, i) => i * 5);
    expect(a.predict(x)).toEqual(b.predict(x));
  });

  it('leans on the prior until it has data, then on what it learned', async () => {
    const x = FEATURES.map(() => 50);
    x[2] = 90;
    x[3] = 90;
    const none = oddsOf(x, null);
    expect(none.trust).toBe(0);
    expect(none.probs).toEqual(priorTree(x));
    const f = await Forest.train(synthetic(600), undefined, 0, 0);
    const o = oddsOf(x, f);
    expect(o.trust).toBeCloseTo(600 / (600 + PRIOR_WEIGHT));
    expect(o.p5).toBeGreaterThan(none.p5);
    expect(o.p2).toBeCloseTo(o.probs[2] + o.probs[3]);
    expect(o.expMult).toBeGreaterThan(none.expMult);
  });

  it('labels a followed coin by how its hour went', () => {
    expect(classOf(6, 2)).toBe(3);
    expect(classOf(2.4, 1)).toBe(2);
    expect(classOf(1.3, 0.15)).toBe(0);
    expect(classOf(1.3, 0.9)).toBe(1);
    expect(classOf(1.3, 0.9, true)).toBe(0);
  });
});
