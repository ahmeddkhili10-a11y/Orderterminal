// The Luno lane: real crypto against rands on Luno, beside the meme swarm.
// One spot trend bot per pair (the research-backed daily momentum strategy),
// each sizing from its share of the ZAR on the account, so together they never
// spend more than is there. Optional: nothing here runs until it is started.
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { AmtBot, AmtBotInput, AmtEvent, AmtParams, CcxtMarket } from '../desktop/bridge';
import { desktop } from '../desktop/bridge';
import { onAmtEvent } from '../desktop/amt';
import { alertHere } from '../meme/swarm/notify';
import { escapeHtml } from '../shared/telegram';
import { getSettings } from '../store/settings';

export const LUNO = 'luno';
export const LANE_PREFIX = 'Luno lane · ';
/** the big, liquid rand pairs, in the order they are offered */
export const LUNO_DEFAULT_PAIRS = ['BTC/ZAR', 'ETH/ZAR', 'SOL/ZAR', 'XRP/ZAR'];
/** paper fills cost at least this (Luno's taker fee on rand pairs is around this or less); live uses the market's own fee when higher */
export const LUNO_PAPER_FEE_BPS = 60;

export interface LunoLaneConfig {
  secretId: string;
  pairs: string[];
  /** rands the lane trades with, split evenly across its pairs */
  bankZar: number;
  mode: 'paper' | 'live';
}

export const LUNO_DEFAULTS: LunoLaneConfig = { secretId: '', pairs: ['BTC/ZAR', 'ETH/ZAR'], bankZar: 500, mode: 'paper' };

export const useLuno = create<LunoLaneConfig & { set(p: Partial<LunoLaneConfig>): void }>()(
  persist(
    (set) => ({
      ...LUNO_DEFAULTS,
      set: (p) => set(p),
    }),
    {
      name: 'novus-luno',
      storage: createJSONStorage(() => localStorage),
      merge: (persisted, current) => ({ ...current, ...LUNO_DEFAULTS, ...(persisted as Partial<LunoLaneConfig>) }),
    },
  ),
);

/** Spot pairs quoted in rands, the default ones first, then by name. */
export function zarPairs(markets: CcxtMarket[]): CcxtMarket[] {
  const rank = (s: string) => {
    const i = LUNO_DEFAULT_PAIRS.indexOf(s);
    return i < 0 ? LUNO_DEFAULT_PAIRS.length : i;
  };
  return markets.filter((m) => m.quote === 'ZAR' && !m.contract && (m.type === 'spot' || !m.type)).sort((a, b) => rank(a.symbol) - rank(b.symbol) || a.symbol.localeCompare(b.symbol));
}

/** A lane bot: a trend bot on Luno, named by the lane. */
export function isLaneBot(b: Pick<AmtBot, 'name' | 'exchangeId' | 'params'>): boolean {
  return b.exchangeId === LUNO && b.params.style === 'trend' && b.name.startsWith(LANE_PREFIX);
}

/** Each pair's share of the bank, in rands. */
export function shareZar(cfg: Pick<LunoLaneConfig, 'bankZar' | 'pairs'>): number {
  return cfg.pairs.length ? cfg.bankZar / cfg.pairs.length : 0;
}

/**
 * Whether a pair's share can trade at all: the trend bot holds part of its
 * share, so the share must cover a few of the market's smallest orders.
 */
export function shareFits(share: number, minOrderZar: number | null): boolean {
  if (!(share > 0)) return false;
  if (!(minOrderZar && minOrderZar > 0)) return true;
  return share >= 3 * minOrderZar;
}

/** The trend bot for one pair of the lane. */
export function laneBot(trend: AmtParams, symbol: string, cfg: LunoLaneConfig, id?: string): AmtBotInput {
  const n = Math.max(1, cfg.pairs.length);
  return {
    id,
    name: `${LANE_PREFIX}${symbol}`,
    mode: cfg.mode,
    exchangeId: LUNO,
    symbol,
    secretId: cfg.secretId || null,
    exchangeStop: false,
    params: { ...trend, style: 'trend', sizing: 'balance', accountUsd: cfg.bankZar / n, capitalShare: 1 / n, feeBps: Math.max(trend.feeBps, LUNO_PAPER_FEE_BPS), slippageBps: 0, trendShort: false },
  };
}

export const fmtZar = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `R${v.toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** The alert for a lane bot's event, or null for the ones that stay in its log. */
export function laneAlert(e: Pick<AmtEvent, 'kind' | 'text'>, symbol: string, mode: 'paper' | 'live'): { title: string; text: string; tone: 'buy' | 'sell' | 'warn' } | null {
  const tag = mode === 'live' ? 'LIVE' : 'paper';
  if (e.kind === 'trade') {
    const buy = /^BUY\b/.test(e.text);
    return { title: `Luno · ${symbol} · ${buy ? 'bought' : 'sold'} (${tag})`, text: e.text, tone: buy ? 'buy' : 'sell' };
  }
  if (e.kind === 'error') return { title: `Luno · ${symbol} · problem (${tag})`, text: e.text, tone: 'warn' };
  return null;
}

let lane = new Map<string, AmtBot>();
let alertsOn = false;

async function reloadLane() {
  if (!desktop) return;
  try {
    lane = new Map((await desktop.amt.list()).filter(isLaneBot).map((b) => [b.id, b]));
  } catch {
    /* keep what we had */
  }
}

/** Lane trades and failures: a toast and system notification here, and Telegram (the swarm's alert settings). */
export function startLunoAlerts() {
  if (!desktop || alertsOn) return;
  alertsOn = true;
  void reloadLane();
  onAmtEvent((e) => {
    if (e.kind === 'started' || e.kind === 'stopped') void reloadLane();
    const b = lane.get(e.id);
    if (!b) return;
    const a = laneAlert(e, b.symbol, b.mode);
    if (!a) return;
    alertHere(a.title, a.text, a.tone === 'warn' ? 'info' : a.tone);
    const s = getSettings();
    if (s.telegramSwarm && s.telegramSecretId) void desktop!.swarm.notify(s.telegramSecretId, `<b>${escapeHtml(a.title)}</b>\n${escapeHtml(a.text)}`).catch(() => undefined);
  });
}
