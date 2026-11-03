// The Herald on X. Two jobs, each off until switched on (X bills every post it
// returns, so both keep to an hourly budget of searches):
//
//  - mentions: before a coin reaches the council, how many posts name its
//    $TICKER or its address in the last hour, from how many accounts, with how
//    many followers between them — into the Herald's vote and the forest;
//  - early trend: every so often, the newest posts with pump.fun coin links;
//    a coin posted by several accounts (or one big one) is sent to the swarm
//    to be read like any other launch.
import type { XPost } from '../../shared/xapi';
import { coinQuery, mentionStats, mintsFromPosts, TREND_QUERY } from '../../shared/xapi';
import type { XStats } from './features';

export interface XConfig {
  /** look up each candidate on X before the council */
  mentions: boolean;
  /** scan X for pump.fun links being posted */
  trend: boolean;
  /** most searches an hour, both jobs together */
  maxPerHour: number;
  /** minutes between trend scans */
  trendEveryMin: number;
  /** the X API key in the vault */
  secretId: string;
}
export const X_DEFAULTS: XConfig = { mentions: false, trend: false, maxPerHour: 12, trendEveryMin: 15, secretId: '' };
/** X's pay-per-use price per post read, USD (check developer.x.com) */
export const POST_PRICE = 0.005;
export const MENTION_POSTS = 10;
export const TREND_POSTS = 25;

/** The most an hour of searching can cost at the budget set (every search returning its full page). */
export function hourlyCost(c: XConfig) {
  const trendPerHour = c.trend ? Math.min(c.maxPerHour, 60 / Math.max(1, c.trendEveryMin)) : 0;
  const mentionPerHour = c.mentions ? Math.max(0, c.maxPerHour - trendPerHour) : 0;
  return (trendPerHour * TREND_POSTS + mentionPerHour * MENTION_POSTS) * POST_PRICE;
}

export class XWatch {
  private calls: number[] = [];
  private looked = new Map<string, number>();
  private busy = false;
  private lastTrend = 0;
  private quietUntil = 0;
  private lastError = '';

  constructor(
    private search: (id: string, query: string, max: number) => Promise<XPost[]>,
    readonly social: Map<string, XStats>,
    private onSpot: (mint: string, stats: XStats, posts: XPost[]) => void,
    private say: (text: string, mint?: string) => void,
  ) {}

  /** searches in the last hour */
  used(now: number) {
    this.calls = this.calls.filter((t) => now - t < 3_600_000);
    return this.calls.length;
  }

  /** One step: a trend scan when due, else one candidate's mentions — within the budget, one search at a time. */
  tick(now: number, cfg: XConfig, candidates: { mint: string; symbol: string }[]): Promise<void> | null {
    if (!cfg.secretId || this.busy || now < this.quietUntil || (!cfg.mentions && !cfg.trend)) return null;
    if (this.used(now) >= cfg.maxPerHour) return null;
    if (cfg.trend && now - this.lastTrend >= cfg.trendEveryMin * 60_000) {
      this.lastTrend = now;
      return this.run(now, () => this.trend(cfg, now));
    }
    if (!cfg.mentions) return null;
    const c = candidates.find((x) => now - (this.looked.get(x.mint) ?? 0) >= 10 * 60_000);
    if (!c) return null;
    this.looked.set(c.mint, now);
    return this.run(now, () => this.mentions(cfg, c, now));
  }

  private async run(now: number, job: () => Promise<void>) {
    this.busy = true;
    this.calls.push(now);
    try {
      await job();
      this.lastError = '';
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      if (msg !== this.lastError) this.say(`X search failed — ${msg}; trying again in 10 min`);
      this.lastError = msg;
      this.quietUntil = now + 10 * 60_000;
    } finally {
      this.busy = false;
    }
  }

  private async mentions(cfg: XConfig, c: { mint: string; symbol: string }, now: number) {
    const posts = await this.search(cfg.secretId, coinQuery(c.symbol, c.mint), MENTION_POSTS);
    const s = mentionStats(posts, now);
    this.social.set(c.mint, { posts: s.posts, authors: s.authors, reach: s.reach });
    this.say(s.posts ? `$${c.symbol} on X: ${s.posts} post${s.posts > 1 ? 's' : ''} from ${s.authors} account${s.authors > 1 ? 's' : ''} in the last hour, ${fmtReach(s.reach)} followers between them` : `$${c.symbol}: no posts on X in the last hour — nobody is talking about it yet`, c.mint);
  }

  private async trend(cfg: XConfig, now: number) {
    const posts = await this.search(cfg.secretId, TREND_QUERY, TREND_POSTS);
    const found = [...mintsFromPosts(posts)].map(([mint, list]) => ({ mint, list, s: mentionStats(list, now, 2 * 3_600_000) })).sort((a, b) => b.s.reach - a.s.reach);
    let sent = 0;
    for (const { mint, list, s } of found) {
      const stats = { posts: s.posts, authors: s.authors, reach: s.reach };
      this.social.set(mint, stats);
      if (s.authors >= 2 || s.reach >= 10_000) {
        this.onSpot(mint, stats, list);
        sent++;
      }
    }
    this.say(found.length ? `scanned X: ${posts.length} posts with pump.fun links, ${found.length} coins named, ${sent} sent to the swarm (posted by several accounts, or a big one)` : `scanned X: no pump.fun coins being posted right now`);
  }
}

export const fmtReach = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
