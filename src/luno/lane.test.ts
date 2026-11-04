import { describe, expect, it } from 'vitest';
import type { AmtParams, CcxtMarket } from '../desktop/bridge';
import { fmtZar, isLaneBot, LANE_PREFIX, laneAlert, laneBot, LUNO_PAPER_FEE_BPS, shareFits, shareZar, zarPairs } from './lane';

const mk = (symbol: string, extra: Partial<CcxtMarket> = {}): CcxtMarket => {
  const [base, quote] = symbol.split('/');
  return { symbol, base, quote, type: 'spot', contract: false, ...extra };
};
const trend = { style: 'trend', sizing: 'balance', accountUsd: 30, feeBps: 10, slippageBps: 0, capitalShare: 1, trendShort: false } as unknown as AmtParams;

describe('Luno lane', () => {
  it('lists rand spot pairs only, the big ones first', () => {
    const out = zarPairs([mk('LTC/ZAR'), mk('BTC/EUR'), mk('ETH/ZAR'), mk('BTC/ZAR'), mk('BTC/ZAR:ZAR', { contract: true, type: 'swap' }), mk('AAVE/ZAR')]);
    expect(out.map((m) => m.symbol)).toEqual(['BTC/ZAR', 'ETH/ZAR', 'AAVE/ZAR', 'LTC/ZAR']);
  });

  it('splits the bank and the cash evenly across the pairs', () => {
    const cfg = { secretId: 'k1', pairs: ['BTC/ZAR', 'ETH/ZAR'], bankZar: 500, mode: 'live' as const };
    expect(shareZar(cfg)).toBe(250);
    const b = laneBot(trend, 'ETH/ZAR', cfg, 'old');
    expect(b).toMatchObject({ id: 'old', name: `${LANE_PREFIX}ETH/ZAR`, mode: 'live', exchangeId: 'luno', symbol: 'ETH/ZAR', secretId: 'k1' });
    expect(b.params).toMatchObject({ style: 'trend', accountUsd: 250, capitalShare: 0.5, feeBps: LUNO_PAPER_FEE_BPS, trendShort: false });
    expect(isLaneBot({ ...b, params: b.params })).toBe(true);
    expect(isLaneBot({ ...b, name: 'My trend bot' })).toBe(false);
    expect(isLaneBot({ ...b, exchangeId: 'binance' })).toBe(false);
  });

  it('flags a share too small for the market’s smallest order', () => {
    expect(shareFits(250, 60)).toBe(true);
    expect(shareFits(125, 60)).toBe(false);
    expect(shareFits(125, null)).toBe(true);
    expect(shareFits(0, null)).toBe(false);
  });

  it('alerts on trades and failures, not on the daily notes', () => {
    expect(laneAlert({ kind: 'trade', text: 'BUY 0.0001 BTC ≈ R190.00 @ 1900000' }, 'BTC/ZAR', 'live')).toEqual({ title: 'Luno · BTC/ZAR · bought (LIVE)', text: 'BUY 0.0001 BTC ≈ R190.00 @ 1900000', tone: 'buy' });
    expect(laneAlert({ kind: 'trade', text: 'SELL 1 XRP ≈ R40.00' }, 'XRP/ZAR', 'paper')?.tone).toBe('sell');
    expect(laneAlert({ kind: 'error', text: 'buy not placed' }, 'BTC/ZAR', 'live')?.tone).toBe('warn');
    expect(laneAlert({ kind: 'info', text: 'Daily check' }, 'BTC/ZAR', 'live')).toBeNull();
  });

  it('writes rands the South African way', () => {
    expect(fmtZar(1234.5)).toMatch(/^R1.234,50$|^R1 234,50$|^R1,234\.50$/);
    expect(fmtZar(null)).toBe('—');
  });
});
