// The instrument report: "ASK SOL" — everything the terminal can say about a
// coin right now, in one place and in plain English.
//
// It reads the coin's daily candles (a year and a half), its hourly candles
// (six weeks), bitcoin's daily candles, the live feed's numbers (funding, open
// interest, the long/short ratio), the last hour of trades, liquidations and
// the news, and works out:
//
//   performance   1 day to 1 year, the 52-week range, the fall from the high
//   trend         the moving averages, ADX, RSI, the 17-indicator trend vote,
//                 the trend's t-statistic
//   regime        calm or turbulent (a hidden Markov model), trending or
//                 mean-reverting (Hurst, variance ratio)
//   volatility    GARCH now against its long-run level, realised volatility
//                 and its rank in the year, value at risk
//   forecast      GARCH price ranges for a day and a week (68 % and 95 %),
//                 the next hourly candle with its out-of-sample record
//   levels        yesterday's pivots, the swing highs and lows either side,
//                 the volume profile (point of control, value area), VWAP
//   vs bitcoin    beta, correlation, R², alpha, out- or under-performance
//   positioning   funding and its APR, open interest, long/short accounts,
//                 basis, the last hour's order flow, liquidations
//   news          headlines that mention the coin and their tone
//
// and then a verdict for two horizons — the next hours to days, and the
// coming weeks — as a weighted vote of signals that each say why they voted.
// Every signal is one the research behind the Lab supports (time-series
// momentum, trend following, the 200-day average, crowded funding …); none of
// it is a promise, and the report says so.
import type { NewsItem } from '../core/types';
import { candleForecast, type CandleReport } from '../lab/candles';
import { errQuantile, fitBest, horizonVol, valueAtRisk, type GarchFit } from '../lab/garch';
import { ctxOf, trendScore, TREND_VOTES } from '../lab/library';
import { capm, fitHmm2, hmmDuration, hmmFilter, hurstRS, trendT, varianceRatio } from '../lab/quant';
import { adx, ema, rsi, sma, type Bar } from '../lab/series';

export { COIN_NAMES, coinOf, namesOf } from './coinNames';
import { namesOf } from './coinNames';

// ---------- the inputs ----------

export interface LiveStats {
  last?: number;
  change24hPct?: number;
  high24h?: number;
  low24h?: number;
  volume24hUsd?: number;
  fundingRate?: number;
  fundingIntervalH?: number;
  openInterestUsd?: number;
  /** open interest change over the time the feed has seen, as a fraction */
  oiChange?: number;
  oiChangeHours?: number;
  longShortRatio?: number;
  longAccount?: number;
  markPrice?: number;
  indexPrice?: number;
  /** the venue's name, for the words */
  venue?: string;
  perp?: boolean;
}

export interface FlowWindow {
  buyUsd: number;
  sellUsd: number;
  trades: number;
  minutes: number;
}

export interface LiqWindow {
  longUsd: number;
  shortUsd: number;
  hours: number;
}

export interface ReportInput {
  coin: string;
  daily: Bar[];
  hourly: Bar[];
  btcDaily?: Bar[] | null;
  live?: LiveStats | null;
  flow?: FlowWindow | null;
  liqs?: LiqWindow | null;
  news?: NewsItem[];
  now?: number;
  /** fit the next-candle forest (a moment of work); off in quick tests */
  candles?: boolean;
  /** a next-candle forecast already fitted (the panel fits it once per new candle) */
  candle?: CandleReport | null;
}

// ---------- the output ----------

export type Horizon = 'short' | 'medium';

export interface Signal {
  id: string;
  name: string;
  horizon: Horizon;
  /** +1 bullish, −1 bearish, 0 neutral; fractions for partial votes */
  vote: number;
  weight: number;
  /** the reading, short (e.g. "+18 % above") */
  value: string;
  /** why it votes the way it does, in a sentence */
  why: string;
}

export type Lean = 'Bullish' | 'Leaning bullish' | 'Neutral' | 'Leaning bearish' | 'Bearish';

export interface Verdict {
  horizon: Horizon;
  /** −1 … +1: the weighted balance of the votes */
  score: number;
  lean: Lean;
  /** share of the weight that agrees with the lean (how one-sided the vote is) */
  agreement: number;
  signals: Signal[];
  /** one sentence: the lean and its strongest reasons */
  text: string;
}

export interface Range {
  lo68: number;
  hi68: number;
  lo95: number;
  hi95: number;
  /** one standard deviation of the move, as a fraction */
  sd: number;
}

export interface Level {
  price: number;
  kind: string;
  /** distance from the price now, as a fraction (+ above) */
  dist: number;
}

