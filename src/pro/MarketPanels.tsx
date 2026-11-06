// The professional terminal's market screens:
//
//   MON   Monitor — a dense quote board: last, change, range, volume,
//         funding and open interest for every market on the venue
//   HMAP  Heat map — the market as tiles, sized by volume, coloured by change
//   CORR  Correlation matrix — how the coins move together (hourly or daily)
//   HVOL  Volatility monitor — realised volatility over a day, a week, a month
import { useMemo, useRef, useState } from 'react';
import { fmtPct, fmtPrice } from '../core/format';
import type { Ticker, VenueId } from '../core/types';
import { ADAPTERS } from '../exchanges';
import { useSettings } from '../store/settings';
import { Select, Spacer, Toolbar, type PanelProps } from '../ui/controls';
import { alignedReturns, BOARD_VENUES, compact, correlation, realisedVol, useBoardVenue, useKlines, useTickers } from './data';

const venueOpts = () => [{ value: 'auto' as const, label: 'Primary venue' }, ...BOARD_VENUES.map((v) => ({ value: v, label: ADAPTERS[v].name }))];
function useVenue(v: VenueId | 'auto') {
  const board = useBoardVenue();
  return v === 'auto' ? board : v;
}

function Status({ venue, at, error, supported }: { venue: VenueId; at: number; error: string; supported: boolean }) {
  if (!supported) return <span className="pro-status down">{ADAPTERS[venue]?.name} cannot list markets</span>;
  if (error && !at) return <span className="pro-status down">{error}</span>;
  return <span className="pro-status">{at ? `${ADAPTERS[venue].name} · ${new Date(at).toLocaleTimeString()}` : 'loading…'}</span>;
}

// ---------- MON ----------

export interface MonitorConfig {
  venue: VenueId | 'auto';
  sort: 'volume24hUsd' | 'change24hPct' | 'fundingRate' | 'openInterestUsd' | 'base';
  desc: boolean;
  rows: number;
  minVolume: number;
}
export const MONITOR_DEFAULTS: MonitorConfig = { venue: 'auto', sort: 'volume24hUsd', desc: true, rows: 60, minVolume: 5_000_000 };

export function Monitor({ config: c, setConfig }: PanelProps<MonitorConfig>) {
  const venue = useVenue(c.venue);
  const t = useTickers(venue);
  const setPrimary = useSettings((s) => s.setPrimary);
  const base = useSettings((s) => s.base);
  const prev = useRef(new Map<string, number>());
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const r = t.rows.filter((x) => x.volume24hUsd >= c.minVolume && (!q || x.base.includes(q.toUpperCase())));
    const k = c.sort;
    r.sort((a, b) => (k === 'base' ? a.base.localeCompare(b.base) : ((a[k] as number) ?? -Infinity) - ((b[k] as number) ?? -Infinity)) * (c.desc ? -1 : 1));
    return r.slice(0, c.rows);
  }, [t.rows, t.at, c.sort, c.desc, c.rows, c.minVolume, q]);
  const tick = (x: Ticker) => {
    const p = prev.current.get(x.symbol);
    prev.current.set(x.symbol, x.last);
    return p === undefined || p === x.last ? '' : x.last > p ? 'tick-up' : 'tick-down';
  };
  const th = (k: MonitorConfig['sort'], label: string, cls = '') => (
    <th className={`${cls} sortable${c.sort === k ? ' on' : ''}`} onClick={() => setConfig(c.sort === k ? { desc: !c.desc } : { sort: k, desc: k !== 'base' })}>
      {label}
      {c.sort === k ? (c.desc ? ' ▼' : ' ▲') : ''}
    </th>
  );
  return (
    <div className="pro-panel">
      <Toolbar>
        <input className="ctl mono" placeholder="FILTER" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 80 }} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Select value={c.minVolume} options={[{ value: 0, label: 'All' }, { value: 1_000_000, label: '> $1M' }, { value: 5_000_000, label: '> $5M' }, { value: 50_000_000, label: '> $50M' }]} onChange={(minVolume) => setConfig({ minVolume })} title="Minimum 24h volume" />
        <Spacer />
        <Status venue={venue} {...t} />
      </Toolbar>
      <div className="pro-scroll">
        <table className="pro-table">
          <thead>
            <tr>
              {th('base', 'TICKER', 'l')}
              <th>LAST</th>
              {th('change24hPct', 'CHG %')}
              <th>HIGH</th>
              <th>LOW</th>
              {th('volume24hUsd', 'VOL $')}
              {th('fundingRate', 'FUND APR')}
              {th('openInterestUsd', 'OI $')}
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.symbol} className={x.base === base ? 'sel' : ''} onClick={() => setPrimary(x.base, venue)} title={`Make ${x.base} the primary market`}>
                <td className="l b">{x.base}</td>
                <td className={`mono ${tick(x)}`}>{fmtPrice(x.last)}</td>
                <td className={`mono ${x.change24hPct >= 0 ? 'up' : 'down'}`}>{fmtPct(x.change24hPct)}</td>
                <td className="mono muted">{x.high24h ? fmtPrice(x.high24h) : '—'}</td>
                <td className="mono muted">{x.low24h ? fmtPrice(x.low24h) : '—'}</td>
                <td className="mono">{compact(x.volume24hUsd)}</td>
                <td className={`mono ${(x.fundingRate ?? 0) >= 0 ? '' : 'down'}`}>{x.fundingRate !== undefined ? `${(x.fundingRate * (venue === 'hyperliquid' ? 24 : 3) * 365 * 100).toFixed(1)}%` : '—'}</td>
                <td className="mono">{compact(x.openInterestUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="pro-empty">{t.supported ? (t.at ? 'No markets match' : 'Loading the board…') : 'Pick a venue that lists markets'}</div>}
      </div>
    </div>
  );
}

