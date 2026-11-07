// The Lab's backtester: one strategy on one market, bar by bar.
//
// A signal is read at a bar's close; the trade opens at the NEXT bar's open,
// plus slippage and the taker fee. Inside a bar the stop is checked before
// the target (the cautious assumption when both are touched). Funding is
// charged every bar a perpetual position is open. The result has the trades
// (in R, the multiple of the risk taken) and a return for every bar, marked
// to market at the close, for the statistics.
import { errQuantile } from './garch';
import type { MetaModel } from './ml';
import { atr14, barsPerYear, benchBeta, garchOf, garchSigma, EXIT_DEFAULT, FILTER_MAP, SIGNAL_MAP, type Ctx, type ExitSpec, type Params } from './library';
import { volTargetWeight } from './quant';

export interface RuleRef {
  id: string;
  p: Params;
}
export interface StrategySpec {
  /** a short name the Lab gives it */
  name: string;
  signal: RuleRef;
  /** more entry rules, read with `signal` and joined by `combine` (the bot builder's stacked strategies) */
  also?: RuleRef[];
  /** all: every rule must point the same way · majority: more than half do, none against · any: one does and none disagrees */
  combine?: Combine;
  filters: RuleRef[];
  exit: ExitSpec;
  sides: 'both' | 'long' | 'short';
  /** a meta-labeller: a forest, a neural network or both decide which signals to take (nf: how many inputs it was trained on) */
  meta?: MetaModel;
  /**
   * position size while in a trade: unit notional; a volatility target
   * (annual σ the position should run at, from the GARCH forecast); or a
   * value-at-risk budget (the 1-day 99 % GARCH VaR the position may carry, as
   * a fraction of capital). Capped at 3× notional.
   */
  sizing?: Sizing;
  /** a second sizing rule: the position is the smaller of the two (e.g. steady volatility, capped by a VaR budget) */
  sizing2?: Sizing;
  /** delta-hedge the market exposure: short β × the position in bitcoin (β re-estimated on 30 days of returns) */
  hedge?: 'btc';
  /** the bot builder's "AI trade filter": train a meta-labeller in sample when the strategy is tested (becomes `meta` if it helps) — a forest (true), a neural network, or both averaged */
  autoMeta?: boolean | 'forest' | 'nn' | 'both';
  /** how the money is split across the coins: equally, by calm (inverse volatility), minimum variance, or the efficient frontier's best return for the risk (the last three fitted on the training years) */
  weights?: 'equal' | 'invvol' | 'minvar' | 'tangency';
  /** the split, once tested: coin → share of the money (sums to 1) */
  coinWeights?: Record<string, number>;
}
export type Combine = 'all' | 'majority' | 'any';
export interface Sizing {
  /** kelly: risk the target fraction of capital per trade at the stop (the target is a half-Kelly fraction found in sample; 0 = find it when tested) */
  mode: 'unit' | 'vol' | 'var' | 'kelly';
  target: number;
}
export interface Trade {
  side: 1 | -1;
  /** bar index of the signal (entry is the next bar's open) */
  sig: number;
  entryI: number;
  exitI: number;
  entry: number;
  exit: number;
  stop0: number;
  /** after fees, slippage and funding: fractional return on notional, and in R */
  ret: number;
  r: number;
  reason: 'stop' | 'target' | 'trail' | 'time' | 'flip' | 'end';
}
export interface Costs {
  feeBps: number;
  slipBps: number;
}
export const COSTS: Costs = { feeBps: 4.5, slipBps: 2 };

export interface BTResult {
  trades: Trade[];
  /** per-bar strategy return from `from` to `to` (unit notional while in a trade) */
  rets: Float64Array;
  /** bar time of each entry of rets */
  times: Float64Array;
  /** share of bars in a position */
  exposure: number;
}

const ex0 = (s: StrategySpec): ExitSpec => ({ ...EXIT_DEFAULT, ...s.exit });

/** the position weight each bar's close calls for (used from the next bar); null = unit notional */
export function sizeWeights(c: Ctx, s: StrategySpec): Float64Array | null {
  const a = weightsOf(c, s, s.sizing);
  const b = weightsOf(c, s, s.sizing2);
  if (!a || !b) return a ?? b;
  return a.map((x, i) => Math.min(x, b[i]));
}