export interface InstrumentReport {
  coin: string;
  price: number;
  asOf: number;
  /** days of daily history behind the report */
  days: number;
  perf: { label: string; pct: number }[];
  range52: { hi: number; lo: number; fromHi: number; fromLo: number; pos: number } | null;
  short: Verdict;
  medium: Verdict;
  trend: {
    ma20: number;
    ma50: number;
    ma200: number;
    adx: number;
    rsiD: number;
    rsiH: number;
    scoreD: number;
    scoreH: number;
    tStat: number;
    words: string;
  };
  regime: { turbulentP: number; calmDays: number; turbDays: number; hurst: number; vr: number; vrZ: number; label: string; words: string };
  vol: { nowAnn: number; longAnn: number; rv7: number; rv30: number; rank: number; dayMove: number; var95: number; var99: number; halfLife: number; words: string } | null;
  forecast: { day: Range | null; week: Range | null; candle: CandleReport | null };
  levels: { pivot: { p: number; r1: number; r2: number; s1: number; s2: number } | null; above: Level[]; below: Level[]; poc: number; vah: number; val: number; vwap7: number };
  vsBtc: { beta: number; corr: number; r2: number; alphaAnn: number; rel30: number; rel90: number; words: string } | null;
  positioning: {
    fundingPct: number;
    fundingApr: number;
    oiUsd: number;
    oiChange: number;
    oiChangeHours: number;
    longShort: number;
    longAccount: number;
    basisBps: number;
    flow: FlowWindow | null;
    liqs: LiqWindow | null;
    words: string;
  } | null;
  news: { items: NewsItem[]; tone: number; good: number; bad: number; words: string };
  /** the report in a paragraph */
  summary: string[];
  /** what the report could not work out, and why */
  gaps: string[];
}

// ---------- small helpers ----------

const last = (x: ArrayLike<number>) => {
  for (let i = x.length - 1; i >= 0; i--) if (Number.isFinite(x[i])) return x[i];
  return NaN;
};
const fin = Number.isFinite;
const sd = (x: number[]) => {
  if (x.length < 2) return NaN;
  const m = x.reduce((a, b) => a + b, 0) / x.length;
  return Math.sqrt(x.reduce((a, b) => a + (b - m) ** 2, 0) / (x.length - 1));
};
const logRets = (b: Bar[]) => b.slice(1).map((x, i) => Math.log(x.close / b[i].close));
const pctS = (x: number, d = 1) => (fin(x) ? `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)} %` : '—');
const pctU = (x: number, d = 0) => (fin(x) ? `${(x * 100).toFixed(d)} %` : '—');

/** a compact price for the sentences (the panel formats its own) */
export function px(p: number): string {
  if (!fin(p)) return '—';
  const d = p >= 1000 ? 0 : p >= 10 ? 2 : p >= 1 ? 3 : p >= 0.01 ? 5 : 8;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/** the change over n days, from the daily closes (the last close is the price now) */
function changeOver(daily: Bar[], price: number, days: number): number {
  const i = daily.length - 1 - days;
  return i >= 0 && daily[i].close > 0 ? price / daily[i].close - 1 : NaN;
}

const leanOf = (s: number): Lean => (s >= 0.45 ? 'Bullish' : s >= 0.15 ? 'Leaning bullish' : s <= -0.45 ? 'Bearish' : s <= -0.15 ? 'Leaning bearish' : 'Neutral');

export function verdictOf(horizon: Horizon, signals: Signal[]): Verdict {
  const live = signals.filter((s) => s.weight > 0 && fin(s.vote));
  const W = live.reduce((a, s) => a + s.weight, 0);
  const score = W > 0 ? live.reduce((a, s) => a + s.vote * s.weight, 0) / W : 0;
  const lean = leanOf(score);
  const dir = Math.sign(score);
  const agree = W > 0 && dir !== 0 ? live.filter((s) => Math.sign(s.vote) === dir).reduce((a, s) => a + s.weight, 0) / W : 0;
  const top = [...live].filter((s) => (dir === 0 ? s.vote !== 0 : Math.sign(s.vote) === dir)).sort((a, b) => Math.abs(b.vote) * b.weight - Math.abs(a.vote) * a.weight);
  const against = [...live].filter((s) => dir !== 0 && Math.sign(s.vote) === -dir).sort((a, b) => Math.abs(b.vote) * b.weight - Math.abs(a.vote) * a.weight);
  const when = horizon === 'short' ? 'For the next hours to days' : 'For the coming weeks';
  let text: string;
  if (!live.length) text = `${when} there is not enough data to vote.`;
  else if (lean === 'Neutral')
    text = `${when} the signals are mixed — no clear lean${top.length ? ` (${top
      .slice(0, 2)
      .map((s) => s.name.toLowerCase())
      .join(' and ')} pull in different directions)` : ''}.`;
  else
    text = `${when}: ${lean.toLowerCase()} — ${top
      .slice(0, 3)
      .map((s) => s.name.toLowerCase())
      .join(', ')}${against.length ? `; against it: ${against
      .slice(0, 2)
      .map((s) => s.name.toLowerCase())
      .join(', ')}` : ''}.`;
  return { horizon, score, lean, agreement: agree, signals, text };
}

// ---------- the parts ----------

/** GARCH ranges for a horizon of `steps` daily bars */
function rangeOf(fit: GarchFit, price: number, steps: number): Range {
  const s = horizonVol(fit, fit.nextVar, steps);
  const m = fit.mu * steps;
  const z16 = errQuantile(fit, 0.16);
  const z84 = errQuantile(fit, 0.84);
  const z025 = errQuantile(fit, 0.025);
  const z975 = errQuantile(fit, 0.975);
  return { lo68: price * Math.exp(m + z16 * s), hi68: price * Math.exp(m + z84 * s), lo95: price * Math.exp(m + z025 * s), hi95: price * Math.exp(m + z975 * s), sd: s };
}

/** volume at price over hourly bars: the point of control and the 70 % value area */
export function volumeProfile(bars: Bar[], bins = 60): { poc: number; vah: number; val: number } {
  if (bars.length < 10) return { poc: NaN, vah: NaN, val: NaN };
  const lo = Math.min(...bars.map((b) => b.low));
  const hi = Math.max(...bars.map((b) => b.high));
  if (!(hi > lo)) return { poc: lo, vah: hi, val: lo };
  const w = (hi - lo) / bins;
  const v = new Float64Array(bins);
  for (const b of bars) {
    // spread each bar's volume evenly over the bins its range covers
    const a = Math.max(0, Math.min(bins - 1, Math.floor((b.low - lo) / w)));
    const z = Math.max(0, Math.min(bins - 1, Math.floor((b.high - lo) / w)));
    const per = b.volume / (z - a + 1);
    for (let i = a; i <= z; i++) v[i] += per;
  }
  let p = 0;
  for (let i = 1; i < bins; i++) if (v[i] > v[p]) p = i;
  const total = v.reduce((a, b) => a + b, 0);
  let a = p;
  let z = p;
  let got = v[p];
  while (got < total * 0.7 && (a > 0 || z < bins - 1)) {
    const down = a > 0 ? v[a - 1] : -1;
    const up = z < bins - 1 ? v[z + 1] : -1;
    if (up >= down) got += v[++z];
    else got += v[--a];
  }
  return { poc: lo + (p + 0.5) * w, vah: lo + (z + 1) * w, val: lo + a * w };
}

/** swing highs and lows (a bar higher, or lower, than the k bars either side) */
export function swings(bars: Bar[], k = 3): { highs: number[]; lows: number[] } {
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let h = true;
    let l = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (bars[j].high >= bars[i].high) h = false;
      if (bars[j].low <= bars[i].low) l = false;
    }
    if (h) highs.push(bars[i].high);
    if (l) lows.push(bars[i].low);
  }
  return { highs, lows };
}

