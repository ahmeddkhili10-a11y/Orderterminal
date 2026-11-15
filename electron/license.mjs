// Licences for the commercial edition, sold through Gumroad.
//
// Gumroad issues each buyer a licence key. The app checks it with Gumroad's
// licence API (POST https://api.gumroad.com/v2/licenses/verify — product id
// and key, no secret needed):
//
//   activate   the first check on a computer counts as one activation; a key
//              may be activated on LICENSE_SEATS computers (3 by default)
//   recheck    every few days the key is checked again without counting; a key
//              that was refunded, charged back, disputed, or whose subscription
//              ended, stops working
//   offline    a copy that cannot reach Gumroad keeps working for 30 days
//              after its last good check, then asks to be checked again
//
// The verdict is kept in the app's own database (the key and the buyer's email
// stay on the buyer's computer). With no product configured the edition has no
// licence check at all.

export const VERIFY_URL = 'https://api.gumroad.com/v2/licenses/verify';
const DAY = 86_400_000;
export const RECHECK_EVERY = 3 * DAY;
export const OFFLINE_GRACE = 30 * DAY;

/** a key shown on screen: the first and last block only */
export const maskKey = (key) => {
  const k = String(key ?? '').trim();
  return k.length <= 10 ? k.replace(/.(?=.{2})/g, '•') : `${k.slice(0, 8)}…${k.slice(-4)}`;
};

/** keys look like 8 blocks of 8 hex digits joined by dashes; spaces and case do not matter */
export const tidyKey = (key) => String(key ?? '').trim().replace(/\s+/g, '').toUpperCase();

/** why Gumroad's answer means the licence is not (or no longer) good, or null when it is */
export function refusalOf(body) {
  if (!body || body.success !== true) return String(body?.message ?? 'That licence key was not found for Novus Ordo.');
  const p = body.purchase ?? {};
  if (p.refunded) return 'This purchase was refunded, so its licence no longer works.';
  if (p.chargebacked) return 'This purchase was charged back, so its licence no longer works.';
  if (p.disputed && !p.dispute_won) return 'This purchase is disputed; its licence is paused until the dispute is settled.';
  if (p.subscription_ended_at || p.subscription_cancelled_at || p.subscription_failed_at) {
    const ended = Date.parse(p.subscription_ended_at ?? p.subscription_failed_at ?? '');
    if (p.subscription_ended_at || p.subscription_failed_at || (Number.isFinite(ended) && ended < Date.now())) return 'The subscription for this licence has ended.';
  }
  return null;
}

export class Licenses {
  /**
   * @param o {{ productId: string, seats: number, store: { get(k: string): any, set(k: string, v: any): void },
   *             fetch?: typeof fetch, now?: () => number, timeoutMs?: number }}
   */
  constructor(o) {
    this.productId = String(o.productId ?? '');
    this.seats = Math.max(1, Number(o.seats) || 3);
    this.store = o.store;
    this.fetch = o.fetch ?? globalThis.fetch;
    this.now = o.now ?? Date.now;
    this.timeoutMs = o.timeoutMs ?? 20_000;
  }

  /** is there a licence check at all (a commercial build with a Gumroad product)? */
  get required() {
    return this.productId.length > 0;
  }

  record() {
    const r = this.store.get('license');
    return r && typeof r === 'object' && typeof r.key === 'string' ? r : null;
  }

  /** where the licence stands, for the lock screen (no full key, ever) */
  state() {
    if (!this.required) return { required: false, ok: true };
    const r = this.record();
    if (!r) return { required: true, ok: false, reason: 'none' };
    if (r.status === 'revoked') return { required: true, ok: false, reason: 'revoked', message: r.message, key: maskKey(r.key), email: r.email };
    const since = this.now() - (r.verifiedAt ?? 0);
    if (since > OFFLINE_GRACE) return { required: true, ok: false, reason: 'offline', message: `Novus Ordo could not check its licence with Gumroad for ${Math.floor(since / DAY)} days. Connect to the internet and check it again.`, key: maskKey(r.key), email: r.email };
    return { required: true, ok: true, key: maskKey(r.key), email: r.email, verifiedAt: r.verifiedAt, uses: r.uses };
  }

  async ask(key, count) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_id: this.productId, license_key: key, increment_uses_count: count ? 'true' : 'false' }).toString(),
        signal: ctrl.signal,
      });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      // Gumroad answers 404 with a message for an unknown key: that is a verdict, not an outage
      if (!res.ok && !(body && body.success === false)) throw new Error(`Gumroad answered ${res.status}`);
      return body;
    } finally {
      clearTimeout(t);
    }
  }

  /** activate a key on this computer (counts one of its seats) */
  async activate(key0) {
    if (!this.required) return this.state();
    const key = tidyKey(key0);
    if (key.length < 16) throw new Error('Enter the licence key from your Gumroad receipt.');
    let body;
    try {
      body = await this.ask(key, true);
    } catch (err) {
      throw new Error(`Gumroad could not be reached to check the key (${String(err?.message ?? err).slice(0, 80)}). Check the internet connection and try again.`);
    }
    const why = refusalOf(body);
    if (why) throw new Error(why);
    const uses = Number(body.uses) || 1;
    if (uses > this.seats) {
      // the seat just counted is given back
      await this.release(key).catch(() => {});
      throw new Error(`This licence is already active on ${this.seats} computer${this.seats === 1 ? '' : 's'} — the most one licence allows. Deactivate it on one of them, or contact support.`);
    }
    this.store.set('license', { key, email: String(body.purchase?.email ?? ''), activatedAt: this.now(), verifiedAt: this.now(), uses, status: 'active' });
    return this.state();
  }

  /** give a seat back (when deactivated on this computer) */
  async release(key0) {
    const key = tidyKey(key0);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      await this.fetch('https://api.gumroad.com/v2/licenses/decrement_uses_count', {
        method: 'PUT',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ product_id: this.productId, license_key: key }).toString(),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  /** deactivate this computer: its seat is given back and the licence forgotten here */
  async deactivate() {
    const r = this.record();
    if (r) await this.release(r.key).catch(() => {});
    this.store.set('license', null);
    return this.state();
  }

  /**
   * Check the licence again (without counting a seat). Returns the new state.
   * An answer that says the licence is no longer good revokes it; no answer
   * (offline, Gumroad down) changes nothing — the grace period runs on.
   */
  async recheck({ force = false } = {}) {
    const r = this.record();
    if (!this.required || !r || r.status === 'revoked') return this.state();
    if (!force && this.now() - (r.verifiedAt ?? 0) < RECHECK_EVERY) return this.state();
    let body;
    try {
      body = await this.ask(r.key, false);
    } catch {
      return this.state();
    }
    const why = refusalOf(body);
    if (why) this.store.set('license', { ...r, status: 'revoked', message: why, checkedAt: this.now() });
    else this.store.set('license', { ...r, status: 'active', verifiedAt: this.now(), uses: Number(body.uses) || r.uses, email: String(body.purchase?.email ?? r.email ?? '') });
    return this.state();
  }
}
