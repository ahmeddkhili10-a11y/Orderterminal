import { describe, expect, it } from 'vitest';
import { rngOf } from './ml';
import { capm, efficientFrontier, kellyGrowth, kellyPortfolio, meanCov, portVar, projectSimplex } from './quant';

const gauss = (rnd: () => number) => Math.sqrt(-2 * Math.log(Math.max(1e-12, rnd()))) * Math.cos(2 * Math.PI * rnd());

describe('CAPM, the efficient frontier and Kelly', () => {
  it('CAPM recovers beta and alpha', () => {
    const rnd = rngOf(1);
    const m = Array.from({ length: 3000 }, () => 0.0005 + 0.02 * gauss(rnd));
    const a = m.map((x) => 0.001 + 1.4 * x + 0.01 * gauss(rnd));
    const c = capm(a, m)!;
    expect(c.beta).toBeGreaterThan(1.35);
    expect(c.beta).toBeLessThan(1.45);
    expect(c.alpha).toBeCloseTo(0.001, 3);
    expect(c.tAlpha).toBeGreaterThan(3);
    expect(c.r2).toBeGreaterThan(0.85);
  });

  it('projects onto the simplex', () => {
    const p = projectSimplex([0.5, 2, -1]);
    expect(p.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 12);
    expect(Math.min(...p)).toBeGreaterThanOrEqual(0);
    expect(p[1]).toBeCloseTo(1, 12);
  });

  it('the long-only frontier: fully invested, riskier as it pays more; the tangency has the best Sharpe; min variance matches the analytic answer', () => {
    // two uncorrelated assets: the minimum-variance weights are inversely proportional to variance
    const mu = [0.1, 0.2];
    const cov = [
      [0.04, 0],
      [0, 0.16],
    ];
    const ef = efficientFrontier(mu, cov, 0.02);
    expect(ef.minVar.w[0]).toBeCloseTo(0.8, 3);
    for (const p of ef.frontier) {
      expect(p.w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
      expect(Math.min(...p.w)).toBeGreaterThanOrEqual(-1e-12);
    }
    for (let i = 1; i < ef.frontier.length; i++) expect(ef.frontier[i].vol).toBeGreaterThanOrEqual(ef.frontier[i - 1].vol - 1e-9);
    expect(Math.max(...ef.frontier.map((p) => p.sharpe))).toBeCloseTo(ef.tangency.sharpe, 12);
    // analytic tangency for uncorrelated assets: w ∝ (μ − rf)/σ²
    const raw = [(0.1 - 0.02) / 0.04, (0.2 - 0.02) / 0.16];
    const want = raw[0] / (raw[0] + raw[1]);
    expect(Math.abs(ef.tangency.w[0] - want)).toBeLessThan(0.05);
  });

  it('the Kelly portfolio is Σ⁻¹(μ − rf) when the cap does not bind, and its growth peaks at full Kelly', () => {
    const mu = [0.12, 0.08];
    const cov = [
      [0.09, 0.02],
      [0.02, 0.04],
    ];
    const k = kellyPortfolio(mu, cov, 0, 10);
    // Σ⁻¹μ for this 2×2
    const det = 0.09 * 0.04 - 0.02 * 0.02;
    const want = [(0.04 * 0.12 - 0.02 * 0.08) / det, (0.09 * 0.08 - 0.02 * 0.12) / det];
    expect(k.w[0]).toBeCloseTo(want[0], 2);
    expect(k.w[1]).toBeCloseTo(want[1], 2);
    const capped = kellyPortfolio(mu, cov, 0, 1);
    expect(capped.w.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1 + 1e-9);
    // single asset: growth is highest at f* = m / v and zero again at 2f*
    const m = 0.1;
    const v = 0.25;
    expect(kellyGrowth(m / v, m, v)).toBeGreaterThan(kellyGrowth(0.8 * (m / v), m, v));
    expect(kellyGrowth(m / v, m, v)).toBeGreaterThan(kellyGrowth(1.2 * (m / v), m, v));
    expect(kellyGrowth((2 * m) / v, m, v)).toBeCloseTo(0, 12);
  });

  it('mean and covariance of return series', () => {
    const { mu, cov } = meanCov([
      [1, 2, 3, 4],
      [2, 4, 6, 8],
    ]);
    expect(mu).toEqual([2.5, 5]);
    expect(cov[0][1]).toBeCloseTo(cov[0][0] * 2, 12);
    expect(portVar([0.5, 0.5], cov)).toBeGreaterThan(0);
  });
});
