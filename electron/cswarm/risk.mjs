// The crypto swarm's risk manager: it compounds and it keeps the account alive.
//
// Compounding: every trade risks a share of what the account is worth NOW, so
// wins grow the next trade and losses shrink it (fixed-fractional sizing;
// Kelly 1956, and the fractional-Kelly practice of Thorp and MacLean & Ziemba —
// a quarter of the Kelly bet keeps most of the growth for far less ruin risk).
// Its leverage is a consequence of the stop, never a target: the position is
// sized from the risk, then capped by the leverage allowed.
//
// Staying alive: a daily loss limit, size cuts in a drawdown, a pause after a
// losing streak, an account floor that rises with profits (once the account is
// 1.25× its start, it stops trading before giving back more than a fifth of its
// high), and at most a few positions at once.

export const RISK_DEFAULTS = {
  /** % of the account risked on a trade (loss at the stop), before the multipliers */
  riskPct: 1,
  minRiskPct: 0.25,
  maxRiskPct: 2,
  /** share of the Kelly bet, once there are minTrades closed trades */
  kellyShare: 0.25,
  minTrades: 20,
  /** all open positions together at most this × the account; each coin at most perCoinLeverage × */
  maxLeverage: 3,
  perCoinLeverage: 3,
  maxOpen: 2,
  /** no new trade for the day once the day is down this % */
  dailyLossPct: 5,
  /** three-quarter size this far under the high, half size at ddCut2 */
  ddCut1: 0.1,
  ddCut2: 0.2,
  /** losses in a row → pause */
  lossStreak: 3,
  pauseMin: 60,
  /** stop trading under this share of the start… */
  floorShare: 0.7,
  /** …and once the account reaches lockAt × start, under lockShare × its high */
  lockAt: 1.25,
  lockShare: 0.8,
  /** the exchange's smallest order (Hyperliquid: $10) */
  minNotional: 10,
};

const localDay = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

export function newBook(start, now = Date.now()) {
  return { start, peak: start, floor: 0, dayKey: localDay(now), dayStart: start, streak: 0, pausedUntil: 0, closedR: [] };
}

/** Follow the account: its high, the day, the floor. */
export function updateBook(book, equity, cfg = RISK_DEFAULTS, now = Date.now()) {
  const b = { ...book };
  if (!(equity > 0)) return b;
  if (!(b.start > 0)) b.start = equity;
  b.peak = Math.max(b.peak || equity, equity);
  const day = localDay(now);
  if (b.dayKey !== day) {
    b.dayKey = day;
    b.dayStart = equity;
  }
  const base = b.start * cfg.floorShare;
  const lock = b.peak >= b.start * cfg.lockAt ? Math.max(b.start, b.peak * cfg.lockShare) : 0;
  b.floor = Math.max(b.floor || 0, base, lock);
  return b;
}

/** Money moved in or out (not a gain or a loss): the record moves with it. */
export function shiftBook(book, moved) {
  return { ...book, start: book.start + moved, peak: book.peak + moved, dayStart: book.dayStart + moved, floor: Math.max(0, (book.floor || 0) + moved) };
}

/** After a trade closes. */
export function recordClose(book, r, cfg = RISK_DEFAULTS, now = Date.now()) {
  const streak = r < 0 ? book.streak + 1 : 0;
  return {
    ...book,
    streak,
    pausedUntil: cfg.lossStreak > 0 && streak >= cfg.lossStreak ? now + cfg.pauseMin * 60_000 : book.pausedUntil,
    closedR: [...book.closedR, r].slice(-50),
  };
}

