// Fake coins: the Sentinel's second net, after the rug checks. A rug is a coin
// built to be dumped; a fake is a coin pretending to be something it is not —
// and on pump.fun they are most of the copies of anything that runs:
//
//  - impersonators: a brand-new coin with the exact ticker or name of an
//    established one ($BONK, $WIF, USDC …) — the real ones are months old;
//  - duplicates: the same ticker or name launched again by another coin (the
//    copy is rejected, unless it has since overtaken the first one by 3×);
//  - stolen logos: the very same image file as another coin (pump.fun logos are
//    IPFS files: the same file has the same address);
//  - copied socials: the same X, Telegram or website link as another coin;
//  - borrowed accounts: a famous account (@elonmusk …) linked as "its own" X.
//
// The swarm sees every launch, so it remembers each of these for a day.
import type { MemeToken } from '../token';

/** Tickers of established coins a fresh coin must not borrow. */
export const ESTABLISHED = new Set([
  'SOL', 'WSOL', 'USDC', 'USDT', 'BTC', 'WBTC', 'ETH', 'WETH', 'JUP', 'JTO', 'PYTH', 'RAY', 'ORCA', 'JITOSOL', 'MSOL', 'BSOL',
  'BONK', 'WIF', 'POPCAT', 'MEW', 'BOME', 'SLERF', 'MYRO', 'WEN', 'PONKE', 'MICHI', 'TRUMP', 'MELANIA', 'PENGU', 'FARTCOIN',
  'PNUT', 'GOAT', 'MOODENG', 'CHILLGUY', 'AI16Z', 'GIGA', 'SPX', 'RETARDIO', 'ZEREBRO', 'GRIFFAIN', 'SWARMS', 'PUMP',
  'DOGE', 'SHIB', 'PEPE', 'FLOKI', 'XRP', 'BNB',
]);
/** Accounts coins like to pass off as their own. */
const FAMOUS = new Set(['elonmusk', 'realdonaldtrump', 'potus', 'whitehouse', 'cz_binance', 'binance', 'coinbase', 'brian_armstrong', 'vitalikbuterin', 'saylor', 'solana', 'aeyakovenko', 'rajgokal', 'pumpdotfun', 'phantom', 'kanyewest', 'kimkardashian', 'mrbeast', 'tesla', 'spacex', 'nasa', 'jupiterexchange', 'dexscreener', 'blknoiz06', 'ansem']);
/** Links too generic to say anything when two coins share them. */
const GENERIC = /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com|t\.me|telegram\.me|pump\.fun|google\.com|youtube\.com|tiktok\.com|instagram\.com|linktr\.ee|dexscreener\.com|solscan\.io)\/?$/;
const DAY = 24 * 3_600_000;
/** an established coin is older than this; a coin younger with its ticker is an impersonator */
const IMPERSONATOR_AGE = 3 * DAY;

const norm = (x: string) => x.toLowerCase().replace(/^\$/, '').replace(/[^a-z0-9]/g, '');
/** The file behind a logo URL: an IPFS content id when there is one, else the URL. */
export function imageKey(url?: string): string | null {
  if (!url) return null;
  const m = /(?:ipfs\/|ipfs:\/\/)([a-zA-Z0-9]{46,})/.exec(url) ?? /\/\/([a-z0-9]{50,})\.ipfs\./.exec(url);
  return m ? m[1] : url.trim();
}
/** A link as it identifies an account or a page: lower case, no query, no trailing slash, x.com for twitter.com. */
export function linkKey(url?: string): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!u || GENERIC.test(u)) return null;
  u = u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/^twitter\.com/, 'x.com').replace(/^mobile\./, '');
  // only real links say anything: a domain (and maybe a path) — not junk like "x", "n/a", "-"
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/.test(u) || GENERIC.test(u)) return null;
  return u;
}
/** The handle of an X profile link (not a post), or null. */
export function xHandle(url?: string): string | null {
  const k = linkKey(url);
  const m = k && /^x\.com\/([a-z0-9_]{1,15})$/.exec(k);
  return m ? m[1] : null;
}

const linksOf = (tok: MemeToken) => [tok.meta?.twitter, tok.meta?.telegram, tok.meta?.website, ...(tok.dex?.socials ?? []).map((s) => s.url)].map(linkKey).filter((x): x is string => Boolean(x));

interface Seen {
  mint: string;
  t: number;
}

