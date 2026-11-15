// The commercial edition's licences: Gumroad's licence API, seats, refunds, offline grace.
import { describe, expect, it, vi } from 'vitest';
import { Licenses, maskKey, OFFLINE_GRACE, RECHECK_EVERY, refusalOf, tidyKey, VERIFY_URL } from './license.mjs';
import { ledgerMatches } from '../src/shared/ledger.ts';
import { termsText } from '../src/shared/terms.ts';
import { editionDefines } from '../scripts/edition.mjs';

const KEY = 'A1B2C3D4-E5F60718-293A4B5C-6D7E8F90';
const DAY = 86_400_000;

/** a fake Gumroad: keys it knows, how many times each has been activated, and what to answer */
function gumroad(o = {}) {
  const uses = new Map();
  const calls = [];
  const state = { down: false, purchase: {}, ...o };
  const fetch = vi.fn(async (url, init) => {
    const q = new URLSearchParams(init.body);
    calls.push({ url, method: init.method, body: Object.fromEntries(q) });
    if (state.down) throw new Error('getaddrinfo ENOTFOUND api.gumroad.com');
    const key = q.get('license_key');
    if (q.get('product_id') !== 'prod_123' || key !== KEY) return { ok: false, status: 404, json: async () => ({ success: false, message: 'That license does not exist for the provided product.' }) };
    if (url.endsWith('decrement_uses_count')) {
      uses.set(key, Math.max(0, (uses.get(key) ?? 0) - 1));
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    if (q.get('increment_uses_count') === 'true') uses.set(key, (uses.get(key) ?? 0) + 1);
    return { ok: true, status: 200, json: async () => ({ success: true, uses: uses.get(key) ?? 0, purchase: { email: 'buyer@example.com', refunded: false, chargebacked: false, ...state.purchase } }) };
  });
  return { fetch, calls, uses, state };
}
const store = () => {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v), m };
};

