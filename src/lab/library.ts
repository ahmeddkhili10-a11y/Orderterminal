// The Strategy Lab's library: trading rules from the research in papers.ts,
// broken into parts the Lab can mix and match.
//
//   signals  say long (+1), short (−1) or nothing (0) at each bar's close.
//            A trade opens when a signal switches on; the next bar's open is
//            the entry, so no rule ever sees the bar it trades on.
//   filters  allow longs or shorts at a bar (trend, volatility regime, trend
//            strength, volume, session, funding crowding).
//   exits    an ATR stop, an optional target in R, a trailing stop, a time
//            limit, and whether an opposite signal closes the trade.
//
// Lookbacks are written in hours and converted to bars of the timeframe, so
// one rule runs on 1-hour, 4-hour or daily candles.
import { fitForest, fitRidge, predictForest, predictRidge, type ForestModel } from './ml';
import { adx, atr, ema, hiPrev, loPrev, logRets, pctRank, retN, rsi, rstd, rvol, sma, volZ, type Bar } from './series';

export interface Market {
  coin: string;
  /** hours per bar: 1, 4 or 24 */
  tfH: number;
  bars: Bar[];
  /** funding paid by longs per bar (a fraction of notional), aligned with bars; null when unknown */
  funding?: Float64Array | null;
}
export type Params = Record<string, number>;
export type Family = 'momentum' | 'trend' | 'breakout' | 'reversion' | 'carry' | 'seasonal' | 'volume' | 'ml';

export interface ExitSpec {
  /** stop distance in ATR(14) */
  stopAtr: number;
  /** target in R (multiples of the stop distance); 0 = no target */
  targetR: number;
  /** trailing stop in ATR once the trade is 1R up; 0 = none */
  trailAtr: number;
  /** close after this many bars */
  maxBars: number;
  /** an opposite signal closes the trade */
  onFlip: boolean;
}
export const EXIT_DEFAULT: ExitSpec = { stopAtr: 2, targetR: 0, trailAtr: 0, maxBars: 240, onFlip: true };

export interface Ctx {
  m: Market;
  cache: Map<string, unknown>;
  /** bars before this index are the training set (learned rules fit only on them) */
  trainEnd: number;
  seed: number;
}
export const ctxOf = (m: Market, trainEnd = m.bars.length, seed = 7): Ctx => ({ m, cache: new Map(), trainEnd, seed });

/** a lookback in hours as bars of the market's timeframe */
export const H = (c: Ctx, hours: number) => Math.max(2, Math.round(hours / c.m.tfH));
export const barsPerYear = (tfH: number) => (24 * 365) / tfH;

function cached<T>(c: Ctx, key: string, f: () => T): T {
  if (!c.cache.has(key)) c.cache.set(key, f());
  return c.cache.get(key) as T;
}
const close = (c: Ctx) => cached(c, 'close', () => Float64Array.from(c.m.bars, (b) => b.close));
const smaH = (c: Ctx, h: number) => cached(c, `sma${H(c, h)}`, () => sma(close(c), H(c, h)));
const sdH = (c: Ctx, h: number) => cached(c, `sd${H(c, h)}`, () => rstd(close(c), H(c, h)));
export const atr14 = (c: Ctx) => cached(c, 'atr14', () => atr(c.m.bars, 14));
const fundAnn = (c: Ctx, h: number) =>
  cached(c, `fund${H(c, h)}`, () => {
    const f = c.m.funding;
    if (!f) return null;
    const m = sma(f, H(c, h));
    const k = barsPerYear(c.m.tfH);
    return m.map((x) => x * k);
  });

const state = (n: number) => new Int8Array(n);
const sgn = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export interface SignalDef {
  id: string;
  name: string;
  family: Family;
  papers: string[];
  /** why it should work: the economic story */
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  /** only meaningful on bars shorter than a day */
  intraday?: boolean;
  /** exits that suit the rule (the search varies them) */
  exit: Partial<ExitSpec>;
  compute: (c: Ctx, p: Params) => Int8Array;
  describe: (p: Params) => string;
}

export interface FilterDef {
  id: string;
  name: string;
  papers: string[];
  rationale: string;
  grid: Record<string, number[]>;
  needsFunding?: boolean;
  compute: (c: Ctx, p: Params) => { long: Uint8Array; short: Uint8Array };
  describe: (p: Params) => string;
}

const hrs = (h: number) => (h >= 24 && h % 24 === 0 ? `${h / 24}-day` : `${h}-hour`);

