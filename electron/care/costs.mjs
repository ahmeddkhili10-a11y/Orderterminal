// What trading really costs: measured from your own live trades.
//
// Slippage is the gap between the price a decision was made at (the signal, or
// the price when the exit was called) and the price the exchange actually
// filled — latency and the spread included. Fees are the exchange's own, when
// it reports them; otherwise the assumed rate is all there is.
//
// The Strategy Lab and the edge finder test with these numbers once there are
// enough live trades — but never cheaper than their own assumption: a few lucky
// fills do not make every future test rosier.

/** live trades needed before a venue's measured costs are used */
export const MIN_COST_TRADES = 10;
const MAX_LEG_BPS = 200; // a fill 2 % from its decision price is an outage or a gap, not a cost

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** the cost of one fill against its decision price, in basis points (positive = paid) */
export function legBps(side, ask, fill, leg) {
  if (!(ask > 0) || !(fill > 0)) return null;
  // buying above the decision price costs; so does selling below it
  const buy = leg === 'entry' ? side === 'buy' : side !== 'buy';
  const bps = ((buy ? fill - ask : ask - fill) / ask) * 1e4;
  return Math.abs(bps) > MAX_LEG_BPS ? null : bps;
}

/**
 * Measured costs per venue from journal rows (live trades only).
 * @returns {{ [venue: string]: { n: number, slips: number, slipBps: number|null, slipAvgBps: number|null, feeBps: number|null, feeTrades: number, roundTripBps: number|null } }}
 */
export function measureCosts(rows, { assumedFeeBps = 4.5 } = {}) {
  const by = {};
  for (const r of rows) {
    if (r.mode !== 'live' || !r.venue || r.venue === 'paper') continue;
    const v = (by[r.venue] ??= { n: 0, legs: [], fees: [] });
    v.n++;
    if (r.fills_real) {
      for (const leg of ['entry', 'exit']) {
        const b = legBps(r.side, r[`ask_${leg}`], r[leg], leg);
        if (b !== null) v.legs.push(b);
      }
    }
    const notional = (Math.abs(r.entry) + Math.abs(r.exit)) * Math.abs(r.qty);
    if (r.fee_real && notional > 0 && Number.isFinite(r.fees)) v.fees.push((r.fees / notional) * 1e4);
  }
  const out = {};
  for (const [venue, v] of Object.entries(by)) {
    const slip = median(v.legs);
    const fee = v.fees.length ? median(v.fees) : null;
    out[venue] = {
      n: v.n,
      slips: v.legs.length,
      slipBps: slip,
      slipAvgBps: mean(v.legs),
      feeBps: fee,
      feeTrades: v.fees.length,
      // a round trip pays the fee and the slippage twice (in and out)
      roundTripBps: slip === null ? null : 2 * (Math.max(0, slip) + (fee ?? assumedFeeBps)),
    };
  }
  return out;
}

/**
 * The costs a test should use: the assumption, raised to what the live trades
 * measured once there are enough of them (never lowered).
 * @returns {{ feeBps: number, slipBps: number, measured: boolean, n: number, venue: string|null, why: string }}
 */
export function costsForTests(measured, assumed = { feeBps: 4.5, slipBps: 2 }, venue = null) {
  const pick = venue && measured[venue] ? [venue, measured[venue]] : Object.entries(measured).sort((a, b) => b[1].slips - a[1].slips)[0];
  if (!pick) return { ...assumed, measured: false, n: 0, venue: null, why: 'no live trades yet — the assumed costs' };
  const [v, m] = pick;
  const slipOk = m.slips >= MIN_COST_TRADES && m.slipBps !== null;
  const feeOk = m.feeTrades >= MIN_COST_TRADES && m.feeBps !== null;
  if (!slipOk && !feeOk) return { ...assumed, measured: false, n: m.n, venue: v, why: `${m.n} live trade${m.n === 1 ? '' : 's'} on ${v} — the measured costs are used from ${MIN_COST_TRADES}` };
  const slipBps = slipOk ? Math.max(assumed.slipBps, m.slipBps) : assumed.slipBps;
  const feeBps = feeOk ? Math.max(assumed.feeBps, m.feeBps) : assumed.feeBps;
  const raised = slipBps > assumed.slipBps || feeBps > assumed.feeBps;
  return {
    feeBps: round2(feeBps),
    slipBps: round2(slipBps),
    measured: true,
    n: m.n,
    venue: v,
    why: raised ? `measured on ${m.n} live trades on ${v}: slippage ${round2(m.slipBps ?? 0)} bps a fill${feeOk ? `, fees ${round2(m.feeBps)} bps` : ''} — the tests use these` : `measured on ${m.n} live trades on ${v}: within the assumed costs, which stay`,
  };
}

const round2 = (x) => Math.round(x * 100) / 100;