const GOOD = /\b(surge|surges|soar|soars|rall(y|ies)|jumps?|gains?|record high|all-time high|ath|approv(e|ed|al)|launch(es|ed)?|partner(s|ship)?|adopt(s|ion)|upgrade[sd]?|inflows?|buy(s|ing)? back|bullish|breakout|listing|lists|integrat(es|ion)|etf filing|accumulat(e|es|ion)|wins?)\b/i;
const BAD = /\b(hack(ed|s)?|exploit(ed|s)?|drain(ed|s)?|lawsuit|sues?|sued|charges?|fraud|delist(s|ed|ing)?|outage|halt(s|ed)?|plunge[sd]?|crash(es|ed)?|dump(s|ed)?|slump(s|ed)?|tumbles?|falls?|drops?|outflows?|bearish|ban(s|ned)?|investigat(es|ion)|liquidat(ed|ions?)|sell-?off|selling|rug|scam|vulnerabilit(y|ies)|bankrupt(cy)?|fine[sd]?|warns?)\b/i;

/** the news about a coin: headlines that tag it or name it, and their tone (+1 good, −1 bad) */
export function newsFor(coin: string, items: NewsItem[], now: number, hours = 72): { items: NewsItem[]; tone: number; good: number; bad: number } {
  const names = namesOf(coin);
  const re = new RegExp(`(^|[^A-Z0-9])(${names.map((n) => n.replace(/[^A-Z0-9]/g, '')).join('|')})([^A-Z0-9]|$)`);
  const mine = items.filter((n) => now - n.time <= hours * 3_600_000 && (n.coins.map((c) => c.toUpperCase()).includes(coin) || re.test(n.title.toUpperCase())));
  let good = 0;
  let bad = 0;
  for (const n of mine) {
    const g = GOOD.test(n.title);
    const b = BAD.test(n.title);
    if (g && !b) good++;
    else if (b && !g) bad++;
  }
  const tone = good + bad ? (good - bad) / (good + bad) : 0;
  return { items: mine.sort((a, b) => b.time - a.time).slice(0, 25), tone, good, bad };
}

/** headline tone of one item: +1, −1 or 0 */
export const toneOf = (title: string) => {
  const g = GOOD.test(title);
  const b = BAD.test(title);
  return g && !b ? 1 : b && !g ? -1 : 0;
};

// ---------- the report ----------

