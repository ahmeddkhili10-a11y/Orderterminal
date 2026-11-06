// Shared market data for the professional terminal's panels: one ticker poll
// per venue (every 15 s) and cached candles per coin, so a dozen panels on
// screen do not each ask the exchange.
import { useEffect, useState } from 'react';
import type { Kline, Ticker, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { useSettings } from '../store/settings';

type Listener = () => void;

interface TickerFeed {
  rows: Ticker[];
  at: number;
  error: string;
  listeners: Set<Listener>;
  timer: ReturnType<typeof setInterval> | null;
}
const tickerFeeds = new Map<VenueId, TickerFeed>();

/** venues that can list every market (for the monitor, heat map and movers) */
export const BOARD_VENUES = (Object.keys(ADAPTERS) as VenueId[]).filter((v) => ADAPTERS[v].fetchTickers);

/** the board's venue: the primary when it can list markets, Binance futures otherwise */
export function useBoardVenue(): VenueId {
  const primary = useSettings((s) => s.primaryVenue);
  return BOARD_VENUES.includes(primary) ? primary : 'binancef';
}

function pollTickers(v: VenueId, f: TickerFeed) {
  ADAPTERS[v]
    .fetchTickers?.()
    .then((rows) => {
      f.rows = rows.filter((r) => r.last > 0);
      f.at = Date.now();
      f.error = '';
    })
    .catch((e) => {
      f.error = String(e?.message ?? e);
    })
    .finally(() => f.listeners.forEach((l) => l()));
}

export function useTickers(venue: VenueId) {
  const [, bump] = useState(0);
  useEffect(() => {
    let f = tickerFeeds.get(venue);
    if (!f) {
      f = { rows: [], at: 0, error: '', listeners: new Set(), timer: null };
      tickerFeeds.set(venue, f);
    }
    const fn = () => bump((x) => x + 1);
    f.listeners.add(fn);
    if (!f.timer) {
      pollTickers(venue, f);
      f.timer = setInterval(() => pollTickers(venue, f!), 15_000);
    }
    return () => {
      f!.listeners.delete(fn);
      if (!f!.listeners.size && f!.timer) {
        clearInterval(f!.timer);
        f!.timer = null;
      }
    };
  }, [venue]);
  const f = tickerFeeds.get(venue);
  return { rows: f?.rows ?? [], at: f?.at ?? 0, error: f?.error ?? '', supported: !!ADAPTERS[venue]?.fetchTickers };
}

// ---------- candles ----------

const klineCache = new Map<string, { at: number; rows: Kline[]; p?: Promise<Kline[]> }>();

/** candles for a coin on a venue, cached for five minutes */
export function klines(venue: VenueId, base: string, interval: string, limit: number): Promise<Kline[]> {
  const a = ADAPTERS[venue];
  const sym = a?.symbolFor(base);
  if (!sym) return Promise.reject(new Error(`${base} is not on ${a?.name ?? venue}`));
  const key = `${venue}:${sym}:${interval}:${limit}`;
  const hit = klineCache.get(key);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.p ?? Promise.resolve(hit.rows);
  const p = a.fetchKlines(sym, interval, limit).then((rows) => {
    klineCache.set(key, { at: Date.now(), rows });
    return rows;
  });
  klineCache.set(key, { at: Date.now(), rows: hit?.rows ?? [], p });
  p.catch(() => klineCache.delete(key));
  return p;
}

/** candles for several coins at once; reloads every five minutes */
export function useKlines(venue: VenueId, bases: string[], interval: string, limit: number) {
  const [state, setState] = useState<{ data: Record<string, Kline[]>; errors: Record<string, string>; loading: boolean }>({ data: {}, errors: {}, loading: true });
  const key = bases.join(',');
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const data: Record<string, Kline[]> = {};
      const errors: Record<string, string> = {};
      await Promise.all(
        bases.map((b) =>
          klines(venue, b, interval, limit)
            .then((r) => (data[b] = r))
            .catch((e) => (errors[b] = String(e?.message ?? e))),
        ),
      );
      if (alive) setState({ data, errors, loading: false });
    };
    void load();
    const t = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [venue, key, interval, limit]);
  return state;
}

// ---------- maths for the panels ----------

/** log returns of closes, aligned by time across coins (only times every coin has) */
export function alignedReturns(data: Record<string, Kline[]>): { bases: string[]; rets: number[][] } {
  const bases = Object.keys(data).filter((b) => data[b].length > 10);
  if (!bases.length) return { bases: [], rets: [] };
  const maps = bases.map((b) => new Map(data[b].map((k) => [k.time, k.close])));
  const times = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort((a, b) => a - b);
  const rets = bases.map((_, i) => times.slice(1).map((t, j) => Math.log(maps[i].get(t)! / maps[i].get(times[j])!)));
  return { bases, rets };
}

export function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return NaN;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] / n;
    mb += b[i] / n;
  }
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : NaN;
}

/** annualised realised volatility of the last n log returns (crypto trades all year) */
export function realisedVol(closes: number[], n: number, barsPerYear: number): number {
  const c = closes.slice(-(n + 1));
  if (c.length < 3) return NaN;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1);
  return Math.sqrt(v * barsPerYear);
}

/** compact number: 1.23B, 45.6M, 789K */
export function compact(x: number | undefined): string {
  if (x === undefined || !Number.isFinite(x)) return '—';
  const a = Math.abs(x);
  return a >= 1e12 ? `${(x / 1e12).toFixed(2)}T` : a >= 1e9 ? `${(x / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : a >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : x.toFixed(0);
}