// ---------- HMAP ----------

export interface HeatConfig {
  venue: VenueId | 'auto';
  tiles: number;
}
export const HEAT_DEFAULTS: HeatConfig = { venue: 'auto', tiles: 48 };

export function HeatGrid({ config: c, setConfig }: PanelProps<HeatConfig>) {
  const venue = useVenue(c.venue);
  const t = useTickers(venue);
  const setPrimary = useSettings((s) => s.setPrimary);
  const top = [...t.rows].sort((a, b) => b.volume24hUsd - a.volume24hUsd).slice(0, c.tiles);
  const maxV = top[0]?.volume24hUsd ?? 1;
  const up = top.filter((x) => x.change24hPct > 0).length;
  return (
    <div className="pro-panel">
      <Toolbar>
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Select value={c.tiles} options={[24, 48, 96].map((n) => ({ value: n, label: `${n} tiles` }))} onChange={(tiles) => setConfig({ tiles })} />
        <span className="pro-status">
          <span className="up">{up} up</span> · <span className="down">{top.length - up} down</span>
        </span>
        <Spacer />
        <Status venue={venue} {...t} />
      </Toolbar>
      <div className="pro-heat">
        {top.map((x) => {
          // the size class follows volume; the colour follows the day's change (±8 % is full strength)
          const span = x.volume24hUsd > maxV * 0.25 ? 3 : x.volume24hUsd > maxV * 0.06 ? 2 : 1;
          const k = Math.min(1, Math.abs(x.change24hPct) / 8);
          return (
            <button key={x.symbol} className={`pro-tile s${span} ${x.change24hPct >= 0 ? 'up' : 'down'}`} style={{ ['--k' as string]: (0.18 + 0.82 * k).toFixed(2) }} onClick={() => setPrimary(x.base, venue)} title={`${x.base}: ${fmtPrice(x.last)} · ${fmtPct(x.change24hPct)} · volume $${compact(x.volume24hUsd)}`}>
              <b>{x.base}</b>
              <span className="mono">{fmtPct(x.change24hPct)}</span>
              {span > 1 && <small className="mono">${compact(x.volume24hUsd)}</small>}
            </button>
          );
        })}
        {!top.length && <div className="pro-empty">{t.supported ? 'Loading…' : 'Pick a venue that lists markets'}</div>}
      </div>
    </div>
  );
}

// ---------- CORR ----------

export interface CorrConfig {
  venue: VenueId | 'auto';
  coins: string;
  window: '7d' | '30d' | '90d';
}
export const CORR_DEFAULTS: CorrConfig = { venue: 'auto', coins: 'BTC ETH SOL BNB XRP DOGE AVAX LINK ADA SUI', window: '30d' };

const WINDOWS = { '7d': { interval: '1h', limit: 168, bpy: 8760 }, '30d': { interval: '4h', limit: 180, bpy: 2190 }, '90d': { interval: '1d', limit: 90, bpy: 365 } } as const;

