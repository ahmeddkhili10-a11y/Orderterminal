// The edge finder's "fits your account" (src/lab/accountFit.ts) must say exactly what the
// swarm will do: a trade it calls placeable is sized, one it calls impossible is skipped.
import { describe, expect, it } from 'vitest';
import { accountFit, stopQuantiles } from '../../src/lab/accountFit.ts';
import { newBook, RISK_DEFAULTS, sizeTrade } from './risk.mjs';

describe('fits your account, against the swarm’s own sizing', () => {
  for (const usd of [27, 55, 60, 200])
    it(`on a $${usd} account`, () => {
      const book = newBook(usd);
      for (const stop of [0.003, 0.01, 0.02, 0.04, 0.05, 0.06, 0.08, 0.1, 0.105, 0.11, 0.15, 0.3]) {
        const f = accountFit(stopQuantiles([{ entry: 100, stop0: 100 * (1 - stop) }]), usd);
        const live = sizeTrade({ price: 100, stop: 100 * (1 - stop), side: 'buy', equity: usd, book, openNotional: 0, maxLev: 3 }, RISK_DEFAULTS);
        expect('skip' in live, `stop ${stop * 100} %`).toBe(f.share === 0);
        if (!('skip' in live)) expect(live.riskUsd / usd).toBeCloseTo(f.risk, 4);
      }
    });
});