export function buildReport(inp: ReportInput): InstrumentReport {
  const now = inp.now ?? Date.now();
  const coin = inp.coin.toUpperCase();
  const D = inp.daily.filter((b) => b.close > 0);
  const Hh = inp.hourly.filter((b) => b.close > 0);
  const L = inp.live ?? {};
  const gaps: string[] = [];
  const price = fin(L.last) && L.last! > 0 ? L.last! : Hh.length ? Hh[Hh.length - 1].close : D.length ? D[D.length - 1].close : NaN;
  const dClose = Float64Array.from(D, (b) => b.close);
  const hClose = Float64Array.from(Hh, (b) => b.close);
  if (D.length < 60) gaps.push(`only ${D.length} days of daily candles — the long averages, the regime and the yearly numbers need more`);
  if (Hh.length < 100) gaps.push('too few hourly candles for the short-term reading');

  // ---- performance ----
  const hAgo = (h: number) => {
    const i = Hh.length - 1 - h;
    return i >= 0 ? price / Hh[i].close - 1 : NaN;
  };
  const ch24 = fin(L.change24hPct) ? L.change24hPct! / 100 : hAgo(24);
  const ytdStart = new Date(Date.UTC(new Date(now).getUTCFullYear(), 0, 1)).getTime();
  const ytdBar = D.find((b) => b.time >= ytdStart);
  const perf = [
    { label: '1 hour', pct: hAgo(1) },
    { label: '24 hours', pct: ch24 },
    { label: '7 days', pct: changeOver(D, price, 7) },
    { label: '30 days', pct: changeOver(D, price, 30) },
    { label: '90 days', pct: changeOver(D, price, 90) },
    { label: '1 year', pct: changeOver(D, price, 365) },
    { label: 'Year to date', pct: ytdBar && ytdBar.time - ytdStart < 3 * 86_400_000 ? price / ytdBar.open - 1 : NaN },
  ];
  const yr = D.slice(-365);
  const range52 = yr.length >= 30
    ? (() => {
        const hi = Math.max(...yr.map((b) => b.high), price);
        const lo = Math.min(...yr.map((b) => b.low), price);
        return { hi, lo, fromHi: price / hi - 1, fromLo: price / lo - 1, pos: hi > lo ? (price - lo) / (hi - lo) : NaN };
      })()
    : null;

  // ---- trend ----
  const ma20 = last(sma(dClose, 20));
  const ma50 = last(sma(dClose, 50));
  const ma200 = D.length >= 200 ? last(sma(dClose, 200)) : NaN;
  const adxD = D.length > 40 ? last(adx(D, 14)) : NaN;
  const rsiD = D.length > 20 ? last(rsi(dClose, 14)) : NaN;
  const rsiH = Hh.length > 20 ? last(rsi(hClose, 14)) : NaN;
  const scoreD = D.length >= 210 ? last(trendScore(ctxOf({ coin, tfH: 24, bars: D }), 24)) : NaN;
  const scoreH = Hh.length >= 210 ? last(trendScore(ctxOf({ coin, tfH: 1, bars: Hh }), 1)) : NaN;
  const tStat = D.length >= 60 ? last(trendT(Float64Array.from(dClose, Math.log), Math.min(90, D.length))) : NaN;
  const trendWords = (() => {
    if (!fin(ma50)) return 'Too little history for the moving averages.';
    const parts: string[] = [];
    if (fin(ma200)) parts.push(`${price > ma200 ? 'above' : 'below'} its 200-day average (${pctS(price / ma200 - 1)})`);
    parts.push(`${price > ma50 ? 'above' : 'below'} its 50-day (${pctS(price / ma50 - 1)})`);
    const cross = fin(ma200) ? (ma50 > ma200 ? 'the 50-day is above the 200-day (a “golden cross” setup)' : 'the 50-day is below the 200-day (a “death cross” setup)') : '';
    const strength = fin(adxD) ? (adxD >= 25 ? `ADX ${adxD.toFixed(0)}: a strong trend` : adxD >= 18 ? `ADX ${adxD.toFixed(0)}: a modest trend` : `ADX ${adxD.toFixed(0)}: no real trend, the price is ranging`) : '';
    return `Price is ${parts.join(' and ')}${cross ? `; ${cross}` : ''}${strength ? `. ${strength}` : ''}.`;
  })();

  // ---- regime ----
  const dr = logRets(D);
  const drY = dr.slice(-500);
  let turbulentP = NaN;
  let calmDays = NaN;
  let turbDays = NaN;
  if (drY.length >= 120) {
    const hm = fitHmm2(drY);
    if (hm) {
      turbulentP = last(hmmFilter(hm, drY));
      [calmDays, turbDays] = hmmDuration(hm);
    }
  }
  const hurst = drY.length >= 100 ? hurstRS(drY) : NaN;
  const vrw = Math.min(250, drY.length - 6);
  const vr = vrw >= 60 ? varianceRatio(drY, 5, vrw) : null;
  const vrNow = vr ? last(vr.vr) : NaN;
  const vrZ = vr ? last(vr.z) : NaN;
  const trending = (fin(hurst) && hurst > 0.55) || (fin(vrZ) && vrZ > 1.96);
  const reverting = (fin(hurst) && hurst < 0.45) || (fin(vrZ) && vrZ < -1.96);
  const label = `${fin(turbulentP) ? (turbulentP > 0.5 ? 'Turbulent' : 'Calm') : '—'} · ${trending ? 'trending' : reverting ? 'mean-reverting' : 'random-walk-like'}`;
  const sure = Math.min(0.99, turbulentP > 0.5 ? turbulentP : 1 - turbulentP);
  const spell = turbulentP > 0.5 ? turbDays : calmDays;
  const spellWords = !fin(spell) ? '' : spell > 365 ? 'such spells have lasted many months' : `such spells last about ${Math.max(1, Math.round(spell))} day${Math.round(spell) === 1 ? '' : 's'}`;
  const regimeWords = `${fin(turbulentP) ? `The hidden Markov model puts the market in its ${turbulentP > 0.5 ? 'turbulent' : 'calm'} state (${pctU(sure)} sure${spellWords ? `; ${spellWords}` : ''}). ` : ''}${fin(hurst) ? `Hurst ${hurst.toFixed(2)} and a variance ratio of ${fin(vrNow) ? vrNow.toFixed(2) : '—'}: ${trending ? 'moves have tended to carry on — trend rules have worked better than fading' : reverting ? 'moves have tended to reverse — fading stretches has worked better than chasing' : 'daily moves look close to a random walk — neither chasing nor fading has a clear edge'}.` : ''}`;

  // ---- volatility ----
  let vol: InstrumentReport['vol'] = null;
  let fit: GarchFit | null = null;
  if (dr.length >= 200) {
    fit = fitBest(dr.slice(-1000));
    if (fit) {
      const rv = (n: number) => sd(dr.slice(-n)) * Math.sqrt(365);
      const rv30s: number[] = [];
      for (let i = Math.max(30, dr.length - 365); i <= dr.length; i++) rv30s.push(sd(dr.slice(i - 30, i)));
      const rv30 = rv(30);
      const rank = rv30s.length ? rv30s.filter((x) => x <= rv30 / Math.sqrt(365)).length / rv30s.length : NaN;
      const nowAnn = Math.sqrt(fit.nextVar * 365);
      const longAnn = Math.sqrt(fit.longRun * 365);
      vol = {
        nowAnn,
        longAnn,
        rv7: rv(7),
        rv30,
        rank,
        dayMove: Math.sqrt(fit.nextVar),
        var95: valueAtRisk(fit, fit.nextVar, 1, 0.95),
        var99: valueAtRisk(fit, fit.nextVar, 1, 0.99),
        halfLife: fit.halfLife,
        words: `Volatility is ${nowAnn > longAnn * 1.15 ? 'running hot' : nowAnn < longAnn * 0.85 ? 'quieter than usual' : 'near its usual level'}: GARCH expects ${pctU(nowAnn)} a year now against a long-run ${pctU(longAnn)} — a typical day moves about ${pctU(Math.sqrt(fit.nextVar), 1)}. The last 30 days ranked ${fin(rank) ? `${Math.round(rank * 100)}th percentile` : '—'} of the past year. On a bad day (1 in 20) it could fall ${pctU(valueAtRisk(fit, fit.nextVar, 1, 0.95), 1)}; 1 in 100, ${pctU(valueAtRisk(fit, fit.nextVar, 1, 0.99), 1)}.`,
      };
    }
  }
  if (!vol) gaps.push('no GARCH fit (needs 200+ daily candles)');

  // ---- forecasts ----
  const day = fit && fin(price) ? rangeOf(fit, price, 1) : null;
  const week = fit && fin(price) ? rangeOf(fit, price, 7) : null;
  let candle: CandleReport | null = inp.candle ?? null;
  if (inp.candle === undefined && inp.candles !== false && Hh.length >= 400) {
    try {
      candle = candleForecast({ coin, tfH: 1, bars: Hh.slice(-1000), funding: null });
    } catch {
      candle = null;
    }
  }

  // ---- levels ----
  const yd = D.length >= 2 ? D[D.length - 2] : null;
  const pivot = yd
    ? (() => {
        const p = (yd.high + yd.low + yd.close) / 3;
        return { p, r1: 2 * p - yd.low, r2: p + (yd.high - yd.low), s1: 2 * p - yd.high, s2: p - (yd.high - yd.low) };
      })()
    : null;
  const sw = swings(D.slice(-120), 3);
  const vp = volumeProfile(Hh.slice(-24 * 30));
  const h7 = Hh.slice(-24 * 7);
  const vv = h7.reduce((a, b) => a + b.volume, 0);
  const vwap7 = vv > 0 ? h7.reduce((a, b) => a + ((b.high + b.low + b.close) / 3) * b.volume, 0) / vv : NaN;
  const lv: Level[] = [];
  const addL = (p: number, kind: string) => {
    if (fin(p) && p > 0 && fin(price)) lv.push({ price: p, kind, dist: p / price - 1 });
  };
  for (const h of sw.highs) addL(h, 'swing high');
  for (const l of sw.lows) addL(l, 'swing low');
  if (range52) {
    addL(range52.hi, '52-week high');
    addL(range52.lo, '52-week low');
  }
  addL(vp.poc, 'volume point of control (30 days)');
  addL(vp.vah, 'top of the value area');
  addL(vp.val, 'bottom of the value area');
  addL(ma200, '200-day average');
  addL(ma50, '50-day average');
  const near = (xs: Level[]) => {
    // merge levels within 0.4 % of each other (they are one area)
    const out: Level[] = [];
    for (const l of xs) {
      const same = out.find((o) => Math.abs(o.price / l.price - 1) < 0.004);
      if (same) {
        if (!same.kind.includes(l.kind)) same.kind = `${same.kind} · ${l.kind}`;
      } else out.push({ ...l });
    }
    return out;
  };
  const above = near(lv.filter((l) => l.dist > 0.001).sort((a, b) => a.dist - b.dist)).slice(0, 4);
  const below = near(lv.filter((l) => l.dist < -0.001).sort((a, b) => b.dist - a.dist)).slice(0, 4);

  // ---- against bitcoin ----
  let vsBtc: InstrumentReport['vsBtc'] = null;
  const B = (inp.btcDaily ?? []).filter((b) => b.close > 0);
  if (coin !== 'BTC' && B.length >= 60 && D.length >= 60) {
    const bm = new Map(B.map((b) => [Math.floor(b.time / 86_400_000), b.close]));
    const pairs: [number, number][] = [];
    for (const b of D) {
      const v = bm.get(Math.floor(b.time / 86_400_000));
      if (v) pairs.push([b.close, v]);
    }
    const a = pairs.slice(1).map((p, i) => Math.log(p[0] / pairs[i][0]));
    const m = pairs.slice(1).map((p, i) => Math.log(p[1] / pairs[i][1]));
    const k = capm(a.slice(-365), m.slice(-365));
    if (k) {
      const rel = (n: number) => (pairs.length > n ? pairs[pairs.length - 1][0] / pairs[pairs.length - 1 - n][0] / (pairs[pairs.length - 1][1] / pairs[pairs.length - 1 - n][1]) - 1 : NaN);
      const corr = Math.sign(k.beta) * Math.sqrt(Math.max(0, k.r2));
      const rel30 = rel(30);
      const rel90 = rel(90);
      vsBtc = {
        beta: k.beta,
        corr,
        r2: k.r2,
        alphaAnn: k.alpha * 365,
        rel30,
        rel90,
        words: `It moves with bitcoin (correlation ${corr.toFixed(2)}): a 1 % move in bitcoin has come with about ${k.beta.toFixed(2)} % here${k.beta > 1.2 ? ' — it amplifies bitcoin' : k.beta < 0.8 ? ' — it is calmer than bitcoin' : ''}. Over 30 days it has ${fin(rel30) ? `${rel30 >= 0 ? 'beaten' : 'lagged'} bitcoin by ${pctU(Math.abs(rel30), 1)}` : '—'}; over 90 days ${fin(rel90) ? `${rel90 >= 0 ? 'beaten' : 'lagged'} it by ${pctU(Math.abs(rel90), 1)}` : '—'}.`,
      };
    }
  }

  // ---- positioning and flow ----
  let positioning: InstrumentReport['positioning'] = null;
  const fundingPct = fin(L.fundingRate) ? L.fundingRate! * 100 : NaN;
  const fundingApr = fin(fundingPct) ? fundingPct * (24 / (L.fundingIntervalH ?? 8)) * 365 : NaN;
  const basisBps = fin(L.markPrice) && fin(L.indexPrice) && L.indexPrice! > 0 ? ((L.markPrice! - L.indexPrice!) / L.indexPrice!) * 1e4 : NaN;
  const flow = inp.flow && inp.flow.buyUsd + inp.flow.sellUsd > 0 ? inp.flow : null;
  const liqs = inp.liqs && inp.liqs.longUsd + inp.liqs.shortUsd > 0 ? inp.liqs : null;
  if (L.perp || flow || liqs) {
    const bits: string[] = [];
    if (fin(fundingApr))
      bits.push(
        fundingApr > 30
          ? `Funding is high (${fundingApr.toFixed(0)} % a year): longs are paying up to hold — the trade is crowded on the long side`
          : fundingApr < -5
            ? `Funding is negative (${fundingApr.toFixed(0)} % a year): shorts are paying longs — the crowd leans short, which can fuel squeezes up`
            : `Funding is ordinary (${fundingApr.toFixed(0)} % a year): no crowding to speak of`,
      );
    if (fin(L.longAccount)) bits.push(`${pctU(L.longAccount!)} of accounts are long`);
    if (fin(L.oiChange) && L.oiChangeHours && Math.abs(L.oiChange!) < 0.001) bits.push(`open interest was flat over ${Math.round(L.oiChangeHours)} h`);
    else if (fin(L.oiChange) && L.oiChangeHours) bits.push(`open interest ${L.oiChange! >= 0 ? 'rose' : 'fell'} ${pctU(Math.abs(L.oiChange!), 1)} over ${Math.round(L.oiChangeHours)} h${L.oiChange! > 0.02 && fin(ch24) ? (ch24 > 0 ? ' with the price — new money behind the move' : ' while the price fell — new shorts are pressing') : L.oiChange! < -0.02 ? ' — positions are being closed' : ''}`);
    if (flow) {
      const share = flow.buyUsd / (flow.buyUsd + flow.sellUsd);
      bits.push(`in the last ${flow.minutes >= 60 ? 'hour' : flow.minutes === 1 ? 'minute' : `${flow.minutes} minutes`} buyers took ${pctU(share)} of the traded volume (${share > 0.55 ? 'buyers in control' : share < 0.45 ? 'sellers in control' : 'balanced'})`);
    }
    if (liqs) bits.push(`liquidations over ${liqs.hours} h: $${compactN(liqs.longUsd)} of longs, $${compactN(liqs.shortUsd)} of shorts`);
    positioning = {
      fundingPct,
      fundingApr,
      oiUsd: L.openInterestUsd ?? NaN,
      oiChange: L.oiChange ?? NaN,
      oiChangeHours: L.oiChangeHours ?? 0,
      longShort: L.longShortRatio ?? NaN,
      longAccount: L.longAccount ?? NaN,
      basisBps,
      flow,
      liqs,
      words: bits.length ? `${bits.join('; ')}.` : 'No positioning data from this venue yet.',
    };
  }

  // ---- news ----
  const nws = newsFor(coin, inp.news ?? [], now);
  const newsWords = nws.items.length
    ? `${nws.items.length} headline${nws.items.length === 1 ? '' : 's'} in the last three days${nws.good + nws.bad ? ` — ${nws.good} sound positive, ${nws.bad} negative` : ''}. Latest: “${nws.items[0].title}”.`
    : 'No headlines about it in the last three days (the feed covers the larger coins best).';

  // ---- the votes ----
  const S: Signal[] = [];
  const M: Signal[] = [];
  const sig = (h: Horizon, id: string, name: string, vote: number, weight: number, value: string, why: string) => (h === 'short' ? S : M).push({ id, name, horizon: h, vote, weight, value, why });

  // medium term — the weeks ahead
  if (fin(ma200)) sig('medium', 'ma200', 'The 200-day average', price > ma200 ? 1 : -1, 1.5, pctS(price / ma200 - 1), price > ma200 ? 'Price above its 200-day average: the long-term trend is up (Faber 2007 — the rule that kept investors out of most bear markets).' : 'Price below its 200-day average: the long-term trend is down — historically the side of the line where the deep falls happen.');
  if (fin(ma50) && fin(ma200)) sig('medium', 'cross', 'The 50/200-day cross', ma50 > ma200 ? 1 : -1, 1, ma50 > ma200 ? '50 above 200' : '50 below 200', ma50 > ma200 ? 'The 50-day average is above the 200-day: the medium trend agrees with the long one.' : 'The 50-day average is below the 200-day: the medium trend is down.');
  const r90 = changeOver(D, price, 90);
  if (fin(r90)) sig('medium', 'tsmom', 'Three-month momentum', Math.max(-1, Math.min(1, r90 / 0.25)), 1.5, pctS(r90), `${r90 >= 0 ? 'Up' : 'Down'} ${pctU(Math.abs(r90))} over 90 days. Coins that rose (or fell) over the past months have tended to keep going for weeks (time-series momentum: Moskowitz, Ooi & Pedersen 2012; Liu & Tsyvinski 2021 for crypto).`);
  const r30 = changeOver(D, price, 30);
  if (fin(r30)) sig('medium', 'mom30', 'One-month momentum', Math.max(-1, Math.min(1, r30 / 0.15)), 1, pctS(r30), `${r30 >= 0 ? 'Up' : 'Down'} ${pctU(Math.abs(r30))} over 30 days — the shorter look-back of the same momentum effect, quicker to turn.`);
  if (fin(scoreD)) sig('medium', 'vote', `The ${TREND_VOTES}-indicator trend vote`, Math.max(-1, Math.min(1, scoreD / 0.5)), 1.5, `${scoreD >= 0 ? '+' : ''}${Math.round(scoreD * 100)} %`, `${TREND_VOTES} daily price and volume indicators (RSI, averages from 3 to 200 days, MACD, money flow, Bollinger) on balance say ${scoreD > 0.15 ? 'up' : scoreD < -0.15 ? 'down' : 'nothing clear'}.`);
  if (fin(tStat)) sig('medium', 'tstat', 'The trend’s significance', Math.abs(tStat) > 2 ? Math.sign(tStat) : tStat / 4, 1, `t = ${tStat.toFixed(1)}`, Math.abs(tStat) > 2 ? `The 90-day trend is statistically clear (t = ${tStat.toFixed(1)}): it is unlikely to be noise.` : `The 90-day trend is weak (t = ${tStat.toFixed(1)}): it could easily be noise.`);
  if (vsBtc && fin(vsBtc.rel30)) sig('medium', 'rs', 'Strength against bitcoin', Math.max(-1, Math.min(1, vsBtc.rel30 / 0.1)), 0.75, pctS(vsBtc.rel30), vsBtc.rel30 >= 0 ? 'It has outpaced bitcoin over a month — relative strength tends to persist a while.' : 'It has lagged bitcoin over a month — weak coins have tended to stay weak for a while.');
  if (fin(turbulentP) && fin(r30)) sig('medium', 'regime', 'Regime', turbulentP > 0.5 ? (r30 < 0 ? -0.5 : 0) : r30 > 0 ? 0.5 : 0, 0.5, turbulentP > 0.5 ? 'turbulent' : 'calm', turbulentP > 0.5 ? 'A turbulent spell: falls have tended to cluster in such spells, rallies in calm ones.' : 'A calm spell: the steadier regime, where trends have tended to grind on.');

  // short term — the next hours to days
  if (fin(scoreH)) sig('short', 'voteH', 'The hourly trend vote', Math.max(-1, Math.min(1, scoreH / 0.5)), 1.5, `${scoreH >= 0 ? '+' : ''}${Math.round(scoreH * 100)} %`, `The same ${TREND_VOTES} indicators on hourly candles say ${scoreH > 0.15 ? 'up' : scoreH < -0.15 ? 'down' : 'nothing clear'} for the last few days.`);
  if (fin(ch24)) sig('short', 'mom24', 'The last 24 hours', Math.max(-1, Math.min(1, ch24 / 0.05)), 1, pctS(ch24), `${ch24 >= 0 ? 'Up' : 'Down'} ${pctU(Math.abs(ch24), 1)} in a day; short-run moves in crypto have tended to carry on for a day or so (Liu & Tsyvinski 2021).`);
  const ema20h = Hh.length > 40 ? last(ema(hClose, 20)) : NaN;
  const ema50h = Hh.length > 100 ? last(ema(hClose, 50)) : NaN;
  if (fin(ema20h) && fin(ema50h)) sig('short', 'ema', 'Hourly averages', price > ema20h && ema20h > ema50h ? 1 : price < ema20h && ema20h < ema50h ? -1 : 0, 1, `${price > ema20h ? 'above' : 'below'} 20h`, price > ema20h && ema20h > ema50h ? 'Above its 20-hour average, which is above the 50-hour: the short trend is up.' : price < ema20h && ema20h < ema50h ? 'Below its 20-hour average, which is below the 50-hour: the short trend is down.' : 'The hourly averages are tangled: no short trend.');
  if (fin(vwap7)) sig('short', 'vwap', 'The 7-day VWAP', price > vwap7 ? 0.5 : -0.5, 0.75, pctS(price / vwap7 - 1), price > vwap7 ? 'Above the week’s volume-weighted price: the average buyer this week is in profit.' : 'Below the week’s volume-weighted price: the average buyer this week is under water — rallies may meet selling.');
  if (fin(rsiH)) sig('short', 'rsi', 'Hourly RSI', rsiH > 75 ? -0.5 : rsiH < 25 ? 0.5 : 0, 0.5, rsiH.toFixed(0), rsiH > 75 ? 'Overbought on the hourly: stretched — a pause or pullback is common from here.' : rsiH < 25 ? 'Oversold on the hourly: stretched to the downside — bounces are common from here.' : 'Not stretched either way.');
  if (fin(fundingApr)) sig('short', 'funding', 'Funding (the crowd)', fundingApr > 40 ? -1 : fundingApr > 20 ? -0.5 : fundingApr < -10 ? 1 : fundingApr < 0 ? 0.5 : 0, 1, `${fundingApr.toFixed(0)} % APR`, fundingApr > 20 ? 'Longs pay a lot to stay in: a crowded long. When they are shaken out the drop is sharp (the contrarian reading of funding).' : fundingApr < 0 ? 'Shorts are paying: the crowd leans short — fuel for a squeeze up.' : 'Funding is normal: no crowding signal.');
  if (flow) {
    const share = flow.buyUsd / (flow.buyUsd + flow.sellUsd);
    sig('short', 'flow', 'Order flow (last hour)', Math.max(-1, Math.min(1, (share - 0.5) / 0.1)), 1, `${pctU(share)} buys`, `${share > 0.5 ? 'Buyers' : 'Sellers'} took ${pctU(Math.max(share, 1 - share))} of the volume traded in the last ${flow.minutes >= 60 ? 'hour' : `${flow.minutes} min`} — aggressive ${share > 0.5 ? 'buying' : 'selling'}.`);
  }
  if (liqs && liqs.longUsd + liqs.shortUsd > 0) {
    const sh = liqs.shortUsd / (liqs.longUsd + liqs.shortUsd);
    sig('short', 'liqs', 'Liquidations', sh > 0.65 ? 0.5 : sh < 0.35 ? -0.5 : 0, 0.5, `${pctU(sh)} shorts`, sh > 0.65 ? 'Mostly shorts are being forced out — a squeeze up is in progress.' : sh < 0.35 ? 'Mostly longs are being forced out — a flush down is in progress.' : 'Liquidations are on both sides.');
  }
  if (candle?.next && candle.eval && candle.eval.skill > 0.005 && candle.eval.n >= 100) {
    const p = candle.next.pUp;
    sig('short', 'candle', 'Next-candle model', Math.max(-1, Math.min(1, (p - 0.5) / 0.1)), 0.75, `${pctU(p)} up`, `The forest that has called ${pctU(candle.eval.hit, 1)} of ${candle.eval.n} unseen hourly candles right gives the next one ${pctU(p)} odds of closing up.`);
  }
  if (nws.good + nws.bad >= 2) sig('short', 'news', 'News tone', nws.tone, 0.5, `${nws.good}+ / ${nws.bad}−`, nws.tone > 0.2 ? 'The headlines lean positive.' : nws.tone < -0.2 ? 'The headlines lean negative.' : 'The headlines are mixed.');

  const short = verdictOf('short', S);
  const medium = verdictOf('medium', M);

  // ---- the summary ----
  const summary: string[] = [];
  const pfx = `${coin} is at ${px(price)}`;
  const moves = [fin(ch24) ? `${pctS(ch24)} on the day` : '', fin(perf[2].pct) ? `${pctS(perf[2].pct)} on the week` : '', fin(perf[3].pct) ? `${pctS(perf[3].pct)} on the month` : ''].filter(Boolean);
  summary.push(`${pfx}${moves.length ? `, ${moves.join(', ')}` : ''}${range52 ? ` — ${range52.fromHi < -0.01 ? `${pctU(-range52.fromHi)} below its 52-week high` : 'at its 52-week high'}` : ''}.`);
  summary.push(`Short term: ${short.lean.toLowerCase()}. Medium term: ${medium.lean.toLowerCase()}.`);
  if (fin(ma200)) summary.push(trendWords);
  if (vol) summary.push(vol.words.split('. ')[0] + '.');
  if (day && week) summary.push(`GARCH puts it between ${px(day.lo68)} and ${px(day.hi68)} by this time tomorrow (2 times in 3), and between ${px(week.lo95)} and ${px(week.hi95)} in a week (19 times in 20).`);
  if (above[0] || below[0]) summary.push(`Nearest levels: ${above[0] ? `resistance ${px(above[0].price)} (${above[0].kind}, ${pctS(above[0].dist)})` : ''}${above[0] && below[0] ? '; ' : ''}${below[0] ? `support ${px(below[0].price)} (${below[0].kind}, ${pctS(below[0].dist)})` : ''}.`);
  if (positioning && fin(fundingApr)) summary.push(positioning.words.split('; ')[0] + '.');

  return {
    coin,
    price,
    asOf: now,
    days: D.length,
    perf,
    range52,
    short,
    medium,
    trend: { ma20, ma50, ma200, adx: adxD, rsiD, rsiH, scoreD, scoreH, tStat, words: trendWords },
    regime: { turbulentP, calmDays, turbDays, hurst, vr: vrNow, vrZ, label, words: regimeWords },
    vol,
    forecast: { day, week, candle },
    levels: { pivot, above, below, poc: vp.poc, vah: vp.vah, val: vp.val, vwap7 },
    vsBtc,
    positioning,
    news: { ...nws, words: newsWords },
    summary,
    gaps,
  };
}

function compactN(v: number): string {
  if (!fin(v)) return '—';
  const a = Math.abs(v);
  return a >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : a >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v.toFixed(0);
}
