// The market as an island: pure functions that turn the order book's history,
// the price path and the tape into what the 3D island draws.
//
//   terrain   x = price around the market, z = time (oldest at the back),
//             height = liquidity resting at that price at that time: walls of
//             orders rise as mountains, thin books are low land, and the
//             island's coast sinks into the sea at the edges
//   river     the price itself, carved into the valley between the walls
//   lights    trades, where and when they printed: size is brightness,
//             buyers warm gold, sellers hot red
//   skyline   volume traded at each price, as glowing bars along the back
//
// The side panels: the order book as glowing bars, volatility as a wave ribbon
// over three horizons, the tape as a point cloud in a cube, and the volume
// profile as a ridge of bars over time.
import type { HeatmapSnapshot } from '../core/heatmap';
import type { Trade } from '../core/types';
import type { CSwarmState } from '../desktop/bridge';

export interface Window {
  lo: number;
  hi: number;
  t0: number;
  t1: number;
}

/** The price window around the market: wide enough for the walls near it. */
export function priceWindow(mid: number, res = 0): { lo: number; hi: number } {
  const half = Math.max(mid * 0.0035, res * 40);
  return { lo: mid - half, hi: mid + half };
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Resting quantity per (time row, price column), oldest row first; empty rows carry the last book forward. */
export function liquidityGrid(snaps: HeatmapSnapshot[], w: Window, cols: number, rows: number): Float32Array {
  const g = new Float32Array(cols * rows);
  const n = new Uint16Array(rows);
  const span = w.t1 - w.t0;
  for (const s of snaps) {
    if (s.time < w.t0 || s.time > w.t1) continue;
    const r = Math.min(rows - 1, Math.floor(((s.time - w.t0) / span) * rows));
    n[r]++;
    for (const arr of [s.bids, s.asks]) {
      for (let i = 0; i < arr.length; i += 2) {
        const p = arr[i];
        if (p < w.lo || p >= w.hi) continue;
        const c = Math.floor(((p - w.lo) / (w.hi - w.lo)) * cols);
        g[r * cols + c] += arr[i + 1];
      }
    }
  }
  let last = -1;
  for (let r = 0; r < rows; r++) {
    if (n[r]) {
      for (let c = 0; c < cols; c++) g[r * cols + c] /= n[r];
      last = r;
    } else if (last >= 0) g.copyWithin(r * cols, last * cols, last * cols + cols);
  }
  return g;
}

/** A deterministic, smooth hash noise in 0..1 for the land under the mountains. */
export function landNoise(x: number, y: number): number {
  const v = Math.sin(x * 3.1 + 1.7) * Math.cos(y * 2.3 - 0.4) + 0.5 * Math.sin(x * 7.3 + y * 5.1) + 0.25 * Math.cos(x * 13.7 - y * 11.9);
  return clamp01(0.5 + v / 3.5);
}

/** 1 inside the island, falling to 0 at a jagged coast. */
export function islandMask(u: number, v: number): number {
  const dx = Math.abs(u - 0.5) * 2;
  const dy = Math.abs(v - 0.5) * 2;
  const d = Math.pow(Math.pow(dx, 2.6) + Math.pow(dy, 2.6), 1 / 2.6);
  const a = Math.atan2(v - 0.5, u - 0.5);
  const coast = 0.84 + 0.07 * Math.sin(a * 5 + 1.3) + 0.04 * Math.sin(a * 11 - 0.7) + 0.025 * Math.sin(u * 23 + v * 17);
  return clamp01((coast - d) / 0.3);
}

function blur(h: Float32Array, cols: number, rows: number) {
  const out = new Float32Array(h.length);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      let s = 0;
      let k = 0;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
          const wgt = dr === 0 && dc === 0 ? 4 : dr === 0 || dc === 0 ? 2 : 1;
          s += h[rr * cols + cc] * wgt;
          k += wgt;
        }
      out[r * cols + c] = s / k;
    }
  return out;
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a: number[] = [];
  for (let i = 0; i < values.length; i++) if (values[i] > 0) a.push(values[i]);
  if (!a.length) return 0;
  a.sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(p * a.length))];
}