export function Correl({ config: c, setConfig }: PanelProps<CorrConfig>) {
  const venue = useVenue(c.venue);
  const coins = c.coins.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 14);
  const w = WINDOWS[c.window];
  const k = useKlines(venue, coins, w.interval, w.limit);
  const { bases, rets } = useMemo(() => alignedReturns(k.data), [k.data]);
  const [text, setText] = useState(c.coins);
  const btc = bases.indexOf('BTC');
  return (
    <div className="pro-panel">
      <Toolbar>
        <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => setConfig({ coins: text })} style={{ width: 220 }} title="Coins, separated by spaces" />
        <Select value={c.window} options={[{ value: '7d', label: '7 days (1h)' }, { value: '30d', label: '30 days (4h)' }, { value: '90d', label: '90 days (1d)' }]} onChange={(window) => setConfig({ window })} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Spacer />
        <span className="pro-status">{k.loading ? 'loading…' : `${rets[0]?.length ?? 0} returns · Pearson`}</span>
      </Toolbar>
      <div className="pro-scroll">
        {bases.length >= 2 ? (
          <table className="pro-table pro-matrix">
            <thead>
              <tr>
                <th className="l" />
                {bases.map((b) => (
                  <th key={b}>{b}</th>
                ))}
                {btc >= 0 && <th title="Beta to bitcoin">β BTC</th>}
                <th title="Annualised volatility">VOL</th>
              </tr>
            </thead>
            <tbody>
              {bases.map((a, i) => (
                <tr key={a}>
                  <td className="l b">{a}</td>
                  {bases.map((b, j) => {
                    const r = i === j ? 1 : correlation(rets[i], rets[j]);
                    return (
                      <td key={b} className="mono pro-cell" style={{ ['--c' as string]: r.toFixed(2) }} data-sign={r >= 0 ? '+' : '-'} data-strong={Math.abs(r) >= 0.5 ? '1' : '0'}>
                        {Number.isFinite(r) ? r.toFixed(2) : '—'}
                      </td>
                    );
                  })}
                  {btc >= 0 && <td className="mono">{beta(rets[i], rets[btc]).toFixed(2)}</td>}
                  <td className="mono">{(sd(rets[i]) * Math.sqrt(w.bpy) * 100).toFixed(0)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="pro-empty">{k.loading ? 'Loading candles…' : `Not enough candles: ${Object.entries(k.errors).map(([b, e]) => `${b} (${e})`).join(', ') || 'pick two or more coins'}`}</div>
        )}
      </div>
    </div>
  );
}
const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / (x.length || 1);
const sd = (x: number[]) => {
  const m = mean(x);
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, x.length - 1));
};
const beta = (y: number[], x: number[]) => {
  const mx = mean(x);
  const my = mean(y);
  let c = 0;
  let v = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    c += (x[i] - mx) * (y[i] - my);
    v += (x[i] - mx) ** 2;
  }
  return v > 0 ? c / v : NaN;
};

// ---------- HVOL ----------

export interface VolConfig {
  venue: VenueId | 'auto';
  coins: string;
}
export const VOL_DEFAULTS: VolConfig = { venue: 'auto', coins: 'BTC ETH SOL BNB XRP DOGE AVAX LINK' };

export function VolMonitor({ config: c, setConfig }: PanelProps<VolConfig>) {
  const venue = useVenue(c.venue);
  const coins = c.coins.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 16);
  const k = useKlines(venue, coins, '1h', 720);
  const [text, setText] = useState(c.coins);
  const rows = coins
    .map((b) => {
      const cl = (k.data[b] ?? []).map((x) => x.close);
      if (cl.length < 50) return null;
      const v1 = realisedVol(cl, 24, 8760);
      const v7 = realisedVol(cl, 168, 8760);
      const v30 = realisedVol(cl, 719, 8760);
      // where today's volatility sits among the month's daily readings
      const daily = Array.from({ length: 29 }, (_, d) => realisedVol(cl.slice(0, cl.length - d * 24), 24, 8760)).filter(Number.isFinite);
      const rank = daily.filter((x) => x < v1).length / Math.max(1, daily.length - 1);
      return { b, v1, v7, v30, rank, term: v7 > 0 ? v1 / v7 : NaN };
    })
    .filter(Boolean) as { b: string; v1: number; v7: number; v30: number; rank: number; term: number }[];
  const max = Math.max(0.01, ...rows.flatMap((r) => [r.v1, r.v7, r.v30]));
  const bar = (v: number) => (
    <span className="pro-vbar">
      <i style={{ width: `${Math.min(100, (v / max) * 100)}%` }} />
      <em className="mono">{(v * 100).toFixed(0)}%</em>
    </span>
  );
  return (
    <div className="pro-panel">
      <Toolbar>
        <input className="ctl mono" value={text} onChange={(e) => setText(e.target.value.toUpperCase())} onBlur={() => setConfig({ coins: text })} style={{ width: 220 }} />
        <Select value={c.venue} options={venueOpts()} onChange={(venue) => setConfig({ venue })} />
        <Spacer />
        <span className="pro-status">realised, annualised · hourly closes</span>
      </Toolbar>
      <div className="pro-scroll">
        <table className="pro-table">
          <thead>
            <tr>
              <th className="l">TICKER</th>
              <th>1 DAY</th>
              <th>7 DAYS</th>
              <th>30 DAYS</th>
              <th title="1-day over 7-day volatility: above 1, volatility is rising">TERM</th>
              <th title="Where today sits among the month's daily readings">RANK</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.b}>
                <td className="l b">{r.b}</td>
                <td>{bar(r.v1)}</td>
                <td>{bar(r.v7)}</td>
                <td>{bar(r.v30)}</td>
                <td className={`mono ${r.term > 1.2 ? 'down' : r.term < 0.8 ? 'up' : ''}`}>{r.term.toFixed(2)}</td>
                <td className="mono">{(r.rank * 100).toFixed(0)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <div className="pro-empty">{k.loading ? 'Loading candles…' : 'No candles for these coins on this venue'}</div>}
      </div>
    </div>
  );
}
