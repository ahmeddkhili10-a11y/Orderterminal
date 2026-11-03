// X (Twitter) recent search, as the Herald uses it: the posts about a coin
// (its $TICKER or its address) and the pump.fun links being posted. The token
// stays in the main process; this file only builds the request and reads the
// answer. X bills reads per post returned (pay-per-use), so every caller keeps
// to a budget.

export const X_SEARCH = 'https://api.x.com/2/tweets/search/recent';

export interface XPost {
  id: string;
  t: number;
  text: string;
  author: string;
  followers: number;
  likes: number;
  reposts: number;
  urls: string[];
}

/** The search URL: newest posts first, with their authors' follower counts and the links in them. */
export function searchUrl(query: string, max = 10): string {
  const p = new URLSearchParams({
    query,
    max_results: String(Math.min(100, Math.max(10, Math.round(max)))),
    'tweet.fields': 'created_at,public_metrics,author_id,entities',
    expansions: 'author_id',
    'user.fields': 'public_metrics,username',
  });
  return `${X_SEARCH}?${p}`;
}

/** Read X's answer into posts. */
export function parseSearch(j: any): XPost[] {
  const users = new Map<string, { username: string; followers: number }>();
  for (const u of j?.includes?.users ?? []) users.set(String(u.id), { username: String(u.username ?? u.id), followers: Number(u.public_metrics?.followers_count ?? 0) });
  return (j?.data ?? []).map((d: any) => {
    const u = users.get(String(d.author_id)) ?? { username: String(d.author_id ?? '?'), followers: 0 };
    return {
      id: String(d.id),
      t: Date.parse(d.created_at ?? '') || 0,
      text: String(d.text ?? ''),
      author: u.username,
      followers: u.followers,
      likes: Number(d.public_metrics?.like_count ?? 0),
      reposts: Number(d.public_metrics?.retweet_count ?? 0),
      urls: (d.entities?.urls ?? []).map((x: any) => String(x.expanded_url ?? x.url ?? '')),
    };
  });
}

/** What X says about a coin: posts in the last hour, distinct accounts, their combined followers, and the newest. */
export function mentionStats(posts: XPost[], now: number, windowMs = 3_600_000) {
  const recent = posts.filter((p) => now - p.t <= windowMs);
  const authors = new Map<string, number>();
  for (const p of recent) authors.set(p.author, Math.max(authors.get(p.author) ?? 0, p.followers));
  return {
    posts: recent.length,
    authors: authors.size,
    reach: [...authors.values()].reduce((a, b) => a + b, 0),
    newest: recent.reduce((a, p) => Math.max(a, p.t), 0),
  };
}

/** The search for one coin: its ticker as a cashtag or its address, no reposts. */
export function coinQuery(symbol: string, mint: string): string {
  const sym = symbol.replace(/[^A-Za-z0-9]/g, '');
  return `(${sym.length >= 2 && sym.length <= 12 ? `$${sym} OR ` : ''}${mint}) -is:retweet`;
}

/** The early-trend scan: posts with pump.fun coin links, no reposts. */
export const TREND_QUERY = 'url:"pump.fun/coin" -is:retweet';

const MINT = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

/** pump.fun coin addresses in posts (from their links, and addresses ending in "pump" written out), with who posted them. */
export function mintsFromPosts(posts: XPost[]): Map<string, XPost[]> {
  const out = new Map<string, XPost[]>();
  const add = (mint: string, p: XPost) => {
    const list = out.get(mint) ?? [];
    if (!list.some((x) => x.id === p.id)) list.push(p);
    out.set(mint, list);
  };
  for (const p of posts) {
    for (const u of p.urls) {
      const m = /pump\.fun\/(?:coin\/)?([1-9A-HJ-NP-Za-km-z]{32,44})/.exec(u);
      if (m) add(m[1], p);
    }
    for (const m of p.text.match(MINT) ?? []) if (m.endsWith('pump')) add(m, p);
  }
  return out;
}
