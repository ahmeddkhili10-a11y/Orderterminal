import { describe, expect, it, vi } from 'vitest';
import { coinQuery, mentionStats, mintsFromPosts, parseSearch, searchUrl, type XPost } from '../../shared/xapi';
import type { XStats } from './features';
import { hourlyCost, X_DEFAULTS, XWatch } from './xwatch';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGpump';
const answer = {
  data: [
    { id: '1', author_id: 'a', created_at: '2026-11-03T11:50:00Z', text: `this is going up $GHOST ${MINT}`, public_metrics: { like_count: 4, retweet_count: 1 }, entities: { urls: [] } },
    { id: '2', author_id: 'b', created_at: '2026-11-03T11:55:00Z', text: 'look', public_metrics: { like_count: 40 }, entities: { urls: [{ expanded_url: `https://pump.fun/coin/${MINT}` }] } },
    { id: '3', author_id: 'a', created_at: '2026-11-03T09:00:00Z', text: 'old post', entities: {} },
  ],
  includes: { users: [{ id: 'a', username: 'anon1', public_metrics: { followers_count: 1200 } }, { id: 'b', username: 'whale', public_metrics: { followers_count: 54000 } }] },
};

describe('X search', () => {
  it('reads posts, their authors and links', () => {
    const p = parseSearch(answer);
    expect(p[1]).toMatchObject({ id: '2', author: 'whale', followers: 54000, likes: 40, urls: [`https://pump.fun/coin/${MINT}`] });
    expect(parseSearch({})).toEqual([]);
  });

  it('counts the last hour: posts, accounts, reach', () => {
    expect(mentionStats(parseSearch(answer), NOW)).toEqual({ posts: 2, authors: 2, reach: 55200, newest: Date.parse('2026-11-03T11:55:00Z') });
  });

  it('finds pump.fun coins in links and written-out addresses', () => {
    const m = mintsFromPosts(parseSearch(answer));
    expect([...m.keys()]).toEqual([MINT]);
    expect(m.get(MINT)!.map((p) => p.id).sort()).toEqual(['1', '2']);
  });

  it('builds the searches', () => {
    expect(coinQuery('GHOST', MINT)).toBe(`($GHOST OR ${MINT}) -is:retweet`);
    expect(coinQuery('🐸', MINT)).toBe(`(${MINT}) -is:retweet`);
    expect(searchUrl('x', 3)).toContain('max_results=10');
  });
});

describe('The Herald on X', () => {
  const cfg = { ...X_DEFAULTS, secretId: 'k', mentions: true, trend: true, maxPerHour: 3, trendEveryMin: 15 };

  it('scans the trend first, sends coins posted by several accounts to the swarm, then looks up candidates — within the hourly budget', async () => {
    const search = vi.fn(async (_id: string, q: string) => (q.startsWith('url:') ? parseSearch(answer) : parseSearch({ data: [answer.data[0]], includes: answer.includes })));
    const social = new Map<string, XStats>();
    const spotted: string[] = [];
    const said: string[] = [];
    const w = new XWatch(search, social, (m) => spotted.push(m), (t) => said.push(t));
    await w.tick(NOW, cfg, [{ mint: 'M1', symbol: 'ONE' }]);
    expect(search).toHaveBeenLastCalledWith('k', 'url:"pump.fun/coin" -is:retweet', 25);
    expect(spotted).toEqual([MINT]);
    expect(social.get(MINT)).toEqual({ posts: 2, authors: 2, reach: 55200 });
    await w.tick(NOW + 1000, cfg, [{ mint: 'M1', symbol: 'ONE' }]);
    expect(search).toHaveBeenLastCalledWith('k', '($ONE OR M1) -is:retweet', 10);
    expect(said.at(-1)).toBe('$ONE on X: 1 post from 1 account in the last hour, 1k followers between them');
    // the same coin is not looked up again within 10 minutes; the budget runs out at 3 an hour
    expect(w.tick(NOW + 2000, cfg, [{ mint: 'M1', symbol: 'ONE' }])).toBeNull();
    await w.tick(NOW + 3000, cfg, [{ mint: 'M2', symbol: 'TWO' }]);
    expect(w.tick(NOW + 4000, cfg, [{ mint: 'M3', symbol: 'THREE' }])).toBeNull();
    expect(search).toHaveBeenCalledTimes(3);
  });

  it('off, or without a key, it never searches; a failure is said once and it waits 10 minutes', async () => {
    const search = vi.fn(async () => {
      throw new Error("Error invoking remote method 'x:search': Error: X rejected the key — check it under Connect → X");
    });
    const said: string[] = [];
    const w = new XWatch(search, new Map(), () => undefined, (t) => said.push(t));
    expect(w.tick(NOW, { ...cfg, mentions: false, trend: false }, [])).toBeNull();
    expect(w.tick(NOW, { ...cfg, secretId: '' }, [])).toBeNull();
    await w.tick(NOW, cfg, []);
    expect(said).toEqual(['X search failed — X rejected the key — check it under Connect → X; trying again in 10 min']);
    expect(w.tick(NOW + 60_000, cfg, [{ mint: 'M', symbol: 'M' }])).toBeNull();
  });

  it('says what an hour can cost at the budget set', () => {
    // 4 trend scans of 25 posts and 8 lookups of 10 posts, at $0.005 a post
    expect(hourlyCost({ ...cfg, maxPerHour: 12 })).toBeCloseTo((4 * 25 + 8 * 10) * 0.005);
    expect(hourlyCost({ ...cfg, mentions: false, trend: false })).toBe(0);
  });
});

export type { XPost };
