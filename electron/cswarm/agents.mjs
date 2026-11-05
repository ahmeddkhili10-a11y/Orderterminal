// The Trend agent (hourly breakouts in the direction of the daily trend) and
// the shadow book (the trades the council turned down, followed anyway, so the
// forest also learns what refusing cost or saved).
import { trendSignal } from '../amt/trend.mjs';

export const TREND_AGENT_DEFAULTS = { donchian: 20, atr: 14, stopAtr: 2, targetAtr: 4, beAtR: 1, trailAtR: 2, trailAtr: 2, maxHoldH: 72 };

/** Average true range of hourly rows {time, open, high, low, close} (oldest first). */
export function atrOf(rows, n = 14) {
  if (rows.length < n + 1) return null;
  let s = 0;
  for (let i = rows.length - n; i < rows.length; i++) {
    const r = rows[i];
    const pc = rows[i - 1].close;
    s += Math.max(r.high - r.low, Math.abs(r.high - pc), Math.abs(r.low - pc));
  }
  return s / n;
}

/** The daily trend from daily rows {time, close}: dir ±1 and the lookbacks that are up. */
export function dailyTrendOf(rows) {
  const sig = trendSignal(
    rows.map((r) => r.close),
    { trendShort: true, targetVol: 1e9, maxExposure: 1 },
  );
  if (!sig.ready) return null;
  return { dir: Math.sign(sig.strength) || 0, up: sig.votes.filter((v) => v.vote > 0).length, votes: sig.votes };
}

/**
 * A breakout on the last CLOSED hourly bar, in the daily trend's direction
 * (2 of 3 lookbacks or more), or null.
 */
export function trendCandidate(rows, daily, cfg = TREND_AGENT_DEFAULTS, now = Date.now()) {
  const closed = rows.filter((r) => r.time + 3_600_000 <= now);
  if (closed.length < cfg.donchian + 2 || !daily) return null;
  const last = closed[closed.length - 1];
  const prior = closed.slice(-1 - cfg.donchian, -1);
  const hi = Math.max(...prior.map((r) => r.high));
  const lo = Math.min(...prior.map((r) => r.low));
  const atr = atrOf(closed, cfg.atr);
  if (!atr) return null;
  const longOk = daily.dir > 0 && daily.up >= 2;
  const shortOk = daily.dir < 0 && 3 - daily.up >= 2;
  if (longOk && last.close > hi)
    return { side: 'buy', price: last.close, stop: last.close - cfg.stopAtr * atr, target: last.close + cfg.targetAtr * atr, bar: last.time, atr, setup: 'trend breakout', why: `closed above the ${cfg.donchian}-hour high (${hi.toFixed(2)}) with the daily trend up (${daily.up}/3)` };
  if (shortOk && last.close < lo)
    return { side: 'sell', price: last.close, stop: last.close + cfg.stopAtr * atr, target: last.close - cfg.targetAtr * atr, bar: last.time, atr, setup: 'trend breakdown', why: `closed below the ${cfg.donchian}-hour low (${lo.toFixed(2)}) with the daily trend down (${3 - daily.up}/3)` };
  return null;
}

/**
 * The Trend agent's own trade management, on each price. Mutates pos.stop;
 * returns { exit: reason } | { note: text } | null.
 */
export function manageTrend(pos, p, t, cfg = TREND_AGENT_DEFAULTS) {
  const dir = pos.side === 'buy' ? 1 : -1;
  const R = (p - pos.entry) * dir / pos.risk;
  if ((p - pos.stop) * dir <= 0) return { exit: pos.trailed ? 'trail' : pos.be ? 'breakeven' : 'stop' };
  if ((p - pos.target) * dir >= 0) return { exit: 'target' };
  if (t - pos.openedAt >= cfg.maxHoldH * 3_600_000) return { exit: 'time' };
  if (!pos.be && R >= cfg.beAtR) {
    pos.stop = pos.entry;
    pos.be = true;
    return { note: `up ${R.toFixed(1)}R — stop to break-even (${pos.entry}): this trade can no longer lose` };
  }
  if (R >= cfg.trailAtR && pos.atr) {
    const trail = p - dir * cfg.trailAtr * pos.atr;
    if ((trail - pos.stop) * dir > pos.atr * 0.25) {
      pos.stop = trail;
      const first = !pos.trailed;
      pos.trailed = true;
      if (first) return { note: `up ${R.toFixed(1)}R — trailing the stop ${cfg.trailAtr} ATR behind price (now ${trail.toFixed(2)}) to let the trend run` };
    }
  }
  return null;
}

/** Trades not taken, followed to their stop, target or time limit. */
export class Shadow {
  constructor(max = 200) {
    this.max = max;
    this.open = [];
  }
  add(s) {
    this.open.push(s);
    if (this.open.length > this.max) this.open.shift();
  }
  /** A price on a coin: the shadow trades it settles, as { x, r, agent }. */
  onPrice(coin, p, t) {
    const done = [];
    this.open = this.open.filter((s) => {
      if (s.coin !== coin) return true;
      const dir = s.side === 'buy' ? 1 : -1;
      const risk = Math.abs(s.entry - s.stop);
      let r = null;
      if ((p - s.stop) * dir <= 0) r = -1;
      else if ((p - s.target) * dir >= 0) r = Math.abs(s.target - s.entry) / risk;
      else if (t - s.t >= s.maxHoldMs) r = ((p - s.entry) * dir) / risk;
      if (r === null) return true;
      done.push({ x: s.x, r: r - (s.costR ?? 0), agent: s.agent });
      return false;
    });
    return done;
  }
}