/** The price at each row's time (from the mid series), or NaN before it starts. */
export function riverCols(mids: { time: number; value: number }[], w: Window, cols: number, rows: number): Float32Array {
  const out = new Float32Array(rows).fill(NaN);
  let j = 0;
  for (let r = 0; r < rows; r++) {
    const t = w.t0 + ((r + 0.5) / rows) * (w.t1 - w.t0);
    while (j + 1 < mids.length && mids[j + 1].time <= t) j++;
    if (!mids.length || mids[j].time > t) continue;
    out[r] = ((mids[j].value - w.lo) / (w.hi - w.lo)) * cols;
  }
  return out;
}

export interface Terrain {
  cols: number;
  rows: number;
  /** land height per vertex, about −0.2 (sea floor) to 1 (the biggest wall) */
  h: Float32Array;
  /** resting quantity per cell, for the peek */
  qty: Float32Array;
  /** the river: price column per row (NaN where unknown) */
  river: Float32Array;
  /** the quantity that reaches the top of the scale */
  top: number;
}

/** The island: liquidity as mountains, carved by the river of price, sinking into the sea at its coast. */
export function terrain(snaps: HeatmapSnapshot[], mids: { time: number; value: number }[], w: Window, cols = 120, rows = 80): Terrain {
  const qty = liquidityGrid(snaps, w, cols, rows);
  // only the real walls become peaks: most of the book is lowland
  const top = percentile(qty, 0.995) || 1;
  let m = new Float32Array(qty.length);
  for (let i = 0; i < qty.length; i++) m[i] = Math.pow(clamp01(qty[i] / top), 1.15);
  m = blur(blur(blur(m, cols, rows), cols, rows), cols, rows);
  const mTop = percentile(m, 0.995) || 1;
  for (let i = 0; i < m.length; i++) m[i] = clamp01(m[i] / mTop);
  const river = riverCols(mids, w, cols, rows);
  const h = new Float32Array(qty.length);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1);
      const v = r / (rows - 1);
      const mask = islandMask(u, v);
      // lowland green for ordinary depth; only the walls climb to orange and dark peaks
      let land = 0.04 + 0.09 * landNoise(u * 2, v * 2) + 0.9 * Math.pow(m[r * cols + c], 1.7);
      // the river carves its valley
      const rc = river[r];
      if (Number.isFinite(rc)) {
        const d = Math.abs(c - rc);
        if (d < 4) land *= 0.25 + 0.75 * (d / 4);
      }
      h[r * cols + c] = land * mask - (1 - mask) * 0.18;
    }
  return { cols, rows, h, qty, river, top };
}

export interface Light {
  /** 0..1 across the price window and the time span */
  u: number;
  v: number;
  /** 0..1 brightness */
  size: number;
  buy: boolean;
  price: number;
  qty: number;
  time: number;
}

/** Trades as lights on the island; the biggest 2 % are flagged for light pillars. */
export function lights(trades: Trade[], w: Window, max = 2500): { lights: Light[]; pillar: number } {
  const inw = trades.filter((t) => t.time >= w.t0 && t.time <= w.t1 && t.price >= w.lo && t.price < w.hi).slice(-max);
  const notional = inw.map((t) => t.price * t.qty);
  const p98 = percentile(notional, 0.98) || 1;
  const out = inw.map((t, i) => ({ u: (t.price - w.lo) / (w.hi - w.lo), v: (t.time - w.t0) / (w.t1 - w.t0), size: clamp01(Math.sqrt(notional[i] / p98)), buy: t.side === 'buy', price: t.price, qty: t.qty, time: t.time }));
  return { lights: out, pillar: p98 };
}

/** Volume traded per price column over the window. */
export function volumeByCol(trades: Trade[], w: Window, cols: number): Float32Array {
  const v = new Float32Array(cols);
  for (const t of trades) {
    if (t.time < w.t0 || t.time > w.t1 || t.price < w.lo || t.price >= w.hi) continue;
    v[Math.floor(((t.price - w.lo) / (w.hi - w.lo)) * cols)] += t.qty;
  }
  return v;
}

