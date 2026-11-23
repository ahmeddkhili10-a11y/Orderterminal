// Will a strategy's trades actually be placed on an account this size?
//
// The edge finder's returns are percentages (positions at 1× the money, fees, slippage and
// funding as shares of the position), so they are the same on R500 as on R5 million. What is
// not is the exchange's smallest order: Hyperliquid takes no order under $10. The swarm sizes a
// trade from its stop (about 1 % of the account lost at the stop, less on probation); a trade
// that comes out under $10 is rounded up to the minimum — but only while the loss at its stop
// stays within 2 % of the account. Otherwise it is skipped. So on a small account, a strategy
// with wide stops (swing, position) has trades that can never be placed, and the ones that are
// placed risk more than planned. These numbers say how much of a strategy fits an account.
// The rules here are the same as the swarm's own (electron/cswarm/risk.mjs).

/** Hyperliquid's smallest order, in dollars (orders are placed 2 % over it, for price moves) */
export const MIN_ORDER_USD = 10;
const MIN_PLACED = MIN_ORDER_USD * 1.02;
/** the most of the account a trade may lose at its stop (risk.mjs maxRiskPct) */
export const MAX_RISK = 0.02;
/** the usual risk a trade (risk.mjs riskPct) */
export const PLAN_RISK = 0.01;
/** the most leverage a position may use (risk.mjs perCoinLeverage) */
export const MAX_LEVERAGE = 3;
/** a strategy fits an account when at least this share of its trades can be placed */
export const FIT_SHARE = 0.9;
/** the account the edge finder judges by until you say yours: about R1,000 */
export const DEFAULT_ACCOUNT_USD = 55;

/** the stop distance (a fraction of the entry price) at every 5 % of a strategy's trades, smallest first */
export function stopQuantiles(trades: readonly { entry: number; stop0: number }[]): number[] | undefined {
  const d = trades
    .map((t) => Math.abs(t.entry - t.stop0) / t.entry)
    .filter((x) => Number.isFinite(x) && x > 0)
    .sort((a, b) => a - b);
  if (!d.length) return undefined;
  return Array.from({ length: 21 }, (_, i) => {
    const q = (i / 20) * (d.length - 1);
    const lo = Math.floor(q);
    const v = d[lo] + (d[Math.min(d.length - 1, lo + 1)] - d[lo]) * (q - lo);
    return Math.round(v * 1e6) / 1e6;
  });
}

/** the share of trades whose stop distance is at most x (read off the quantiles, in between by straight line) */
function shareBelow(q: readonly number[], x: number): number {
  if (x < q[0]) return 0;
  if (x >= q[q.length - 1]) return 1;
  for (let i = 1; i < q.length; i++)
    if (x < q[i]) {
      const span = q[i] - q[i - 1];
      return (i - 1 + (span > 0 ? (x - q[i - 1]) / span : 1)) / (q.length - 1);
    }
  return 1;
}

export interface AccountFit {
  /** the account judged, in dollars (and in rand, when it was given in rand) */
  usd: number;
  zar?: number | null;
  /** the share of its trades that can be placed on that account */
  share: number;
  fits: boolean;
  /** the smallest account on which nine in ten of its trades can be placed, in dollars */
  needUsd: number;
  /** what its typical (middle) trade loses at the stop on that account, as a share of it: the planned 1 %, or more where the $10 minimum rounds it up */
  risk: number;
  /** its typical stop distance, a share of the price */
  stop: number;
}

/** how a strategy with these stop distances fits an account of `usd` dollars (null: its stops are not known yet) */
export function accountFit(stops: readonly number[] | undefined | null, usd: number, zar: number | null = null): AccountFit | null {
  if (!stops?.length || !(usd > 0)) return null;
  const tooSmall = MIN_PLACED > MAX_LEVERAGE * usd;
  const widest = (MAX_RISK * usd) / MIN_PLACED;
  const share = tooSmall ? 0 : shareBelow(stops, widest);
  const at = (p: number) => {
    const x = (p * (stops.length - 1));
    const lo = Math.floor(x);
    return stops[lo] + ((stops[Math.min(stops.length - 1, lo + 1)] ?? stops[lo]) - stops[lo]) * (x - lo);
  };
  const stop = at(0.5);
  const need = Math.max(MIN_PLACED / MAX_LEVERAGE, (at(FIT_SHARE) * MIN_PLACED) / MAX_RISK);
  // the planned position (1 % lost at the stop), no bigger than the leverage allows, no smaller than the minimum
  const planned = Math.min((PLAN_RISK * usd) / stop, MAX_LEVERAGE * usd);
  const risk = ((planned < MIN_ORDER_USD ? MIN_PLACED : planned) * stop) / usd;
  return { usd, zar, share, fits: share >= FIT_SHARE, needUsd: Math.ceil(need), risk, stop };
}

/** an account in words: rand when it was given in rand ("R1,000 ($55)"), dollars otherwise */
export const accountWords = (usd: number, zar?: number | null) =>
  zar ? `R${Math.round(zar).toLocaleString('en-US')} ($${Math.round(usd)})` : `$${Math.round(usd).toLocaleString('en-US')}`;

/** the account a strategy needs, in the same money the account was given in */
export const needWords = (f: AccountFit) => {
  const rate = f.zar && f.usd > 0 ? f.zar / f.usd : 0;
  return rate ? `R${(Math.ceil((f.needUsd * rate) / 100) * 100).toLocaleString('en-US')}` : `$${f.needUsd.toLocaleString('en-US')}`;
};

/** how a strategy fits your account, in words (the phone and the screen say the same) */
export function fitWords(f: AccountFit | null | undefined): string | null {
  if (!f) return null;
  const acct = accountWords(f.usd, f.zar);
  const pct = Math.round(f.share * 100);
  if (!f.fits) return `too wide for your ${acct} account: only ${pct} % of its trades can be placed on Hyperliquid ($10 smallest order) — it needs about ${needWords(f)}`;
  const risk = f.risk > 0.0105 ? ` — the $10 minimum makes its usual trade risk ${(f.risk * 100).toFixed(1)} % of the account, not 1 %` : '';
  return `fits your ${acct} account: ${pct} % of its trades can be placed on Hyperliquid${risk}`;
}