// ---------- features for the learned rules and the meta-labeller ----------

export const FEATURES = ['ret 1h', 'ret 4h', 'ret 1d', 'ret 1w', 'price / 1w MA', 'RSI 14', 'ADX 14', 'vol 1d / vol 30d', 'volume z', 'hour (sin)', 'hour (cos)', 'weekday', 'funding (a year)'];

export function features(c: Ctx): Float64Array[] {
  return cached(c, 'features', () => {
    const cl = close(c);
    const r1 = retN(cl, H(c, 1));
    const r4 = retN(cl, H(c, 4));
    const r24 = retN(cl, H(c, 24));
    const r168 = retN(cl, H(c, 168));
    const ma = smaH(c, 168);
    const rs = rsi(cl, 14);
    const ad = adx(c.m.bars, 14);
    const v1 = rvol(cl, H(c, 24));
    const v30 = rvol(cl, H(c, 720));
    const vz = volZ(c.m.bars, H(c, 168));
    const fa = fundAnn(c, 24);
    return c.m.bars.map((b, i) => {
      const d = new Date(b.time);
      const h = d.getUTCHours();
      return Float64Array.from([r1[i], r4[i], r24[i], r168[i], cl[i] / ma[i] - 1, rs[i] / 100, ad[i] / 100, v30[i] > 0 ? v1[i] / v30[i] : NaN, vz[i], Math.sin((h / 24) * 2 * Math.PI), Math.cos((h / 24) * 2 * Math.PI), d.getUTCDay() / 6, fa ? fa[i] : 0]);
    });
  });
}
const finiteRow = (r: Float64Array) => r.every(Number.isFinite);

/** learned rules: fit on bars before trainEnd whose label is known by then */
function learnedSignal(c: Ctx, p: Params, kind: 'ols' | 'rf'): Int8Array {
  const n = c.m.bars.length;
  const out = state(n);
  const h = H(c, p.horizon);
  const X = features(c);
  const cl = close(c);
  const rows: number[][] = [];
  const ys: number[] = [];
  const step = Math.max(1, Math.floor(c.trainEnd / 4000));
  for (let i = 0; i + h < c.trainEnd; i += step) {
    if (!finiteRow(X[i])) continue;
    rows.push(Array.from(X[i]));
    ys.push(cl[i + h] / cl[i] - 1);
  }
  if (rows.length < 200) return out;
  if (kind === 'ols') {
    const m = fitRidge(rows, ys, 0.01);
    const fit = rows.map((r) => predictRidge(m, r));
    const sd = Math.sqrt(fit.reduce((a, b) => a + b * b, 0) / fit.length) || 1e-9;
    for (let i = 0; i < n; i++) {
      if (!finiteRow(X[i])) continue;
      const f = predictRidge(m, Array.from(X[i]));
      out[i] = Math.abs(f) > p.q * sd ? sgn(f) : 0;
    }
    return out;
  }
  const m: ForestModel = fitForest(
    rows,
    ys.map((y) => (y > 0 ? 1 : 0)),
    { trees: 40, maxDepth: 5, minLeaf: 20, seed: c.seed },
  );
  for (let i = 0; i < n; i++) {
    if (!finiteRow(X[i])) continue;
    const pr = predictForest(m, Array.from(X[i]));
    out[i] = pr > 0.5 + p.edge ? 1 : pr < 0.5 - p.edge ? -1 : 0;
  }
  return out;
}

// ---------- the signals ----------

