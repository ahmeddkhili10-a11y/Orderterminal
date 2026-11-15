// Strategy health: is each deployed strategy still doing what its test said?
//
// A strategy that worked in its test can stop working when the market changes.
// This compares each deployed strategy's real trades since it was deployed
// (paper and live — both are trades on prices it had never seen) with what its
// test promised, and says plainly when the difference is more than bad luck:
//
//   too early   fewer than 8 trades — nothing can be told yet
//   on track    nothing worrying
//   behind      worse than the test, by more than luck usually explains: watch it
//   stopped     losing, or winning far less often than tested, with evidence: consider switching it off
//   quiet       no trades for much longer than the test says is normal
//
// It never switches anything off: deploying and retiring strategies is your decision.

export const MIN_HEALTH_TRADES = 8;
const DAY = 86_400_000;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs) => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
};

/** the deepest fall of the running total of R, in R */
export function drawdownR(rs) {
  let run = 0;
  let peak = 0;
  let dd = 0;
  for (const r of rs) {
    run += r;
    peak = Math.max(peak, run);
    dd = Math.max(dd, peak - run);
  }
  return dd;
}

/** One strategy's health. rows: its journal rows (oldest first). */
export function healthOf(d, rows, book = null, now = Date.now()) {
  const rs = rows.map((r) => (Number.isFinite(r.r) ? r.r : 0));
  const n = rs.length;
  const wins = rows.filter((r) => r.pnl > 0).length;
  const pnl = rows.reduce((a, r) => a + (r.pnl ?? 0), 0);
  const avgR = n ? mean(rs) : null;
  const winRate = n ? wins / n : null;
  const s = d.stats ?? {};
  const w0 = Number.isFinite(s.winRate) && s.winRate > 0 && s.winRate < 1 ? s.winRate : null;
  const base = {
    id: d.id,
    name: d.name ?? d.spec?.name ?? 'strategy',
    on: d.on !== false,
    deployedAt: d.deployedAt ?? null,
    trades: n,
    wins,
    winRate,
    avgR,
    totalR: n ? rs.reduce((a, b) => a + b, 0) : 0,
    pnl,
    ddR: drawdownR(rs),
    tested: { winRate: w0, avgR: Number.isFinite(s.avgR) ? s.avgR : null, sharpe: Number.isFinite(s.sharpe) ? s.sharpe : null, perYear: Number.isFinite(s.perYear) && s.perYear > 0 ? s.perYear : null },
    blocked: book ? { n: book.blocked ?? 0, shadowN: book.shadowN ?? 0, shadowR: book.shadowR ?? 0 } : null,
    lastAt: rows.length ? rows[rows.length - 1].closed : null,
  };
  // the signals tell when it last spoke; with none, quiet is measured from when it was deployed
  const since = Math.max(base.lastAt ?? 0, d.deployedAt ?? 0);
  const perYear = base.tested.perYear;
  const gapDays = perYear ? 365 / perYear : null;
  const quietDays = (now - since) / DAY;
  const quiet = gapDays !== null && quietDays > Math.max(14, 4 * gapDays);

  if (n < MIN_HEALTH_TRADES) {
    if (quiet) return { ...base, status: 'quiet', words: `no trades for ${Math.floor(quietDays)} days — its test traded about every ${fmtDays(gapDays)}. The market may not be giving it its setups, or the council is blocking it.` };
    return { ...base, status: 'early', words: `${n} of ${MIN_HEALTH_TRADES} trades — too early to tell` };
  }
  // is the average trade below zero by more than luck? (t on the trades' R)
  const se = sd(rs) / Math.sqrt(n);
  const t = se > 0 ? avgR / se : avgR < 0 ? -Infinity : 0;
  // does it win far less often than its test did? (binomial z)
  const z = w0 ? (wins - n * w0) / Math.sqrt(n * w0 * (1 - w0)) : null;
  base.t = Number.isFinite(t) ? t : null;
  base.z = z;
  const testWord = w0 ? `won ${pct(winRate)} of ${n} trades against ${pct(w0)} in its test` : `won ${pct(winRate)} of ${n} trades`;
  const rWord = `averaging ${signed(avgR)}R a trade`;
  if (n >= 12 && (t < -2 || (z !== null && z < -2.5))) return { ...base, status: 'stopped', words: `${testWord}, ${rWord}: more than bad luck. It may have stopped working — consider switching it off (DEPL).` };
  if (t < -1 || (z !== null && z < -1.64) || (avgR < 0 && base.ddR >= 6)) return { ...base, status: 'behind', words: `${testWord}, ${rWord}: worse than tested. Keep an eye on it.` };
  if (quiet) return { ...base, status: 'quiet', words: `${testWord}, but no trade for ${Math.floor(quietDays)} days — its test traded about every ${fmtDays(gapDays)}.` };
  return { ...base, status: 'ok', words: `${testWord}, ${rWord}: on track.` };
}

/** every deployed strategy, worst first */
export function strategyHealth(deployed, rowsById, labBook = {}, now = Date.now()) {
  const order = { stopped: 0, behind: 1, quiet: 2, ok: 3, early: 4 };
  return deployed.map((d) => healthOf(d, rowsById[d.id] ?? [], labBook[d.id] ?? null, now)).sort((a, b) => order[a.status] - order[b.status] || b.trades - a.trades);
}

/** the strategies whose health got worse since last time (each change is told once) */
export function worsened(prev, now) {
  const rank = { ok: 0, early: 0, quiet: 1, behind: 2, stopped: 3 };
  return now.filter((h) => h.on && rank[h.status] > (rank[prev[h.id]] ?? 0));
}

const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)}%`);
const signed = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x ?? 0).toFixed(2)}`;
const fmtDays = (d) => (d < 1 ? `${Math.max(1, Math.round(d * 24))} hours` : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`);
