// The Lab's backtester: one strategy on one market, bar by bar.
//
// A signal is read at a bar's close; the trade opens at the NEXT bar's open,
// plus slippage and the taker fee. Inside a bar the stop is checked before
// the target (the cautious assumption when both are touched). Funding is
// charged every bar a perpetual position is open. The result has the trades
// (in R, the multiple of the risk taken) and a return for every bar, marked
// to market at the close, for the statistics.
import type { ForestModel } from './ml';
import { atr14, garchSigma, EXIT_DEFAULT, FILTER_MAP, SIGNAL_MAP, type Ctx, type ExitSpec, type Params } from './library';

export interface RuleRef {
  id: string;
  p: Params;
}
export interface StrategySpec {
  /** a short name the Lab gives it */
  name: string;
  signal: RuleRef;
  filters: RuleRef[];
  exit: ExitSpec;
  sides: 'both' | 'long' | 'short';
  /** a meta-labeller: a forest that decides which signals to take (nf: how many inputs it was trained on) */
  meta?: { model: ForestModel; threshold: number; nf?: number };
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

export function signalOf(c: Ctx, s: StrategySpec): Int8Array {
  const sig = SIGNAL_MAP[s.signal.id].compute(c, s.signal.p);
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
  const raw = SIGNAL_MAP[s.signal.id].compute(c, s.signal.p);
  const A = atr14(c);
  const G = ex0(s).stopVol ? garchSigma(c) : null;
  const f = c.m.funding;
  const ex: ExitSpec = { ...EXIT_DEFAULT, ...s.exit };
  const cost = (costs.feeBps + costs.slipBps) / 1e4;
  const n = Math.max(0, to - from);
  const rets = new Float64Array(n);
  const times = new Float64Array(n);
  const trades: Trade[] = [];
  let pos: { side: 1 | -1; sig: number; entryI: number; entry: number; stop: number; stop0: number; target: number; risk: number; trailed: boolean; fund: number } | null = null;
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
        rets[k] -= cost;
      }
    }
    if (!pos) continue;
    inBars++;
    const prev = i === pos.entryI ? pos.entry : b[i - 1].close;
    // 2) the stop, then the target, inside the bar
    const hitStop = pos.side === 1 ? bar.low <= pos.stop : bar.high >= pos.stop;
    const hitTgt = Number.isFinite(pos.target) && (pos.side === 1 ? bar.high >= pos.target : bar.low <= pos.target);
    const fund = f && Number.isFinite(f[i]) ? pos.side * f[i] : 0;
    pos.fund += fund;
    if (hitStop || hitTgt) {
      // a gap through the stop fills at the open
      const px = hitStop ? (pos.side === 1 ? Math.min(pos.stop, bar.open) : Math.max(pos.stop, bar.open)) * (1 - pos.side * (costs.slipBps / 1e4)) : pos.target;
      rets[k] += (pos.side * (px - prev)) / pos.entry - cost - fund;
      close(i, px, hitStop ? (pos.trailed ? 'trail' : 'stop') : 'target');
      continue;
    }
    rets[k] += (pos.side * (bar.close - prev)) / pos.entry - fund;
    // 3) at the close: time limit, opposite signal, trailing stop
    if (i - pos.entryI + 1 >= ex.maxBars) {
      rets[k] -= cost;
      close(i, bar.close, 'time');
      continue;
    }
    if (ex.onFlip && raw[i] === -pos.side) {
      rets[k] -= cost;
      close(i, bar.close, 'flip');
      continue;
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
    rets[n - 1] -= cost;
    close(to - 1, b[to - 1].close, 'end');
  }
  return { trades, rets, times, exposure: n ? inBars / n : 0 };
}
