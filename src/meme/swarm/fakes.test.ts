import { describe, expect, it } from 'vitest';
import { applyTrade } from '../token';
import { sentinel } from './agents';
import { FakeFilter, imageKey, linkKey, xHandle } from './fakes';
import { coin, T0, trade } from './fixtures';

const lookups = (toks: ReturnType<typeof coin>[]) => [(m: string) => toks.find((t) => t.mint === m)?.symbol ?? '', (m: string) => toks.find((t) => t.mint === m)?.mcapSol ?? 0] as const;

describe('Fake coins', () => {
  it('a fresh coin with an established ticker is an impersonator; the real (old) coin is not', () => {
    const f = new FakeFilter();
    const fakeWif = coin({ symbol: 'WIF', name: 'dogwifhat' });
    f.see(fakeWif);
    expect(f.check(fakeWif, T0 + 60_000, ...lookups([fakeWif]))).toEqual(['impersonates $WIF — a new coin with an established coin\'s ticker']);
    const realWif = { ...coin({ symbol: 'WIF', name: 'dogwifhat' }, T0 - 400 * 86_400_000), source: 'dex' as const, migrated: true };
    expect(f.check(realWif, T0, ...lookups([realWif])).filter((r) => /impersonates/.test(r))).toEqual([]);
  });

  it('the same ticker or name launched again is a copy; the first one is not', () => {
    const f = new FakeFilter();
    const first = coin({ symbol: 'GHOST', name: 'Ghost Dog' }, T0);
    const copy = coin({ symbol: 'ghost', name: 'Ghost Dog 2' }, T0 + 5 * 60_000);
    const sameName = coin({ symbol: 'GDOG', name: 'Ghost-Dog' }, T0 + 9 * 60_000);
    for (const t of [first, copy, sameName]) f.see(t);
    const L = lookups([first, copy, sameName]);
    expect(f.check(first, T0 + 600_000, ...L)).toEqual([]);
    expect(f.check(copy, T0 + 600_000, ...L)).toEqual(['duplicate of $GHOST launched 5 min earlier — a copy']);
    expect(f.check(sameName, T0 + 600_000, ...L)).toEqual(['same name as $GHOST launched 9 min earlier — a copy']);
    // a copy that has overtaken the first by 3× is the market's pick
    copy.mcapSol = first.mcapSol * 4;
    expect(f.check(copy, T0 + 600_000, ...L)).toEqual([]);
  });

  it('a stolen logo file, copied socials and a borrowed famous account', () => {
    const f = new FakeFilter();
    const a = coin({ symbol: 'AAA', name: 'Alpha' }, T0);
    a.image = 'https://ipfs.io/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    a.meta = { twitter: 'https://x.com/alphacoin', fetchedAt: T0 };
    const b = coin({ symbol: 'BBB', name: 'Bravo' }, T0 + 60_000);
    b.image = 'https://cf-ipfs.com/ipfs/QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco';
    b.meta = { twitter: 'https://twitter.com/AlphaCoin/', telegram: 'https://t.me/', fetchedAt: T0 };
    const c = coin({ symbol: 'CCC', name: 'Charlie' }, T0 + 120_000);
    c.meta = { twitter: 'https://x.com/elonmusk', fetchedAt: T0 };
    for (const t of [a, b, c]) f.see(t);
    const L = lookups([a, b, c]);
    expect(f.check(b, T0 + 600_000, ...L)).toEqual(['uses the same logo file as $AAA — a copy', 'its link x.com/alphacoin belongs to $AAA — socials copied']);
    expect(f.check(c, T0 + 600_000, ...L)).toEqual(['links @elonmusk as its own X account — it is not theirs']);
    expect(f.check(a, T0 + 600_000, ...L)).toEqual([]);
  });

  it('normalises links and logos; generic links say nothing', () => {
    expect(linkKey('https://www.Twitter.com/SomeCoin/?s=20')).toBe('x.com/somecoin');
    expect(linkKey('https://t.me/')).toBeNull();
    expect(linkKey('https://pump.fun')).toBeNull();
    // junk in the metadata is not a link two coins can share
    for (const junk of ['x', 'n/a', '-', 'twitter', 'https://', 'x.com']) expect(linkKey(junk)).toBeNull();
    expect(linkKey('frogcoin.xyz')).toBe('frogcoin.xyz');
    expect(xHandle('https://x.com/elonmusk/status/123')).toBeNull();
    expect(xHandle('https://x.com/elonmusk')).toBe('elonmusk');
    expect(imageKey('ipfs://QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco')).toBe('QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco');
  });

  it('the Sentinel rejects a fake whatever else it looks like', () => {
    const tok = coin({ symbol: 'BONK' });
    for (let i = 0; i < 6; i++) applyTrade(tok, trade(tok, 'buy', `W${i}`, 0.3, T0 + 10_000 + i * 2000));
    tok.safety = { checkedAt: T0, mintRevoked: true, freezeRevoked: true, top10: 0.2, top1: 0.05 };
    const v = sentinel(tok, T0 + 30_000, undefined, ['impersonates $BONK — a new coin with an established coin\'s ticker']);
    expect(v.verdict).toBe('reject');
    expect(v.reasons).toContain('impersonates $BONK — a new coin with an established coin\'s ticker');
  });
});