describe('licences', () => {
  it('no product configured: no licence check at all', async () => {
    const L = new Licenses({ productId: '', seats: 3, store: store(), fetch: vi.fn() });
    expect(L.required).toBe(false);
    expect(L.state()).toEqual({ required: false, ok: true });
    expect(await L.activate('anything')).toEqual({ required: false, ok: true });
  });

  it('activates a key from the receipt (spaces and case do not matter) and keeps only what it needs', async () => {
    const g = gumroad();
    const s = store();
    let now = 1_000 * DAY;
    const L = new Licenses({ productId: 'prod_123', seats: 3, store: s, fetch: g.fetch, now: () => now });
    expect(L.state()).toMatchObject({ required: true, ok: false, reason: 'none' });
    const st = await L.activate(`  ${KEY.toLowerCase()} `);
    expect(st).toMatchObject({ required: true, ok: true, email: 'buyer@example.com', uses: 1 });
    expect(st.key).toBe('A1B2C3D4…8F90');
    expect(JSON.stringify(st)).not.toContain(KEY);
    // it asked Gumroad's licence API, counting the activation
    expect(g.calls[0]).toMatchObject({ url: VERIFY_URL, method: 'POST', body: { product_id: 'prod_123', license_key: KEY, increment_uses_count: 'true' } });
    expect(s.get('license')).toMatchObject({ key: KEY, status: 'active', verifiedAt: now });
  });

  it('refuses an unknown key, and a refunded or charged-back purchase', async () => {
    const g = gumroad();
    const L = new Licenses({ productId: 'prod_123', seats: 3, store: store(), fetch: g.fetch });
    await expect(L.activate('FFFFFFFF-FFFFFFFF-FFFFFFFF-FFFFFFFF')).rejects.toThrow(/does not exist/);
    await expect(L.activate('short')).rejects.toThrow(/licence key from your Gumroad receipt/);
    g.state.purchase = { refunded: true };
    await expect(L.activate(KEY)).rejects.toThrow(/refunded/);
    expect(refusalOf({ success: true, purchase: { chargebacked: true } })).toMatch(/charged back/);
    expect(refusalOf({ success: true, purchase: { disputed: true } })).toMatch(/disputed/);
    expect(refusalOf({ success: true, purchase: { disputed: true, dispute_won: true } })).toBeNull();
    expect(refusalOf({ success: true, purchase: { subscription_ended_at: '2026-01-01T00:00:00Z' } })).toMatch(/subscription/);
    expect(refusalOf({ success: true, purchase: {} })).toBeNull();
  });

  it('one licence runs on three computers: the fourth is refused and its seat given back; deactivating frees one', async () => {
    const g = gumroad();
    const pcs = [store(), store(), store(), store()].map((s) => new Licenses({ productId: 'prod_123', seats: 3, store: s, fetch: g.fetch }));
    for (const L of pcs.slice(0, 3)) expect((await L.activate(KEY)).ok).toBe(true);
    await expect(pcs[3].activate(KEY)).rejects.toThrow(/already active on 3 computers/);
    expect(g.uses.get(KEY)).toBe(3);
    // moved: one computer deactivates, and the fourth can then be activated
    await pcs[0].deactivate();
    expect(pcs[0].state()).toMatchObject({ ok: false, reason: 'none' });
    expect(g.uses.get(KEY)).toBe(2);
    expect((await pcs[3].activate(KEY)).ok).toBe(true);
  });

  it('checks again every few days; a refund later stops it; offline it carries on for 30 days, then asks', async () => {
    const g = gumroad();
    let now = 1_000 * DAY;
    const L = new Licenses({ productId: 'prod_123', seats: 3, store: store(), fetch: g.fetch, now: () => now });
    await L.activate(KEY);
    // too soon: Gumroad is not asked
    now += RECHECK_EVERY / 2;
    await L.recheck();
    expect(g.calls.length).toBe(1);
    // due: asked again, without counting a seat
    now += RECHECK_EVERY;
    expect((await L.recheck()).ok).toBe(true);
    expect(g.calls[1].body.increment_uses_count).toBe('false');
    expect(g.uses.get(KEY)).toBe(1);
    // offline: nothing changes until the grace runs out
    g.state.down = true;
    now += 20 * DAY;
    expect((await L.recheck()).ok).toBe(true);
    now += OFFLINE_GRACE;
    const st = await L.recheck();
    expect(st).toMatchObject({ ok: false, reason: 'offline' });
    expect(st.message).toMatch(/could not check its licence with Gumroad for \d+ days/);
    // back online: a check brings it back
    g.state.down = false;
    expect((await L.recheck({ force: true })).ok).toBe(true);
    // refunded later: the next check stops it, and says why
    g.state.purchase = { refunded: true };
    now += RECHECK_EVERY + 1;
    expect(await L.recheck()).toMatchObject({ ok: false, reason: 'revoked', message: expect.stringMatching(/refunded/) });
    // a revoked licence is not asked about again by itself
    const n = g.calls.length;
    now += RECHECK_EVERY * 2;
    await L.recheck();
    expect(g.calls.length).toBe(n);
  });

  it('an activation that cannot reach Gumroad says so', async () => {
    const g = gumroad({ down: true });
    const L = new Licenses({ productId: 'prod_123', seats: 3, store: store(), fetch: g.fetch });
    await expect(L.activate(KEY)).rejects.toThrow(/could not be reached/);
    expect(L.state().ok).toBe(false);
  });

  it('keys tidy and mask', () => {
    expect(tidyKey(' ab cd ')).toBe('ABCD');
    expect(maskKey(KEY)).toBe('A1B2C3D4…8F90');
    expect(maskKey('abcd')).toBe('••cd');
  });
});

describe('the commercial edition', () => {
  it('with no key set, nothing unlocks it (there is no built-in key to fall back on)', async () => {
    const sha = async (x) => (await import('node:crypto')).createHash('sha256').update(x).digest('hex');
    for (const k of ['12345678', '19900101', '58204719']) expect(await ledgerMatches(k, sha, undefined)).toBe(false);
  });

  it('the edition is fixed when the app is built', () => {
    expect(editionDefines({})).toEqual({ __NOVUS_EDITION__: '"personal"', __NOVUS_GUMROAD_PRODUCT__: '""', __NOVUS_SEATS__: '3' });
    expect(editionDefines({ NOVUS_EDITION: 'commercial', NOVUS_GUMROAD_PRODUCT: ' prod_123 ', NOVUS_SEATS: '5' })).toEqual({ __NOVUS_EDITION__: '"commercial"', __NOVUS_GUMROAD_PRODUCT__: '"prod_123"', __NOVUS_SEATS__: '5' });
    // a product id only means something in the commercial edition
    expect(editionDefines({ NOVUS_GUMROAD_PRODUCT: 'prod_123' }).__NOVUS_GUMROAD_PRODUCT__).toBe('""');
  });

  it('the terms cover the licence, no advice, trading risk, keys, no warranty and liability — and credit the author', () => {
    const t = termsText();
    for (const w of ['Quincy Gininda', 'three computers', 'is financial, investment', 'lose more than you expect', 'withdrawal rights', '"as is"', 'limited to the amount you paid']) expect(t).toContain(w);
  });
});
