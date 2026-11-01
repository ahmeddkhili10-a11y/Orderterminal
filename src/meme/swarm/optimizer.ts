// The Optimizer: the swarm's risk and portfolio officer. It does not pick
// coins; it decides how much each pick gets, whether the book can take another
// one, and when a winner has grown too big for the account — to keep the
// account alive first and in the green once it gets there.
//
//  1. Edge sizing: once there are 10 closed trades, the win rate and the
//     average win and loss give the Kelly fraction; the swarm bets half of it
//     (full Kelly is too wild for fat-tailed meme coins), scaled between 0.5×
//     and 1.25× of the normal trade. No proven edge → half size.
//  2. Conviction tilt: a 95 gets a little more than an 80 (0.85× to 1.15×).
//  3. Drawdown throttle: 15 % under the account's high → three-quarter size;
//     25 % under → half size. Losing streaks shrink the bets that cause them.
//  4. Good-day lock: once the day is up 30 %, half size for the rest of it —
//     a good day is not handed back.
//  5. Profit lock: once the account has reached 1.5× its start, the floor rises
//     to the start or 70 % of the high, whichever is more — the swarm stops
//     buying before it can fall back into the red.
//  6. Portfolio heat: no new trade while the open coins together are down more
//     than 12 % of the account.
//  7. No doubling up on one narrative: two coins on the same meme move together
//     and rug together.
//  8. Concentration trim: a winner worth more than half the account is sold
//     back to 35 % of it — the gain is banked, the rest keeps running.
import { memeWords } from './agents';
import type { Position } from './book';

export interface RiskBook {
  /** the account when the swarm was set up (SOL) */
  startSol: number;
  /** the account's high (SOL) */
  peakSol: number;
  /** local day of `dayStartSol` (YYYY-MM-DD) */
  day: string;
  dayStartSol: number;
}

export interface OptimizerConfig {
  /** off: plain sizes, no throttles, trims or extra gates */
  enabled: boolean;
  /** bet this share of the Kelly fraction (0.5 = half Kelly) */
  kellyShare: number;
  /** closed trades needed before the edge counts */
  minTrades: number;
  /** drawdown from the high that cuts size to 0.75×, then to 0.5× */
  ddCut1: number;
  ddCut2: number;
  /** the day's gain that halves size for the rest of it */
  dayLock: number;
  /** account multiple that raises the floor… */
  profitLockAt: number;
  /** …to the start, or this share of the high */
  profitLockShare: number;
  /** most the open coins may be down together, share of the account */
  heatMax: number;
  /** no second coin on a narrative already held */
  oneNarrative: boolean;
  /** a coin worth more than this share of the account… */
  concentrationMax: number;
  /** …is sold back to this share */
  trimTo: number;
}

export const OPTIMIZER_DEFAULTS: OptimizerConfig = {
  enabled: true,
  kellyShare: 0.5,
  minTrades: 10,
  ddCut1: 0.15,
  ddCut2: 0.25,
  dayLock: 0.3,
  profitLockAt: 1.5,
  profitLockShare: 0.7,
  heatMax: 0.12,
  oneNarrative: true,
  concentrationMax: 0.5,
  trimTo: 0.35,
};

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
export const localDay = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Track the account's start, high and the start of today. */
export function updateBook(book: RiskBook | undefined, equity: number, now: number): RiskBook {
  const day = localDay(now);
  const b = book && book.startSol > 0 ? { ...book } : { startSol: equity, peakSol: equity, day, dayStartSol: equity };
  b.peakSol = Math.max(b.peakSol, equity);
  if (b.day !== day) {
    b.day = day;
    b.dayStartSol = equity;
  }
  return b;
}

/** Money moved in or out (a deposit, a withdrawal, profits sent home): shift the record so it is not read as a gain or a loss. */
export function shiftBook(book: RiskBook, sol: number): RiskBook {
  const f = (x: number) => Math.max(0.001, x + sol);
  return { ...book, startSol: f(book.startSol), peakSol: f(book.peakSol), dayStartSol: f(book.dayStartSol) };
}

export interface Edge {
  trades: number;
  winRate: number;
  /** average win over average loss */
  payoff: number;
  /** full Kelly fraction of the account (can be ≤ 0: no edge) */
  kelly: number;
}

/** The record so far: win rate, payoff and Kelly fraction from closed trades (null until there are any). */
export function edgeOf(closed: Position[]): Edge | null {
  const r = closed.filter((p) => p.closedAt && p.costSol > 0).map((p) => p.realizedSol / p.costSol - 1);
  if (!r.length) return null;
  const wins = r.filter((x) => x > 0);
  const losses = r.filter((x) => x <= 0);
  const winRate = wins.length / r.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? -losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const payoff = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;
  const kelly = !losses.length ? 1 : !wins.length ? -1 : winRate - (1 - winRate) / payoff;
  return { trades: r.length, winRate, payoff, kelly };
}