function weightsOf(c: Ctx, s: StrategySpec, z: Sizing | undefined): Float64Array | null {
  if (!z || z.mode === 'unit' || !(z.target > 0)) return null;
  if (z.mode === 'kelly') {
    // the fraction of capital lost at the stop is the target: weight = target / stop distance
    const A = atr14(c);
    const G = s.exit.stopVol ? garchSigma(c) : null;
    return Float64Array.from(c.m.bars, (b, i) => {
      const d = G && s.exit.stopVol ? s.exit.stopVol * G[i] : ((s.exit.stopAtr ?? EXIT_DEFAULT.stopAtr) * A[i]) / b.close;
      return d > 0 && Number.isFinite(d) ? Math.min(3, z.target / d) : 0;
    });
  }
  const G = garchSigma(c);
  if (z.mode === 'vol') {
    const bpy = barsPerYear(c.m.tfH);
    return G.map((g) => volTargetWeight(g, z.target, bpy, 3));
  }
  // a VaR budget: the weight at which a day's 99 % loss (GARCH, the fitted tails) is the budget
  const fit = garchOf(c);
  const q = fit ? -errQuantile(fit, 0.01) : 2.326;
  const day = Math.sqrt(Math.max(1, Math.round(24 / c.m.tfH)));
  return G.map((g) => (g > 0 ? Math.min(3, z.target / (q * g * day)) : 0));
}

/** the entry rules joined: one rule as it is, or several by the strategy's `combine` */
export function rawSignal(c: Ctx, s: StrategySpec): Int8Array {
  const first = SIGNAL_MAP[s.signal.id].compute(c, s.signal.p);
  if (!s.also?.length) return first;
  const all = [first, ...s.also.map((r) => SIGNAL_MAP[r.id].compute(c, r.p))];
  return combineSignals(all, s.combine ?? 'all');
}

export function combineSignals(all: Int8Array[], how: Combine): Int8Array {
  const n = all[0].length;
  const k = all.length;
  const out = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    let up = 0;
    let dn = 0;
    for (const a of all) {
      if (a[i] > 0) up++;
      else if (a[i] < 0) dn++;
    }
    if (how === 'all') out[i] = up === k ? 1 : dn === k ? -1 : 0;
    else if (how === 'majority') out[i] = up > k / 2 && !dn ? 1 : dn > k / 2 && !up ? -1 : 0;
    else out[i] = up && !dn ? 1 : dn && !up ? -1 : 0;
  }
  return out;
}

export function signalOf(c: Ctx, s: StrategySpec): Int8Array {
  const sig = rawSignal(c, s);
  const fs = s.filters.map((f) => FILTER_MAP[f.id].compute(c, f.p));
  const out = new Int8Array(sig.length);
  for (let i = 0; i < sig.length; i++) {
    let d = sig[i];
    if (d === 1 && (s.sides === 'short' || fs.some((f) => !f.long[i]))) d = 0;
    if (d === -1 && (s.sides === 'long' || fs.some((f) => !f.short[i]))) d = 0;
    out[i] = d;
  }
  return out;
}

/**
 * Run a strategy over bars [from, to). `gate(i, side)` (optional) can veto an
 * entry signalled at bar i — the meta-labeller's hook.
 */
