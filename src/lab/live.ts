// A deployed Lab strategy, live: read its signal on the latest closed candles
// and manage its open trade by its own exit rules — the same code paths the
// backtest used, so what was tested is what trades.
import { signalOf, type StrategySpec } from './backtest';
import { atr14, ctxOf, features, type Market } from './library';
import { predictForest } from './ml';
import { rulesOf } from './research';

export interface Deployed {
  id: string;
  spec: StrategySpec;
  /** the timeframe it was researched on, in hours */
  tfH: number;
  coins: string[];
  /** where it runs */
  targets: { crypto: boolean; meme: boolean };
  /** the out-of-sample numbers it was deployed on */
  stats: { sharpe: number; t: number; dsr: number; trades: number; verdict: string };
  deployedAt: number;
  on: boolean;
}

export interface LiveSignal {
  side: 'buy' | 'sell';
  price: number;
  stop: number;
  target: number;
  atr: number;
  bar: number;
  /** the meta-labeller's odds that this signal wins, when it has one */
  odds: number | null;
  setup: string;
  why: string;
}

/**
 * The strategy's call on the last closed bar: a new signal (one that switched
 * on at this bar), or null. Bars must be closed candles, oldest first.
 */
export function liveSignal(spec: StrategySpec, m: Market): LiveSignal | null {
  const n = m.bars.length;
  if (n < 60) return null;
  const c = ctxOf(m);
  const sig = signalOf(c, spec);
  const i = n - 1;
  const d = sig[i];
  if (!d || d === sig[i - 1]) return null;
  const a = atr14(c)[i];
  if (!Number.isFinite(a) || a <= 0) return null;
  let odds: number | null = null;
  if (spec.meta?.model) {
    const row = [...features(c)[i], d];
    if (row.every(Number.isFinite)) {
      odds = predictForest(spec.meta.model, row);
      if (odds < spec.meta.threshold) return null;
    }
  }
  const px = m.bars[i].close;
  const risk = spec.exit.stopAtr * a;
  // no target in the rules: the trade is managed by trail, time and flip; the
  // swarm still needs a level for its reward-to-risk, so 4R stands in
  const tR = spec.exit.targetR > 0 ? spec.exit.targetR : 4;
  const rule = rulesOf(spec, m.tfH)[0].replace(/^Entry: /, '');
  return {
    side: d > 0 ? 'buy' : 'sell',
    price: px,
    stop: px - d * risk,
    target: px + d * tR * risk,
    atr: a,
    bar: m.bars[i].time,
    odds,
    setup: spec.name,
    why: `${rule}${odds !== null ? ` — the forest gives it ${(odds * 100).toFixed(0)}%` : ''}`,
  };
}

/** the strategy's current direction on the last closed bar (for "an opposite signal closes it") */
export function liveDirection(spec: StrategySpec, m: Market): number {
  if (m.bars.length < 60) return 0;
  const sig = signalOf(ctxOf(m), spec);
  return sig[sig.length - 1];
}

export interface LivePos {
  side: 'buy' | 'sell';
  entry: number;
  stop: number;
  target: number;
  risk: number;
  atr?: number;
  openedAt: number;
  trailed?: boolean;
}

/**
 * Manage an open Lab trade on a price tick with the strategy's exits: stop,
 * target (only if the rules have one), trailing from +1R, time limit.
 * Mutates pos.stop when trailing. Returns { exit } | { note } | null.
 */
export function manageLab(pos: LivePos, spec: StrategySpec, tfH: number, price: number, now: number): { exit: string } | { note: string } | null {
  const dir = pos.side === 'buy' ? 1 : -1;
  if ((price - pos.stop) * dir <= 0) return { exit: pos.trailed ? 'trail' : 'stop' };
  if (spec.exit.targetR > 0 && (price - pos.target) * dir >= 0) return { exit: 'target' };
  if (now - pos.openedAt >= spec.exit.maxBars * tfH * 3_600_000) return { exit: 'time' };
  const R = ((price - pos.entry) * dir) / pos.risk;
  if (spec.exit.trailAtr > 0 && pos.atr && R >= 1) {
    const t = price - dir * spec.exit.trailAtr * pos.atr;
    if ((t - pos.stop) * dir > pos.atr * 0.25) {
      pos.stop = t;
      const first = !pos.trailed;
      pos.trailed = true;
      if (first) return { note: `up ${R.toFixed(1)}R — trailing the stop ${spec.exit.trailAtr} ATR behind price, as the strategy's rules say` };
    }
  }
  return null;
}