export interface OptimizerRead {
  /** multiply the normal trade size by this */
  sizeMult: number;
  /** the floor in force (the Manager's, or higher once profits are locked) */
  floorSol: number;
  /** why no trade may open now (portfolio level), or null */
  gate: string | null;
  edge: Edge | null;
  drawdown: number;
  dayGain: number;
  /** open coins' loss now, share of the account (0 when they are up) */
  heat: number;
  /** 0–100: how comfortable the book is */
  health: number;
  /** what is shaping the size, in words */
  notes: string[];
}

/**
 * The book as a whole: how big the next trade should be, the floor in force,
 * and whether the portfolio can take another position at all.
 */
export function optimize(cfg: OptimizerConfig, book: RiskBook, equity: number, closed: Position[], open: { costSol: number; valueSol: number }[], managerFloor: number, baseShare: number): OptimizerRead {
  const notes: string[] = [];
  const drawdown = book.peakSol > 0 ? Math.max(0, 1 - equity / book.peakSol) : 0;
  const dayGain = book.dayStartSol > 0 ? equity / book.dayStartSol - 1 : 0;
  const openLoss = open.reduce((a, p) => a + Math.min(0, p.valueSol - p.costSol), 0);
  const heat = equity > 0 ? -openLoss / equity : 0;
  const edge = edgeOf(closed);
  let floorSol = managerFloor;
  if (!cfg.enabled) return { sizeMult: 1, floorSol, gate: null, edge, drawdown, dayGain, heat, health: 100, notes: ['optimizer off'] };
  // 1. size from the edge
  let mult = 1;
  if (edge && edge.trades >= cfg.minTrades) {
    if (edge.kelly <= 0) {
      mult = 0.5;
      notes.push(`no edge yet over ${edge.trades} trades (${Math.round(edge.winRate * 100)}% won, payoff ${edge.payoff.toFixed(1)}) — half size`);
    } else {
      mult = clamp((edge.kelly * cfg.kellyShare) / baseShare, 0.5, 1.25);
      notes.push(`edge over ${edge.trades} trades: ${Math.round(edge.winRate * 100)}% won, payoff ${edge.payoff.toFixed(1)} → ${mult.toFixed(2)}× size`);
    }
  } else notes.push(`learning the edge (${edge?.trades ?? 0}/${cfg.minTrades} trades) — normal size`);
  // 3. drawdown
  if (drawdown >= cfg.ddCut2) {
    mult *= 0.5;
    notes.push(`${Math.round(drawdown * 100)}% under the high — half size`);
  } else if (drawdown >= cfg.ddCut1) {
    mult *= 0.75;
    notes.push(`${Math.round(drawdown * 100)}% under the high — three-quarter size`);
  }
  // 4. a good day
  if (dayGain >= cfg.dayLock) {
    mult *= 0.5;
    notes.push(`up ${Math.round(dayGain * 100)}% today — half size to keep the day`);
  }
  // 5. profits locked in
  if (book.startSol > 0 && book.peakSol >= book.startSol * cfg.profitLockAt) {
    const lock = Math.max(book.startSol, book.peakSol * cfg.profitLockShare);
    if (lock > floorSol) {
      floorSol = lock;
      notes.push(`profits locked: the floor is now ${lock.toFixed(3)} SOL`);
    }
  }
  // 6. the book is bleeding
  let gate: string | null = null;
  if (heat > cfg.heatMax) gate = `the open coins are down ${Math.round(heat * 100)}% of the account together — no new trade until they recover or close`;
  else if (floorSol > managerFloor && equity < floorSol) gate = `the account (${equity.toFixed(3)} SOL) fell to its locked-in profit floor of ${floorSol.toFixed(3)} SOL — buying stopped to stay in the green`;
  const health = Math.round(clamp(100 - drawdown * 200 - heat * 250 - (edge && edge.trades >= cfg.minTrades && edge.kelly <= 0 ? 20 : 0), 0, 100));
  return { sizeMult: clamp(mult, 0.25, 1.25), floorSol, gate, edge, drawdown, dayGain, heat, health, notes };
}

/** A 95 gets a little more than the minimum conviction: 0.85× at the minimum, 1.15× at 100. */
export function convictionTilt(conviction: number, minConviction: number) {
  const span = Math.max(1, 100 - minConviction);
  return clamp(0.85 + (0.3 * (conviction - minConviction)) / span, 0.85, 1.15);
}

/** The narrative the candidate shares with a coin already held, or null. */
export function sharedNarrative(name: string, symbol: string, held: { name: string; symbol: string }[]): string | null {
  const words = new Set(memeWords(name, symbol));
  for (const h of held) for (const w of memeWords(h.name, h.symbol)) if (words.has(w)) return w;
  return null;
}

/** Share of a position to sell to bring it back to `trimTo` of the account, or null when it is not too big (or not a winner). */
export function trimShare(valueSol: number, equity: number, mult: number, cfg: OptimizerConfig): number | null {
  if (!cfg.enabled || !(equity > 0) || !(valueSol > 0) || mult < 2) return null;
  if (valueSol / equity <= cfg.concentrationMax) return null;
  return clamp(1 - (cfg.trimTo * equity) / valueSol, 0.05, 0.95);
}