export function backtest(c: Ctx, s: StrategySpec, from: number, to: number, costs: Costs = COSTS, gate?: (i: number, side: 1 | -1) => boolean, sigIn?: Int8Array): BTResult {
  const b = c.m.bars;
  const sig = sigIn ?? signalOf(c, s);
  const raw = rawSignal(c, s);
  const A = atr14(c);
  const G = ex0(s).stopVol ? garchSigma(c) : null;
  const W = sizeWeights(c, s);
  const B = s.hedge === 'btc' && c.m.bench ? benchBeta(c) : null;
  const bm = c.m.bench;
  const f = c.m.funding;
  const ex: ExitSpec = { ...EXIT_DEFAULT, ...s.exit };
  const cost = (costs.feeBps + costs.slipBps) / 1e4;
  const n = Math.max(0, to - from);
  const rets = new Float64Array(n);
  const times = new Float64Array(n);
  const trades: Trade[] = [];
  let pos: { side: 1 | -1; sig: number; entryI: number; entry: number; stop: number; stop0: number; target: number; risk: number; trailed: boolean; fund: number } | null = null;
  // the position's weight (notional) and its bitcoin hedge ratio, both set at entry and rebalanced when they drift
  let w = 1;
  let hb = 0;
  const wAt = (i: number) => (W && Number.isFinite(W[i]) ? W[i] : 1);
  const bAt = (i: number) => (B && Number.isFinite(B[i]) ? B[i] : 0);
  // the cost of opening or closing: the coin leg and the hedge leg
  const tc = () => cost * w * (1 + Math.abs(hb));
  let inBars = 0;
  const close = (i: number, px: number, reason: Trade['reason']) => {
    if (!pos) return;
    const gross = (pos.side * (px - pos.entry)) / pos.entry;
    const ret = gross - 2 * cost - pos.fund;
    trades.push({ side: pos.side, sig: pos.sig, entryI: pos.entryI, exitI: i, entry: pos.entry, exit: px, stop0: pos.stop0, ret, r: (ret * pos.entry) / pos.risk, reason });
    pos = null;
  };
  for (let i = Math.max(from, 2); i < to; i++) {
    const k = i - from;
    times[k] = b[i].time;
    const bar = b[i];
    // 1) enter at this bar's open on the previous bar's new signal
    if (!pos) {
      const d = sig[i - 1];
      const onset = d !== 0 && d !== sig[i - 2];
      const a = A[i - 1];
      if (onset && Number.isFinite(a) && a > 0 && (!gate || gate(i - 1, d as 1 | -1))) {
        const side = d as 1 | -1;
        const entry = bar.open * (1 + side * (costs.slipBps / 1e4));
        // the stop: ATRs, or GARCH standard deviations of the next bar's return
        const risk = G && ex.stopVol ? ex.stopVol * G[i - 1] * entry : ex.stopAtr * a;
        pos = { side, sig: i - 1, entryI: i, entry, stop: entry - side * risk, stop0: entry - side * risk, target: ex.targetR > 0 ? entry + side * ex.targetR * risk : NaN, risk, trailed: false, fund: 0 };
        w = wAt(i - 1);
        hb = bAt(i - 1);
        rets[k] -= tc();
      }
    }
    if (!pos) continue;
    inBars++;
    const prev = i === pos.entryI ? pos.entry : b[i - 1].close;
    // unit size holds a fixed quantity (P&L on the entry notional); a sized or hedged position is a weight
    // of capital, rebalanced, so each bar's move is measured from the bar before
    const den = W || B ? prev : pos.entry;
    // 2) the stop, then the target, inside the bar
    const hitStop = pos.side === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
    const hitTgt = Number.isFinite(pos.target) && (pos.side === 1 ? bar.high >= pos.target : bar.low <= pos.target);
    const fund = f && Number.isFinite(f[i]) ? pos.side * f[i] : 0;
    pos.fund += fund;
    // the hedge leg: short β of bitcoin per unit of a long (long β per unit of a short)
    if (hb && bm && Number.isFinite(bm[i]) && Number.isFinite(bm[i - 1]) && bm[i - 1] > 0) rets[k] -= pos.side * w * hb * (bm[i] / bm[i - 1] - 1);
    if (hitStop || hitTgt) {
      // a gap through the stop fills at the open
      const px = hitStop ? (pos.side === 1 ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open)) * (1 - pos.side * (costs.slipBps / 1e4)) : pos.target;
      rets[k] += w * ((pos.side * (px - prev)) / den - fund) - tc();
      close(i, px, hitStop ? (pos.trailed ? 'trail' : 'stop') : 'target');
      continue;
    }
    rets[k] += w * ((pos.side * (bar.close - prev)) / den - fund);
    // 3) at the close: time limit, opposite signal, trailing stop
    if (i - pos.entryI + 1 >= ex.maxBars) {
      rets[k] -= tc();
      close(i, bar.close, 'time');
      continue;
    }
    if (ex.onFlip && raw[i] === -pos.side) {
      rets[k] -= tc();
      close(i, bar.close, 'flip');
      continue;
    }
    // rebalance the size (and the hedge) when the target has drifted more than a quarter
    if (W || B) {
      const wn = wAt(i);
      const bn = bAt(i);
      if (Math.abs(wn - w) > 0.25 * w || Math.abs(bn - hb) > 0.25 * Math.max(0.2, Math.abs(hb))) {
        rets[k] -= cost * (Math.abs(wn - w) + Math.abs(wn * bn - w * hb));
        w = wn;
        hb = bn;
      }
    }
    if (ex.trailAtr > 0 && Number.isFinite(A[i]) && (pos.side * (bar.close - pos.entry)) / pos.risk >= 1) {
      const t = bar.close - pos.side * ex.trailAtr * A[i];
      if ((t - pos.stop) * pos.side > 0) {
        pos.stop = t;
        pos.trailed = true;
      }
    }
  }
  if (pos && to - 1 >= from) {
    rets[n - 1] -= tc();
    close(to - 1, b[to - 1].close, 'end');
  }
  return { trades, rets, times, exposure: n ? inBars / n : 0 };
}
