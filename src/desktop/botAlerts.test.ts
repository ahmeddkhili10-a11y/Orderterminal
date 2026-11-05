import { describe, expect, it } from 'vitest';
import { botAlert } from './botAlerts';

const bot = { name: 'BTC order flow', mode: 'live' as const, exchangeId: 'hyperliquid' };

describe('order-flow bot alerts', () => {
  it('sends entries, safe trades, exits and stops; keeps watching and let-go lines in the log', () => {
    const entry = botAlert({ kind: 'story', text: '🟢 Long BTC at 100,000\nStop 99,500 · target 101,000', data: { story: 'entry' } }, bot)!;
    expect(entry).toMatchObject({ title: '🟢 Long BTC at 100,000', tone: 'buy' });
    expect(entry.html).toContain('<b>🟢 Long BTC at 100,000</b>');
    expect(entry.html).toContain('BTC order flow · hyperliquid · LIVE');
    expect(botAlert({ kind: 'story', text: 'Out with a loss', data: { story: 'exit', outcome: 'loss' } }, bot)?.tone).toBe('sell');
    expect(botAlert({ kind: 'story', text: 'Safe: stop at entry', data: { story: 'manage' } }, bot)?.tone).toBe('info');
    expect(botAlert({ kind: 'story', text: 'Watching a long', data: { story: 'watch' } }, bot)).toBeNull();
    expect(botAlert({ kind: 'story', text: 'Let it go', data: { story: 'pass' } }, bot)).toBeNull();
    expect(botAlert({ kind: 'info', text: 'tick' }, bot)).toBeNull();
  });

  it('sends failures, escaped for Telegram', () => {
    const a = botAlert({ kind: 'error', text: 'order refused: <margin>' }, { ...bot, mode: 'paper' })!;
    expect(a.html).toContain('&lt;margin&gt;');
    expect(a.html).toContain('paper');
  });
});