/** Why the swarm may not open a trade now (null = it may). */
export function riskGate(book, equity, openCount, cfg = RISK_DEFAULTS, now = Date.now()) {
  if (!(equity > 0)) return 'the account value is not known yet';
  if (book.pausedUntil > now) return `${book.streak} losses in a row — pausing until ${new Date(book.pausedUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (book.dayStart > 0 && (book.dayStart - equity) / book.dayStart >= cfg.dailyLossPct / 100) return `down ${(((book.dayStart - equity) / book.dayStart) * 100).toFixed(1)}% today — the daily limit is ${cfg.dailyLossPct}%; back tomorrow`;
  if (book.floor > 0 && equity < book.floor) return `the account ($${equity.toFixed(2)}) is under its floor ($${book.floor.toFixed(2)}) — protecting what is left`;
  if (openCount >= cfg.maxOpen) return `${openCount} positions open — the most at once is ${cfg.maxOpen}`;
  return null;
}

/** Kelly from the record: the fraction of the account a 1R bet should risk (0 without an edge). */
export function kellyOf(rs) {
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  if (!wins.length || !losses.length) return null;
  const p = wins.length / rs.length;
  const W = wins.reduce((a, b) => a + b, 0) / wins.length;
  const L = Math.max(0.1, -losses.reduce((a, b) => a + b, 0) / losses.length);
  // bet risking L to win W: f* = p/L − (1−p)/W
  return Math.max(0, p / L - (1 - p) / W);
}

/**
 * The position size for a candidate.
 * @param o { price, stop, side, equity, book, openNotional, expR, maxLev, sizeMult }
 * @returns {{ qty, notional, riskUsd, riskPct, mult, lev, why } | { skip: string }}
 */
export function sizeTrade(o, cfg = RISK_DEFAULTS) {
  const { price, stop, equity, book } = o;
  const unit = Math.abs(price - stop);
  if (!(unit > 0) || !(price > 0) || !(equity > 0)) return { skip: 'no stop distance or no account value' };
  const notes = [];
  let mult = 1;
  const k = book.closedR.length >= cfg.minTrades ? kellyOf(book.closedR) : null;
  if (k !== null) {
    const kellyRisk = k * cfg.kellyShare * 100;
    const m = Math.max(0.5, Math.min(1.5, kellyRisk / cfg.riskPct));
    mult *= m;
    notes.push(`edge ${m.toFixed(2)}×`);
  }
  const dd = book.peak > 0 ? (book.peak - equity) / book.peak : 0;
  if (dd >= cfg.ddCut2) (mult *= 0.5), notes.push(`drawdown ${(dd * 100).toFixed(0)}%: half size`);
  else if (dd >= cfg.ddCut1) (mult *= 0.75), notes.push(`drawdown ${(dd * 100).toFixed(0)}%: ¾ size`);
  // a Lab strategy's own tested sizing (volatility target or VaR budget), already clamped
  if (Number.isFinite(o.sizeMult) && o.sizeMult !== 1) {
    const m = Math.max(0.5, Math.min(1.5, o.sizeMult));
    mult *= m;
    notes.push(`strategy sizing ${m.toFixed(2)}×`);
  }
  if (Number.isFinite(o.expR)) {
    if (o.expR >= 0.3) (mult *= 1.15), notes.push('strong odds +15%');
    else if (o.expR < 0) (mult *= 0.75), notes.push('weak odds −25%');
  }
  const riskPct = Math.max(cfg.minRiskPct, Math.min(cfg.maxRiskPct, cfg.riskPct * mult));
  const riskUsd = (equity * riskPct) / 100;
  let qty = riskUsd / unit;
  const lev = Math.max(1, Math.min(cfg.perCoinLeverage, o.maxLev ?? cfg.perCoinLeverage));
  const room = Math.max(0, equity * cfg.maxLeverage - (o.openNotional ?? 0));
  const cap = Math.min(equity * lev, room);
  if (qty * price > cap) {
    qty = cap / price;
    notes.push(`capped at ${(cap / equity).toFixed(1)}× leverage`);
  }
  if (qty * price < cfg.minNotional) {
    // the smallest order: take it only if its risk stays within the limit
    const minQty = (cfg.minNotional * 1.02) / price;
    const minRisk = minQty * unit;
    if (minRisk > (equity * cfg.maxRiskPct) / 100) return { skip: `the smallest order ($${cfg.minNotional}) would risk ${((minRisk / equity) * 100).toFixed(1)}% of the account — over the ${cfg.maxRiskPct}% limit; a tighter stop or a bigger account is needed` };
    if (minQty * price > cap) return { skip: `the smallest order ($${cfg.minNotional}) needs more leverage than allowed` };
    qty = minQty;
    notes.push(`the $${cfg.minNotional} minimum`);
  }
  const notional = qty * price;
  return { qty, notional, riskUsd: qty * unit, riskPct: ((qty * unit) / equity) * 100, mult, lev: notional / equity, why: notes.join(', ') };
}