/** The book's nearest levels, grouped: n bars a side, nearest first. */
export function bookBars(bids: [number, number][], asks: [number, number][], n = 32, step = 0): { bids: number[]; asks: number[]; mid: number; step: number } {
  const bb = bids[0]?.[0];
  const ba = asks[0]?.[0];
  if (!(bb > 0) || !(ba > 0)) return { bids: [], asks: [], mid: NaN, step: 0 };
  const mid = (bb + ba) / 2;
  const s = step > 0 ? step : Math.max(mid * 0.0001, ba - bb);
  const side = (lv: [number, number][], dir: number) => {
    const out = new Array(n).fill(0);
    for (const [p, q] of lv) {
      const k = Math.floor(((p - mid) * dir) / s);
      if (k >= 0 && k < n) out[k] += q;
    }
    return out;
  };
  return { bids: side(bids, -1), asks: side(asks, 1), mid, step: s };
}

/** Returns over three horizons (1, 5 and 15 minutes), sampled across the last `minutes`: the volatility wave. */
export function volWave(mids: { time: number; value: number }[], now: number, minutes = 30, samples = 90): { curves: number[][]; scale: number; realized: number | null } {
  const H = [60_000, 300_000, 900_000];
  const at = (t: number) => {
    let lo = 0;
    let hi = mids.length - 1;
    if (hi < 0 || mids[0].time > t) return NaN;
    while (lo < hi) {
      const m = (lo + hi + 1) >>> 1;
      if (mids[m].time <= t) lo = m;
      else hi = m - 1;
    }
    return mids[lo].value;
  };
  const curves = H.map((h) =>
    Array.from({ length: samples }, (_, i) => {
      const t = now - minutes * 60_000 + (i / (samples - 1)) * minutes * 60_000;
      const a = at(t - h);
      const b = at(t);
      return Number.isFinite(a) && Number.isFinite(b) && a > 0 ? (b / a - 1) * 1e4 : 0;
    }),
  );
  const scale = Math.max(1, ...curves.flat().map(Math.abs));
  // realised volatility from 1-minute returns, annualised (crypto trades all year)
  const r1 = curves[0].filter((x) => x !== 0).map((x) => x / 1e4);
  let realized: number | null = null;
  if (r1.length > 5) {
    const mean = r1.reduce((a, b) => a + b, 0) / r1.length;
    const sd = Math.sqrt(r1.reduce((a, b) => a + (b - mean) ** 2, 0) / r1.length);
    realized = sd * Math.sqrt(365 * 24 * 60);
  }
  return { curves, scale, realized };
}

/** The tape as a cloud: time, price, size — each 0..1. */
export function tapeCloud(trades: Trade[], n = 1500): { x: number; y: number; z: number; buy: boolean }[] {
  const t = trades.slice(-n);
  if (t.length < 2) return [];
  const t0 = t[0].time;
  const t1 = t[t.length - 1].time || t0 + 1;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of t) {
    lo = Math.min(lo, x.price);
    hi = Math.max(hi, x.price);
  }
  const ln = t.map((x) => Math.log10(1 + x.price * x.qty));
  const lmax = Math.max(...ln) || 1;
  const lmin = Math.min(...ln);
  return t.map((x, i) => ({ x: (x.time - t0) / Math.max(1, t1 - t0), y: hi > lo ? (x.price - lo) / (hi - lo) : 0.5, z: lmax > lmin ? (ln[i] - lmin) / (lmax - lmin) : 0.5, buy: x.side === 'buy' }));
}

/** The volume profile over time: volume per (time slice, price column), 0..1. */
export function profileRidge(trades: Trade[], w: Window, cols = 40, slices = 10): { v: Float32Array; cols: number; slices: number; poc: number } {
  const v = new Float32Array(cols * slices);
  for (const t of trades) {
    if (t.time < w.t0 || t.time > w.t1 || t.price < w.lo || t.price >= w.hi) continue;
    const s = Math.min(slices - 1, Math.floor(((t.time - w.t0) / (w.t1 - w.t0)) * slices));
    v[s * cols + Math.floor(((t.price - w.lo) / (w.hi - w.lo)) * cols)] += t.qty;
  }
  const byCol = new Float32Array(cols);
  for (let s = 0; s < slices; s++) for (let c = 0; c < cols; c++) byCol[c] += v[s * cols + c];
  let poc = 0;
  for (let c = 1; c < cols; c++) if (byCol[c] > byCol[poc]) poc = c;
  const mx = Math.max(...v) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= mx;
  return { v, cols, slices, poc };
}