export const SIGNALS: SignalDef[] = [
  {
    id: 'tsmom',
    name: 'Time-series momentum',
    family: 'momentum',
    papers: ['mop12', 'lt21', 'ks151'],
    rationale: 'Investors under-react to news and attention arrives slowly, so a coin that has risen over the past days to weeks tends to keep rising (and fallers keep falling).',
    grid: { lookback: [24, 72, 168, 336, 720] },
    exit: { stopAtr: 3, maxBars: 336, onFlip: true },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.lookback));
      return Int8Array.from(r, (x) => (Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `long when the last ${hrs(p.lookback)} return is positive, short when negative`,
  },
  {
    id: 'mac',
    name: 'Moving-average crossover',
    family: 'trend',
    papers: ['blr92', 'ks151', 'gas20', 'cels19'],
    rationale: 'A fast average above a slow one marks a trend the market is still pricing in; the rule rides it and steps aside when it turns.',
    grid: { fast: [12, 24, 50], slow: [100, 200, 400] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const f = smaH(c, p.fast);
      const s = smaH(c, p.slow);
      return Int8Array.from(f, (x, i) => (Number.isFinite(x) && Number.isFinite(s[i]) ? sgn(x - s[i]) : 0));
    },
    describe: (p) => `long while the ${hrs(p.fast)} average is above the ${hrs(p.slow)} average, short while below`,
  },
  {
    id: 'tma',
    name: 'Three moving averages',
    family: 'trend',
    papers: ['ks151'],
    rationale: 'Requiring three averages in order (fast > middle > slow) trades only established trends and filters the whipsaws of a single crossover.',
    grid: { set: [0, 1, 2] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      const f = smaH(c, a);
      const m = smaH(c, b);
      const s = smaH(c, d);
      return Int8Array.from(f, (x, i) => (x > m[i] && m[i] > s[i] ? 1 : x < m[i] && m[i] < s[i] ? -1 : 0));
    },
    describe: (p) => {
      const [a, b, d] = [
        [12, 48, 168],
        [24, 72, 240],
        [50, 100, 200],
      ][p.set];
      return `long when the ${hrs(a)} > ${hrs(b)} > ${hrs(d)} averages line up, short when they line up downward`;
    },
  },
  {
    id: 'maratio',
    name: 'Price-to-moving-average ratio',
    family: 'trend',
    papers: ['dlszz21'],
    rationale: 'With hard-to-value fundamentals, traders learn from price itself: the gap between price and its average carries information that is priced in slowly.',
    grid: { lookback: [168, 336, 720], band: [0, 0.02, 0.05] },
    exit: { stopAtr: 3, maxBars: 480, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (!Number.isFinite(m[i]) ? 0 : x / m[i] - 1 > p.band ? 1 : x / m[i] - 1 < -p.band ? -1 : 0));
    },
    describe: (p) => `long when price is more than ${(p.band * 100).toFixed(0)}% above its ${hrs(p.lookback)} average, short when as far below`,
  },
  {
    id: 'donchian',
    name: 'Channel breakout',
    family: 'breakout',
    papers: ['blr92', 'faith07', 'ks151', 'hu21'],
    rationale: 'A close beyond the range of the last N bars shows new information or forced buying/selling that the range did not hold; breakouts in crypto tend to extend.',
    grid: { n: [20, 55, 120, 240] },
    exit: { stopAtr: 2, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const n = H(c, p.n);
      const hi = cached(c, `hi${n}`, () => hiPrev(c.m.bars, n));
      const lo = cached(c, `lo${n}`, () => loPrev(c.m.bars, n));
      const out = state(c.m.bars.length);
      let s = 0;
      c.m.bars.forEach((b, i) => {
        if (b.close > hi[i]) s = 1;
        else if (b.close < lo[i]) s = -1;
        out[i] = s;
      });
      return out;
    },
    describe: (p) => `long after a close above the prior ${hrs(p.n)} high, short after a close below the prior ${hrs(p.n)} low`,
  },
  {
    id: 'pivot',
    name: 'Support and resistance (pivot points)',
    family: 'breakout',
    papers: ['ks151'],
    rationale: "Floor traders' pivot levels from yesterday's high, low and close are watched by many; a close through resistance or support triggers follow-through.",
    grid: { level: [1, 2] },
    intraday: true,
    exit: { stopAtr: 1.5, maxBars: 24, onFlip: true },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let day = -1;
      let dh = -Infinity;
      let dl = Infinity;
      let dc = NaN;
      let piv: [number, number] | null = null;
      c.m.bars.forEach((b, i) => {
        const d = Math.floor(b.time / 86_400_000);
        if (d !== day) {
          if (day >= 0 && Number.isFinite(dc)) {
            const P = (dh + dl + dc) / 3;
            piv = p.level === 1 ? [2 * P - dh, 2 * P - dl] : [P - (dh - dl), P + (dh - dl)];
          }
          day = d;
          dh = -Infinity;
          dl = Infinity;
        }
        if (piv) out[i] = b.close > piv[1] ? 1 : b.close < piv[0] ? -1 : 0;
        dh = Math.max(dh, b.high);
        dl = Math.min(dl, b.low);
        dc = b.close;
      });
      return out;
    },
    describe: (p) => `long on a close above yesterday's R${p.level} pivot resistance, short on a close below S${p.level} support`,
  },
  {
    id: 'zrev',
    name: 'Mean reversion (z-score)',
    family: 'reversion',
    papers: ['ks151', 'jeg90', 'lm90'],
    rationale: 'Short-horizon overreaction and liquidity demands push price too far from its average; liquidity providers are paid to take the other side as it reverts.',
    grid: { lookback: [24, 72, 168], k: [1.5, 2, 2.5] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => {
        const z = s[i] > 0 ? (x - m[i]) / s[i] : 0;
        return z < -p.k ? 1 : z > p.k ? -1 : 0;
      });
    },
    describe: (p) => `buy ${p.k} standard deviations below the ${hrs(p.lookback)} average, sell ${p.k} above`,
  },
  {
    id: 'rsi2',
    name: 'RSI extremes',
    family: 'reversion',
    papers: ['ca09', 'wil78'],
    rationale: 'Very short-term oversold readings mark capitulation by impatient sellers; the bounce rewards the buyer who supplies liquidity.',
    grid: { n: [2, 3, 14], band: [10, 20, 30] },
    exit: { stopAtr: 2, targetR: 1.5, maxBars: 24, onFlip: false },
    compute: (c, p) => {
      const r = cached(c, `rsi${p.n}`, () => rsi(close(c), p.n));
      return Int8Array.from(r, (x) => (x < p.band ? 1 : x > 100 - p.band ? -1 : 0));
    },
    describe: (p) => `buy when RSI(${p.n}) is under ${p.band}, sell when over ${100 - p.band}`,
  },
  {
    id: 'bbreak',
    name: 'Bollinger band breakout',
    family: 'breakout',
    papers: ['bol01', 'hu21'],
    rationale: 'A close outside two-sigma bands marks a volatility expansion; in trending crypto markets expansions tend to continue rather than revert.',
    grid: { lookback: [20, 50, 100], k: [2, 2.5] },
    exit: { stopAtr: 2, maxBars: 120, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const s = sdH(c, p.lookback);
      return Int8Array.from(cl, (x, i) => (x > m[i] + p.k * s[i] ? 1 : x < m[i] - p.k * s[i] ? -1 : 0));
    },
    describe: (p) => `long on a close above the upper ${p.k}σ band of the ${hrs(p.lookback)} average, short below the lower band`,
  },
  {
    id: 'macd',
    name: 'MACD trend',
    family: 'trend',
    papers: ['app05', 'hu21'],
    rationale: 'The gap between fast and slow exponential averages measures trend acceleration; its sign against its own signal line times entries in the trend.',
    grid: { scale: [1, 4, 24] },
    exit: { stopAtr: 2.5, maxBars: 240, onFlip: true },
    compute: (c, p) => {
      const cl = close(c);
      const f = ema(cl, H(c, 12 * p.scale));
      const s = ema(cl, H(c, 26 * p.scale));
      const macd = f.map((x, i) => x - s[i]);
      const sig = ema(Float64Array.from(macd, (x) => (Number.isFinite(x) ? x : 0)), H(c, 9 * p.scale));
      return Int8Array.from(macd, (x, i) => (Number.isFinite(x) && Number.isFinite(sig[i]) ? sgn(x - sig[i]) : 0));
    },
    describe: (p) => `long while MACD(${12 * p.scale}, ${26 * p.scale}) is above its ${9 * p.scale}-hour signal line, short while below`,
  },
  {
    id: 'itsm',
    name: 'Intraday time-series momentum',
    family: 'momentum',
    papers: ['suw22', 'wbxz22'],
    rationale: "Late-day traders (and those hedging the day's move) trade in the direction of the day so far, so the day's return predicts its final hours.",
    grid: { hour: [20, 21, 22] },
    intraday: true,
    exit: { stopAtr: 2, maxBars: 3, onFlip: false },
    compute: (c, p) => {
      const out = state(c.m.bars.length);
      let open = NaN;
      c.m.bars.forEach((b, i) => {
        const h = new Date(b.time).getUTCHours();
        if (h === 0) open = b.open;
        // the bar that closes at hour p.hour
        if (h + c.m.tfH === p.hour && Number.isFinite(open)) out[i] = sgn(b.close / open - 1);
      });
      return out;
    },
    describe: (p) => `at ${p.hour}:00 UTC, trade the day's direction so far into the close`,
  },
  {
    id: 'dow',
    name: 'Monday effect',
    family: 'seasonal',
    papers: ['cp19', 'bcgl19'],
    rationale: "Bitcoin's returns were reported higher on Mondays as weekday flows return after the weekend; the Lab tests whether it survives.",
    grid: { day: [1] },
    intraday: true,
    exit: { stopAtr: 3, maxBars: 24, onFlip: false },
    compute: (c) => {
      const out = state(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const t = new Date(b.time + c.m.tfH * 3_600_000);
        if (t.getUTCDay() === 1 && t.getUTCHours() === 0) out[i] = 1;
      });
      return out;
    },
    describe: () => 'long from Monday 00:00 UTC for the day',
  },
  {
    id: 'wrev',
    name: 'Weekly reversal',
    family: 'reversion',
    papers: ['dob23', 'jeg90'],
    rationale: "Last week's biggest moves partly reverse as overreaction fades, while two-to-four-week trends continue.",
    grid: { band: [0.05, 0.1, 0.15] },
    exit: { stopAtr: 3, targetR: 2, maxBars: 168, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, 168));
      return Int8Array.from(r, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `fade a week's move of more than ${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'carry',
    name: 'Funding carry',
    family: 'carry',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When leveraged longs pay high funding, shorting the perpetual collects the payment and leans against a crowded trade; negative funding pays longs.',
    grid: { lookback: [24, 72], band: [0.1, 0.25] },
    needsFunding: true,
    exit: { stopAtr: 3, maxBars: 168, onFlip: true },
    compute: (c, p) => {
      const f = fundAnn(c, p.lookback);
      if (!f) return state(c.m.bars.length);
      return Int8Array.from(f, (x) => (x > p.band ? -1 : x < -p.band ? 1 : 0));
    },
    describe: (p) => `short when funding averages more than ${(p.band * 100).toFixed(0)}% a year over ${hrs(p.lookback)}, long when below −${(p.band * 100).toFixed(0)}%`,
  },
  {
    id: 'volbrk',
    name: 'Volume-confirmed move',
    family: 'volume',
    papers: ['lmsw02', 'beo94'],
    rationale: 'A price move on unusually heavy volume is more likely informed and continues; the same move on light volume says little.',
    grid: { n: [1, 4, 24], k: [1.5, 2.5] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: false },
    compute: (c, p) => {
      const r = retN(close(c), H(c, p.n));
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      return Int8Array.from(r, (x, i) => (vz[i] > p.k && Number.isFinite(x) ? sgn(x) : 0));
    },
    describe: (p) => `trade the ${hrs(p.n)} move when volume is ${p.k} standard deviations above normal`,
  },
  {
    id: 'ols',
    name: 'Linear forecast (ridge regression)',
    family: 'ml',
    papers: ['gkx20', 'ks151'],
    rationale: 'A regression of the next return on momentum, reversal, volatility, volume, seasonality and funding combines weak predictors into one forecast (the linear analogue of the 151-strategies bitcoin ANN).',
    grid: { horizon: [4, 24], q: [0.5, 1] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `ols${p.horizon}:${p.q}:${c.trainEnd}`, () => learnedSignal(c, p, 'ols')),
    describe: (p) => `ridge regression of the next ${hrs(p.horizon)} return on 13 features; trade forecasts beyond ${p.q} standard deviations`,
  },
  {
    id: 'rf',
    name: 'Random-forest direction',
    family: 'ml',
    papers: ['bre01', 'gkx20'],
    rationale: 'Trees find nonlinear interactions between the same features (e.g. momentum only when volatility is low) that a linear forecast misses.',
    grid: { horizon: [4, 24], edge: [0.03, 0.06] },
    exit: { stopAtr: 2, maxBars: 48, onFlip: true },
    compute: (c, p) => cached(c, `rf${p.horizon}:${p.edge}:${c.trainEnd}`, () => learnedSignal(c, p, 'rf')),
    describe: (p) => `random forest (40 trees) on 13 features forecasting the ${hrs(p.horizon)} direction; trade when its odds exceed ${(50 + p.edge * 100).toFixed(0)}%`,
  },
];

// ---------- the filters ----------

const allow = (n: number) => ({ long: new Uint8Array(n), short: new Uint8Array(n) });

export const FILTERS: FilterDef[] = [
  {
    id: 'trend',
    name: 'Long-term trend',
    papers: ['fab07', 'blr92'],
    rationale: 'Trade only with the long-term trend: longs above the long average, shorts below — the side with the drift behind it.',
    grid: { lookback: [200, 1200, 4800] },
    compute: (c, p) => {
      const cl = close(c);
      const m = smaH(c, p.lookback);
      const a = allow(cl.length);
      cl.forEach((x, i) => {
        a.long[i] = Number.isFinite(m[i]) && x > m[i] ? 1 : 0;
        a.short[i] = Number.isFinite(m[i]) && x < m[i] ? 1 : 0;
      });
      return a;
    },
    describe: (p) => `with the ${hrs(p.lookback)} trend`,
  },
  {
    id: 'volreg',
    name: 'Volatility regime',
    papers: ['mm17', 'bsc15'],
    rationale: 'High volatility does not pay more but crashes trend strategies; calm regimes trade, storms wait (or the reverse for breakouts that need movement).',
    grid: { mode: [0, 1], pct: [0.5, 0.8] },
    compute: (c, p) => {
      const v = cached(c, 'vol24', () => rvol(close(c), H(c, 24)));
      const r = cached(c, 'volrank', () => pctRank(v, H(c, 720)));
      const a = allow(v.length);
      r.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x < p.pct : x > 1 - p.pct);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when 1-day volatility is in the calmest ${p.pct * 100}% of the month` : `only when 1-day volatility is in the busiest ${p.pct * 100}% of the month`),
  },
  {
    id: 'adx',
    name: 'Trend strength (ADX)',
    papers: ['wil78'],
    rationale: 'Trend rules need a trend and reversion rules need a range; ADX separates the two.',
    grid: { mode: [0, 1], level: [20, 25] },
    compute: (c, p) => {
      const d = cached(c, 'adx14', () => adx(c.m.bars, 14));
      const a = allow(d.length);
      d.forEach((x, i) => {
        const ok = Number.isFinite(x) && (p.mode === 0 ? x > p.level : x < p.level);
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.mode === 0 ? `only when ADX is above ${p.level} (trending)` : `only when ADX is below ${p.level} (ranging)`),
  },
  {
    id: 'volume',
    name: 'Participation',
    papers: ['beo94'],
    rationale: 'Signals on above-normal volume carry more information than signals in a quiet market.',
    grid: { k: [0, 0.5] },
    compute: (c, p) => {
      const vz = cached(c, 'vz', () => volZ(c.m.bars, H(c, 168)));
      const a = allow(vz.length);
      vz.forEach((x, i) => (a.long[i] = a.short[i] = x > p.k ? 1 : 0));
      return a;
    },
    describe: (p) => `only on volume ${p.k} standard deviations or more above normal`,
  },
  {
    id: 'session',
    name: 'Trading session',
    papers: ['bcgl19', 'wbxz22'],
    rationale: 'Liquidity and informed flow concentrate when the US and European markets are open; signals then are more reliable.',
    grid: { s: [0, 1] },
    compute: (c, p) => {
      const a = allow(c.m.bars.length);
      c.m.bars.forEach((b, i) => {
        const h = new Date(b.time).getUTCHours();
        const ok = p.s === 0 ? h >= 13 && h < 21 : h >= 7 && h < 16;
        a.long[i] = a.short[i] = ok ? 1 : 0;
      });
      return a;
    },
    describe: (p) => (p.s === 0 ? 'only in US hours (13–21 UTC)' : 'only in European hours (7–16 UTC)'),
  },
  {
    id: 'crowd',
    name: 'Funding crowding',
    papers: ['hmrw22', 'crszj23'],
    rationale: 'When one side pays heavily to hold, it is crowded: do not join it.',
    grid: { band: [0.2, 0.5] },
    needsFunding: true,
    compute: (c, p) => {
      const f = fundAnn(c, 24);
      const n = c.m.bars.length;
      const a = allow(n);
      for (let i = 0; i < n; i++) {
        const x = f ? f[i] : 0;
        a.long[i] = !Number.isFinite(x) || x < p.band ? 1 : 0;
        a.short[i] = !Number.isFinite(x) || x > -p.band ? 1 : 0;
      }
      return a;
    },
    describe: (p) => `no longs when funding is above ${(p.band * 100).toFixed(0)}% a year, no shorts below −${(p.band * 100).toFixed(0)}%`,
  },
];

export const SIGNAL_MAP = Object.fromEntries(SIGNALS.map((s) => [s.id, s]));
export const FILTER_MAP = Object.fromEntries(FILTERS.map((f) => [f.id, f]));

/** every combination of a parameter grid */
export function gridOf(g: Record<string, number[]>): Params[] {
  let out: Params[] = [{}];
  for (const [k, vs] of Object.entries(g)) out = out.flatMap((p) => vs.map((v) => ({ ...p, [k]: v })));
  return out;
}

export const logRet = logRets;
