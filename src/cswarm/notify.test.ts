import { describe, expect, it } from 'vitest';
import type { CSwarmNotify, CSwarmPosition } from '../desktop/bridge';
import { captionOf } from './notify';

const T = Date.UTC(2026, 10, 5, 12);
const pos = (over: Partial<CSwarmPosition> = {}): CSwarmPosition => ({
  id: 'p1',
  mode: 'paper',
  coin: 'BTC',
  symbol: 'BTC/USDC:USDC',
  agent: 'trend',
  agentName: 'Trend',
  owner: 'swarm',
  side: 'buy',
  setup: 'trend breakout',
  why: 'closed above the 20-hour high with the daily trend up (3/3)',
  entry: 100_000,
  qty: 0.0009,
  notional: 90,
  stop: 99_600,
  target: 100_800,
  stop0: 99_600,
  target0: 100_800,
  risk: 400,
  riskUsd: 0.36,
  riskPct: 1.2,
  lev: 3,
  openedAt: T,
  fees: 0.04,
  votes: [
    { bot: 'trend', stance: 'for', weight: 1.5, why: 'long BTC — trend breakout' },
    { bot: 'tape', stance: 'for', weight: 1, why: 'aggressive flow with it (delta 0.31)' },
    { bot: 'crowd', stance: 'abstain', weight: 0, why: 'funding neutral (11% a year)' },
  ],
  summary: 'TRADE — 4 for, 0 against (score 3.5)',
  odds: { pWin: 0.46, pLoss: 0.4, expR: 0.22, trust: 0.1 },
  mgmt: [],
  be: false,
  trailed: false,
  equityAtEntry: 30,
  potential: 0.68,
  price: 100_000,
  ...over,
});
const note = (stage: CSwarmNotify['stage'], p: CSwarmPosition): CSwarmNotify => ({ kind: 'notify', stage, mode: p.mode, position: p, candles: [], timeframe: '1h', va: null, equity: 30.6 });

describe('crypto swarm on Telegram', () => {
  it('1 — the setup: potential gain, positioning, odds and every vote', () => {
    const c = captionOf(note('setup', pos()));
    expect(c.html).toMatch(/^🔵 <b>BTC LONG — Trend \(paper\)<\/b>/);
    expect(c.html).toContain('Potential: +$0.68 (+2.00R)');
    expect(c.html).toContain('$0.36 at risk (1.20% of the account)');
    expect(c.html).toContain('<i>Positioning:</i> trend breakout — closed above the 20-hour high');
    expect(c.html).toContain('P(win) 46%, expects +0.22R');
    expect(c.html).toContain('✓ <i>Tape:</i> aggressive flow with it');
    expect(c.html).toContain('– <i>Crowd:</i> funding neutral');
  });

  it('2 — managing: where it stands and each decision', () => {
    const c = captionOf(note('manage', pos({ price: 100_460, stop: 100_000, be: true, mgmt: [{ t: T, text: 'up 1.1R — stop to break-even (100000): this trade can no longer lose' }] })));
    expect(c.html).toContain('🟡 <b>BTC LONG — Trend (paper) — managing</b>');
    expect(c.html).toContain('open +$0.41 (+1.15R)');
    expect(c.html).toContain('Stop 100,000 (was 99,600)');
    expect(c.html).toContain('• up 1.1R — stop to break-even');
  });

  it('3 — the result: green for a profit, red for a loss, with the breakdown and the verdict', () => {
    const win = captionOf(note('result', pos({ exit: 100_800, pnl: 0.68, r: 1.89, reason: 'target', closedAt: T + 3 * 3_600_000 })));
    expect(win.html).toMatch(/^🟢 <b>BTC LONG — Trend \(paper\) closed \+\$0\.68 \(\+1\.89R\)<\/b>/);
    expect(win.html).toContain('held 3.0 h');
    expect(win.html).toContain('gross +$0.72, fees $0.04, risked $0.36 · account now $30.60');
    expect(win.html).toContain('the plan worked');
    const loss = captionOf(note('result', pos({ exit: 99_600, pnl: -0.4, r: -1.1, reason: 'stop', closedAt: T + 600_000 })));
    expect(loss.html).toMatch(/^🔴 <b>BTC LONG — Trend \(paper\) closed −\$0\.40 \(−1\.10R\)<\/b>/);
    expect(loss.html).toContain('the stop did its job');
    expect(loss.title).toBe('BTC LONG lost −$0.40');
  });

  it('escapes what Telegram would read as markup', () => {
    expect(captionOf(note('setup', pos({ why: 'a <b> & c' }))).html).toContain('a &lt;b&gt; &amp; c');
  });
});