export interface GaugeRead {
  id: string;
  name: string;
  value: number;
  text: string;
  sub: string;
}

/** One gauge per agent of the crypto swarm, from its state and the live market. */
export function gauges(st: CSwarmState | null, coin: string, tape: { buyShare: number | null; spreadBps: number | null }): GaugeRead[] {
  const c = st?.coins.find((x) => x.coin === coin) ?? st?.coins[0] ?? null;
  const rec = (a: 'scalper' | 'auction' | 'trend') => st?.byAgent[a];
  const engine = (a: 'scalper' | 'auction') => {
    const r = rec(a);
    if (!st?.running) return { value: 0, text: 'off', sub: st?.cfg.agents[a] ? 'swarm stopped' : 'switched off' };
    if (r && r.trades >= 3) return { value: r.wins / r.trades, text: `${Math.round((r.wins / r.trades) * 100)}%`, sub: `won ${r.wins}/${r.trades}` };
    const warm = st.coins.filter((x) => x.engines[a]?.warm).length;
    return { value: st.coins.length ? warm / st.coins.length : 0, text: `${warm}/${st.coins.length}`, sub: warm === st.coins.length ? 'reading the tape' : 'learning value' };
  };
  const funding = c?.funding ?? null;
  const apr = funding !== null ? funding * 24 * 365 * 100 : null;
  const trust = st?.forest.trained ? st.forest.trained.n / (st.forest.trained.n + 40) : 0;
  const maxOpen = st?.cfg.risk.maxOpen ?? 2;
  const dayPct = st && st.equity !== null && st.book.dayStart > 0 ? ((st.equity - st.book.dayStart) / st.book.dayStart) * 100 : 0;
  const lossBudget = st ? clamp01(1 + Math.min(0, dayPct) / st.cfg.risk.dailyLossPct) : 1;
  const sc = engine('scalper');
  const au = engine('auction');
  return [
    { id: 'scalper', name: 'Scalper', ...sc },
    { id: 'auction', name: 'Auctioneer', ...au },
    { id: 'trend', name: 'Trend', value: c?.daily ? (c.daily.dir > 0 ? c.daily.up / 3 : (3 - c.daily.up) / 3) : 0, text: c?.daily ? (c.daily.dir > 0 ? `↑ ${c.daily.up}/3` : `↓ ${3 - c.daily.up}/3`) : '—', sub: c?.daily ? (c.daily.dir > 0 ? 'daily trend up' : 'daily trend down') : 'no daily read' },
    { id: 'tape', name: 'Tape', value: tape.buyShare ?? 0, text: tape.buyShare !== null ? `${Math.round(tape.buyShare * 100)}%` : '—', sub: tape.buyShare !== null ? (tape.buyShare >= 0.5 ? 'buyers lifting' : 'sellers hitting') : 'no trades yet' },
    { id: 'crowd', name: 'Crowd', value: apr !== null ? clamp01(Math.abs(apr) / 50) : 0, text: apr !== null ? `${apr.toFixed(0)}%` : '—', sub: apr === null ? 'no funding read' : apr >= 0 ? 'longs pay / yr' : 'shorts pay / yr' },
    { id: 'guardian', name: 'Guardian', value: tape.spreadBps !== null ? clamp01(1 - tape.spreadBps / 8) : 0, text: tape.spreadBps !== null ? `${tape.spreadBps.toFixed(1)}` : '—', sub: tape.spreadBps !== null ? (tape.spreadBps <= 8 ? 'spread bps · clear' : 'spread bps · VETO') : 'no book' },
    { id: 'forest', name: 'Forest', value: st?.forest.trained ? trust : clamp01((st?.forest.samples ?? 0) / 30) * 0.3, text: st?.forest.trained ? `${Math.round(trust * 100)}%` : `${st?.forest.samples ?? 0}/30`, sub: st?.forest.trained ? `trust · ${st.forest.trained.n} trades` : 'learning — prior' },
    { id: 'risk', name: 'Risk', value: lossBudget * (1 - (st?.open.length ?? 0) / Math.max(1, maxOpen) / 2), text: `${st?.open.length ?? 0}/${maxOpen}`, sub: `open · day ${dayPct >= 0 ? '+' : ''}${dayPct.toFixed(1)}%` },
  ];
}
