import { describe, expect, it } from 'vitest';
import { addressMessage, proofMessage, verifiedMessage } from './phone';

const ADDR = 'SwarmWa11et111111111111111111111111111111111';

describe('the swarm wallet on the phone', () => {
  it('sends the address alone in a code block (one tap copies it in Telegram)', () => {
    const m = addressMessage(ADDR);
    expect(m).toContain(`<code>${ADDR}</code>`);
    expect(m.match(/<code>/g)).toHaveLength(1);
    expect(m).toMatch(/Solana network only/);
  });

  it('gives the exact amount and address for the phone verification, and warns off exchanges', () => {
    const m = proofMessage({ sol: '0.001372', address: ADDR, until: Date.UTC(2026, 10, 25, 12, 30) });
    expect(m).toContain(`<code>${ADDR}</code>`);
    expect(m).toContain('<code>0.001372</code> SOL');
    expect(m).toMatch(/not from Luno/);
  });

  it('reports the result: verified, refused or expired', () => {
    expect(verifiedMessage({ address: ADDR })).toMatchObject({ ok: true, title: 'Phantom verified' });
    expect(verifiedMessage({ address: ADDR }).html).toContain(`<code>${ADDR}</code>`);
    expect(verifiedMessage({ refused: 'an exchange' })).toMatchObject({ ok: false, text: 'an exchange' });
    expect(verifiedMessage({ expired: true }).text).toMatch(/30 minutes/);
  });
});
