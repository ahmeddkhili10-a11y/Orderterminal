// Which strategies a small account can trade on Hyperliquid ($10 smallest order), with the
// same rules the swarm sizes by: about 1 % risk a trade, a trade under $10 rounded up to the
// minimum only while its loss at the stop stays within 2 % of the account.
import { describe, expect, it } from 'vitest';
import { accountFit, fitWords, stopQuantiles } from './accountFit';

const trades = (stops: number[]) => stops.map((d) => ({ entry: 100, stop0: 100 * (1 - d) }));
const even = (lo: number, hi: number, n = 101) => Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));

describe('fitting a small account', () => {
  it('keeps the stop distances at every 5 % of the trades', () => {
    const q = stopQuantiles(trades(even(0.01, 0.05)))!;
    expect(q).toHaveLength(21);
    expect(q[0]).toBeCloseTo(0.01, 6);
    expect(q[10]).toBeCloseTo(0.03, 6);
    expect(q[20]).toBeCloseTo(0.05, 6);
    expect(stopQuantiles([])).toBeUndefined();
  });

  it('a tight-stopped strategy fits R1,000 (about $55); a wide-stopped one does not', () => {
    // the widest stop $10.20 can carry within 2 % of $55: 0.02 × 55 / 10.2 ≈ 10.8 %
    const tight = accountFit(stopQuantiles(trades(even(0.004, 0.03))), 55, 1000)!;
    expect(tight.fits).toBe(true);
    expect(tight.share).toBe(1);
    const wide = accountFit(stopQuantiles(trades(even(0.06, 0.2))), 55, 1000)!;
    expect(wide.fits).toBe(false);
    expect(wide.share).toBeGreaterThan(0.3);
    expect(wide.share).toBeLessThan(0.45);
    // nine in ten of its trades need stops up to 18.6 % → 0.186 × 10.2 / 0.02 ≈ $95
    expect(wide.needUsd).toBeGreaterThanOrEqual(94);
    expect(wide.needUsd).toBeLessThanOrEqual(96);
    expect(fitWords(wide)).toMatch(/too wide for your R1,000 \(\$55\) account: only \d+ % of its trades can be placed .* needs about R1,800/);
    // on R500 even moderate stops stop fitting
    const mid = stopQuantiles(trades(even(0.02, 0.08)));
    expect(accountFit(mid, 55)!.fits).toBe(true);
    expect(accountFit(mid, 27)!.fits).toBe(false);
  });

  it('says when the $10 minimum makes a trade risk more than planned', () => {
    const f = accountFit(stopQuantiles(trades(even(0.04, 0.06))), 55)!;
    // planned: 1 % of $55 = $0.55 at a 5 % stop → an $11 order; fine
    expect(f.risk).toBeCloseTo(0.01, 6);
    const g = accountFit(stopQuantiles(trades(even(0.06, 0.1))), 55)!;
    // planned $0.55 at an 8 % stop → a $6.88 order, rounded up to $10.20 → $0.82 at risk, 1.5 %
    expect(g.risk).toBeCloseTo((10.2 * 0.08) / 55, 6);
    expect(fitWords(g)).toMatch(/fits your \$55 account: 100 % .* risk 1\.5 % of the account, not 1 %/);
  });

  it('knows nothing until the stops are known', () => {
    expect(accountFit(undefined, 55)).toBeNull();
    expect(accountFit(null, 55)).toBeNull();
    expect(fitWords(null)).toBeNull();
  });
});
