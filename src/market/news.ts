// The shared news stream: one socket however many screens read it (the News
// panel, the instrument report).
import { create } from 'zustand';
import type { ConnState, NewsItem } from '../core/types';
import { connectNews, fetchRecentNews } from '../exchanges/news';

/** Shared news stream: one socket regardless of how many News panels are open. */
export const useNews = create<{ items: NewsItem[]; status: ConnState; error?: string }>(() => ({ items: [], status: 'idle' }));
let newsRefs = 0;
let newsConn: { close(): void } | null = null;

export function retainNews() {
  if (newsRefs++ > 0) return;
  fetchRecentNews()
    .then((items) => useNews.setState((s) => ({ items: dedupe([...s.items, ...items]) })))
    .catch(() => undefined);
  newsConn = connectNews(
    (n) => useNews.setState((s) => ({ items: dedupe([n, ...s.items]).slice(0, 300) })),
    (status, error) => useNews.setState({ status, error }),
  );
}

export function releaseNews() {
  if (--newsRefs > 0) return;
  newsConn?.close();
  newsConn = null;
}

function dedupe(items: NewsItem[]) {
  const seen = new Set<string>();
  return items
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((a, b) => b.time - a.time);
}