export class FakeFilter {
  private symbols = new Map<string, Seen[]>();
  private names = new Map<string, Seen[]>();
  private images = new Map<string, Seen[]>();
  private links = new Map<string, Seen[]>();
  private known = new Map<string, { t: number; image: string | null; links: Set<string> }>();

  private put(map: Map<string, Seen[]>, key: string, mint: string, t: number) {
    const list = map.get(key) ?? [];
    if (!list.some((x) => x.mint === mint)) list.push({ mint, t });
    list.sort((a, b) => a.t - b.t);
    map.set(key, list);
  }

  /** Remember a coin (again, as its logo and socials come in). */
  see(tok: MemeToken) {
    const t = tok.createdAt;
    const rec = this.known.get(tok.mint) ?? { t, image: null, links: new Set<string>() };
    if (!this.known.has(tok.mint)) {
      this.known.set(tok.mint, rec);
      if (norm(tok.symbol)) this.put(this.symbols, norm(tok.symbol), tok.mint, t);
      if (norm(tok.name).length >= 3) this.put(this.names, norm(tok.name), tok.mint, t);
    }
    const img = imageKey(tok.image);
    if (img && rec.image !== img) {
      rec.image = img;
      this.put(this.images, img, tok.mint, t);
    }
    for (const l of linksOf(tok)) {
      if (rec.links.has(l)) continue;
      rec.links.add(l);
      this.put(this.links, l, tok.mint, t);
    }
  }

  /** Forget coins launched more than a day ago. */
  prune(now: number) {
    for (const map of [this.symbols, this.names, this.images, this.links]) {
      for (const [k, list] of map) {
        const keep = list.filter((x) => now - x.t < DAY);
        if (keep.length) map.set(k, keep);
        else map.delete(k);
      }
    }
    for (const [mint, rec] of this.known) if (now - rec.t >= DAY) this.known.delete(mint);
  }

  /**
   * Why this coin is a fake, or nothing. `symbolOf` and `mcapOf` look up the
   * other coins (for the message, and to let a copy that overtook the first by
   * 3× through).
   */
  check(tok: MemeToken, now: number, symbolOf: (mint: string) => string, mcapOf: (mint: string) => number): string[] {
    const why: string[] = [];
    const sym = norm(tok.symbol);
    const young = now - tok.createdAt < IMPERSONATOR_AGE || (tok.source === 'pump' && !tok.migrated);
    if (young && (ESTABLISHED.has(sym.toUpperCase()) || ESTABLISHED.has(norm(tok.name).toUpperCase()))) why.push(`impersonates $${ESTABLISHED.has(sym.toUpperCase()) ? sym.toUpperCase() : norm(tok.name).toUpperCase()} — a new coin with an established coin's ticker`);
    const earlier = (map: Map<string, Seen[]>, key: string | null) => {
      if (!key) return null;
      const list = map.get(key) ?? [];
      const first = list[0];
      // only a coin launched strictly before this one is the original
      if (!first || first.mint === tok.mint || first.t >= tok.createdAt) return null;
      // a copy that has clearly overtaken the first is the market's pick, not a fake
      if (mcapOf(tok.mint) > 3 * Math.max(mcapOf(first.mint), 1e-9)) return null;
      return first;
    };
    const minsAgo = (s: Seen) => Math.max(1, Math.round((tok.createdAt - s.t) / 60_000));
    const dupSym = earlier(this.symbols, sym || null);
    if (dupSym) why.push(`duplicate of $${symbolOf(dupSym.mint) || tok.symbol} launched ${minsAgo(dupSym)} min earlier — a copy`);
    else {
      const dupName = earlier(this.names, norm(tok.name).length >= 3 ? norm(tok.name) : null);
      if (dupName) why.push(`same name as $${symbolOf(dupName.mint)} launched ${minsAgo(dupName)} min earlier — a copy`);
    }
    const img = earlier(this.images, imageKey(tok.image));
    if (img) why.push(`uses the same logo file as $${symbolOf(img.mint)} — a copy`);
    for (const l of linksOf(tok)) {
      const owner = earlier(this.links, l);
      if (owner) {
        why.push(`its link ${l} belongs to $${symbolOf(owner.mint)} — socials copied`);
        break;
      }
    }
    const handle = xHandle(tok.meta?.twitter) ?? [...(tok.dex?.socials ?? [])].map((s) => xHandle(s.url)).find(Boolean) ?? null;
    if (handle && FAMOUS.has(handle)) why.push(`links @${handle} as its own X account — it is not theirs`);
    return why;
  }
}
