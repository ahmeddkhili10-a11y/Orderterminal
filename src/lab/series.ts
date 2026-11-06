// The Strategy Lab's arithmetic on candles: moving averages, volatility,
// oscillators and channels. Every series is a Float64Array as long as the
// bars, NaN until it has enough history, and value i uses bars 0..i only —
// nothing here looks ahead.

export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const closes = (b: Bar[]) => Float64Array.from(b, (x) => x.close);

export function sma(x: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(x: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let e = NaN;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue;
    e = Number.isFinite(e) ? e + k * (x[i] - e) : x[i];
    if (i >= n - 1) out[i] = e;
  }
  return out;
}

/** rolling standard deviation (population) */
export function rstd(x: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  let s = 0;
  let q = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    q += x[i] * x[i];
    if (i >= n) {
      s -= x[i - n];
      q -= x[i - n] * x[i - n];
    }
    if (i >= n - 1) out[i] = Math.sqrt(Math.max(0, q / n - (s / n) ** 2));
  }
  return out;
}

/** simple return over n bars */
export function retN(c: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  for (let i = n; i < c.length; i++) out[i] = c[i] / c[i - n] - 1;
  return out;
}

/** log returns, bar to bar (0 for the first bar) */
export function logRets(c: ArrayLike<number>): Float64Array {
  const out = new Float64Array(c.length);
  for (let i = 1; i < c.length; i++) out[i] = Math.log(c[i] / c[i - 1]);
  return out;
}

/** realised volatility: rolling std of log returns over n bars */
export const rvol = (c: ArrayLike<number>, n: number) => rstd(logRets(c), n);

/** Wilder's RSI */
export function rsi(c: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(c.length).fill(NaN);
  let up = 0;
  let dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    const u = Math.max(0, d);
    const w = Math.max(0, -d);
    if (i <= n) {
      up += u / n;
      dn += w / n;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + w) / n;
    }
    if (i >= n) out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}

/** Wilder's average true range */
export function atr(b: Bar[], n: number): Float64Array {
  const out = new Float64Array(b.length).fill(NaN);
  let a = 0;
  for (let i = 1; i < b.length; i++) {
    const tr = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    a = i <= n ? a + tr / n : (a * (n - 1) + tr) / n;
    if (i >= n) out[i] = a;
  }
  return out;
}

/** Wilder's ADX: trend strength 0–100 */
export function adx(b: Bar[], n: number): Float64Array {
  const out = new Float64Array(b.length).fill(NaN);
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  let ax = NaN;
  for (let i = 1; i < b.length; i++) {
    const up = b[i].high - b[i - 1].high;
    const dn = b[i - 1].low - b[i].low;
    const t = Math.max(b[i].high - b[i].low, Math.abs(b[i].high - b[i - 1].close), Math.abs(b[i].low - b[i - 1].close));
    const p = up > dn && up > 0 ? up : 0;
    const m = dn > up && dn > 0 ? dn : 0;
    tr = i <= n ? tr + t : tr - tr / n + t;
    pdm = i <= n ? pdm + p : pdm - pdm / n + p;
    mdm = i <= n ? mdm + m : mdm - mdm / n + m;
    if (i < n) continue;
    const pdi = tr ? (100 * pdm) / tr : 0;
    const mdi = tr ? (100 * mdm) / tr : 0;
    const dx = pdi + mdi ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    ax = Number.isFinite(ax) ? (ax * (n - 1) + dx) / n : dx;
    if (i >= 2 * n) out[i] = ax;
  }
  return out;
}

/** highest high of the n bars before i (not including i) */
export function hiPrev(b: Bar[], n: number): Float64Array {
  const out = new Float64Array(b.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= n) out[i] = b[dq[0]].high;
    // add bar i for the windows that follow
    while (dq.length && b[dq[dq.length - 1]].high <= b[i].high) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
  }
  return out;
}

/** lowest low of the n bars before i (not including i) */
export function loPrev(b: Bar[], n: number): Float64Array {
  const out = new Float64Array(b.length).fill(NaN);
  const dq: number[] = [];
  for (let i = 0; i < b.length; i++) {
    if (i >= n) out[i] = b[dq[0]].low;
    while (dq.length && b[dq[dq.length - 1]].low >= b[i].low) dq.pop();
    dq.push(i);
    while (dq[0] <= i - n) dq.shift();
  }
  return out;
}

/** where x[i] ranks among the last n values (0 lowest … 1 highest) */
export function pctRank(x: ArrayLike<number>, n: number): Float64Array {
  const out = new Float64Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    if (!Number.isFinite(x[i])) continue;
    let below = 0;
    let seen = 0;
    for (let j = i - n + 1; j <= i; j++) {
      if (!Number.isFinite(x[j])) continue;
      seen++;
      if (x[j] < x[i]) below++;
    }
    if (seen > n / 2) out[i] = below / (seen - 1 || 1);
  }
  return out;
}

/** z-score of volume against its rolling mean and spread */
export function volZ(b: Bar[], n: number): Float64Array {
  const v = Float64Array.from(b, (x) => Math.log(1 + x.volume));
  const m = sma(v, n);
  const s = rstd(v, n);
  return v.map((x, i) => (s[i] > 0 ? (x - m[i]) / s[i] : NaN));
}
