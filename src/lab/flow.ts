// The bot builder: a crypto bot as a chain of blocks, each picked from a list
// written in plain English —
//
//   style → strategy → market model → forecast → risk → rules → backtest → deploy
//
// The style (scalping … a year's hold) sets the candles, the look-backs, the
// holding time and the stop width, so every other block works at that pace.
// buildSpec turns a chain into the Strategy Lab's StrategySpec; the Lab tests
// it on years of history (training on the first 70 %, judging on the last
// 30 % it never saw) and only then can it be deployed.
import type { RuleRef, Sizing, StrategySpec } from './backtest';
import { EXIT_DEFAULT, FILTER_MAP, SIGNAL_MAP, type Params } from './library';

export type StyleId = 'scalp' | 'intraday' | 'swing' | 'week' | 'position' | 'hold';

export interface Style {
  id: StyleId;
  name: string;
  /** what it means, in one line */
  plain: string;
  timeframe: '1h' | '4h' | '1d';
  tfH: number;
  /** years of history to test on */
  years: number;
  /** the typical look-back of its signals, in hours */
  L: number;
  /** how long a trade is held at most, in hours */
  holdH: number;
  /** the stop distance in ATR for a "normal" stop */
  stop: number;
  /** a note, when the style has a caveat */
  note?: string;
}

export const STYLES: Style[] = [
  { id: 'scalp', name: 'Scalping — quick trades, hours', plain: 'Many quick trades, in and out within a few hours, small moves.', timeframe: '1h', tfH: 1, years: 1, L: 12, holdH: 6, stop: 1.5, note: 'The Lab tests on 1-hour candles (the shortest with years of history). Seconds-to-minutes scalping on the live order book is the crypto swarm’s own Scalper agent.' },
  { id: 'intraday', name: 'Intraday — closed within a day', plain: 'Trades that open and close the same day.', timeframe: '1h', tfH: 1, years: 2, L: 24, holdH: 24, stop: 2 },
  { id: 'swing', name: 'Swing — a few days', plain: 'Catch a move that lasts two to five days.', timeframe: '4h', tfH: 4, years: 3, L: 72, holdH: 96, stop: 2.5 },
  { id: 'week', name: 'One-week trades', plain: 'Hold for about a week, riding the week’s direction.', timeframe: '4h', tfH: 4, years: 3, L: 168, holdH: 168, stop: 3 },
  { id: 'position', name: 'Position — weeks to months', plain: 'Ride a big trend for weeks or months; few trades.', timeframe: '1d', tfH: 24, years: 5, L: 720, holdH: 24 * 60, stop: 3 },
  { id: 'hold', name: 'Long-term hold — up to a year', plain: 'Buy into strength and hold through the year, stepping aside in bear markets.', timeframe: '1d', tfH: 24, years: 6, L: 2160, holdH: 24 * 365, stop: 4 },
];
export const STYLE_MAP = Object.fromEntries(STYLES.map((s) => [s.id, s])) as Record<StyleId, Style>;

export interface Option {
  id: string;
  /** the group it is listed under */
  group: string;
  name: string;
  plain: string;
  /** styles it suits best (listed first, marked ✓) */
  suits?: StyleId[];
}

const fast = (s: Style) => s.L <= 24;
const slow = (s: Style) => s.L >= 720;
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// ---------- 1. the base strategy (the entry rule) ----------

export interface StrategyOption extends Option {
  signal: string;
  params: (s: Style) => Params;
}

export const STRATEGIES: StrategyOption[] = [
  // trend following
  { id: 'tsmom', group: 'Trend following', name: 'Ride the trend (momentum)', plain: 'Buys when the price has gone up over the look-back period, sells short when it has gone down. The most studied edge in markets.', suits: ['swing', 'week', 'position', 'hold'], signal: 'tsmom', params: (s) => ({ lookback: s.L }) },
  { id: 'mac', group: 'Trend following', name: 'Moving-average crossover', plain: 'Buys when a fast average of price crosses above a slow one, sells when it crosses below. Classic and simple.', suits: ['swing', 'week', 'position', 'hold'], signal: 'mac', params: (s) => ({ fast: Math.max(12, s.L / 2), slow: Math.max(48, s.L * 3) }) },
  { id: 'tma', group: 'Trend following', name: 'Three averages lined up', plain: 'Trades only when a fast, a middle and a slow average are stacked in order — a confirmed trend, fewer false starts.', suits: ['intraday', 'swing', 'week'], signal: 'tma', params: (s) => ({ set: fast(s) ? 0 : slow(s) ? 2 : 1 }) },
  { id: 'maratio', group: 'Trend following', name: 'Price far from its average', plain: 'Buys when the price is clearly above its average (a strong trend), sells when clearly below.', suits: ['week', 'position', 'hold'], signal: 'maratio', params: (s) => ({ lookback: s.L * 2, band: 0.02 }) },
  { id: 'kalman', group: 'Trend following', name: 'Smart trend line (Kalman filter)', plain: 'A noise-filtering trend line that also says how sure it is; trades only when the trend is clear.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'kalman', params: (s) => ({ smooth: fast(s) ? 2 : slow(s) ? 0 : 1, k: 2 }) },
  { id: 'macd', group: 'Trend following', name: 'MACD trend', plain: 'The popular MACD indicator: long while it is above its signal line, short while below.', suits: ['intraday', 'swing', 'week'], signal: 'macd', params: (s) => ({ scale: fast(s) ? 1 : slow(s) ? 24 : 4 }) },
  { id: 'vsmom', group: 'Trend following', name: 'Momentum that adjusts for volatility', plain: 'Momentum, but a move only counts if it is big for how jumpy the coin is right now (GARCH volatility).', suits: ['intraday', 'swing', 'week'], signal: 'vsmom', params: (s) => ({ lookback: s.L, k: 1 }) },
  // breakouts
  { id: 'donchian', group: 'Breakouts', name: 'Break of the recent high or low', plain: 'Buys when price closes above its highest high of the period, sells below the lowest low. Catches new trends early.', suits: ['intraday', 'swing', 'week', 'position'], signal: 'donchian', params: (s) => ({ n: Math.max(20, s.L) }) },
  { id: 'bbreak', group: 'Breakouts', name: 'Bollinger band breakout', plain: 'Trades a close outside the Bollinger bands — a move bigger than normal for the coin.', suits: ['scalp', 'intraday', 'swing'], signal: 'bbreak', params: (s) => ({ lookback: Math.max(20, s.L), k: 2 }) },
  { id: 'pivot', group: 'Breakouts', name: 'Support and resistance (pivots)', plain: 'Buys a close above yesterday’s resistance, sells a close below support. A day trader’s classic.', suits: ['scalp', 'intraday'], signal: 'pivot', params: () => ({ level: 1 }) },
  { id: 'volbrk', group: 'Breakouts', name: 'Big move on heavy volume', plain: 'Follows a sharp move only when volume is unusually heavy — a sign big players are behind it.', suits: ['scalp', 'intraday'], signal: 'volbrk', params: (s) => ({ n: clamp(Math.round(s.L / 6), 1, 24), k: 2 }) },
  // mean reversion
  { id: 'zrev', group: 'Buy the dip / sell the rip', name: 'Stretched from the average (z-score)', plain: 'Buys when price has fallen unusually far below its average, sells when it has risen unusually far — betting it snaps back.', suits: ['scalp', 'intraday', 'swing'], signal: 'zrev', params: (s) => ({ lookback: Math.max(24, s.L), k: 2 }) },
  { id: 'rsi2', group: 'Buy the dip / sell the rip', name: 'RSI oversold / overbought', plain: 'Buys when the RSI says oversold, sells when overbought. Short, sharp bounces.', suits: ['scalp', 'intraday', 'swing'], signal: 'rsi2', params: (s) => (fast(s) ? { n: 2, band: 10 } : { n: 14, band: 30 }) },
  { id: 'ou', group: 'Buy the dip / sell the rip', name: 'Snap-back to fair value (Ornstein–Uhlenbeck)', plain: 'Fits a “rubber band” model to the price and trades when it is stretched far — only when it has been snapping back fast.', suits: ['intraday', 'swing'], signal: 'ou', params: (s) => ({ window: clamp(s.L * 2, 72, 336), k: 2 }) },
  { id: 'wrev', group: 'Buy the dip / sell the rip', name: 'Fade a big weekly move', plain: 'After a week with a very big rise or fall, bets on part of it coming back.', suits: ['swing', 'week'], signal: 'wrev', params: () => ({ band: 0.1 }) },
  // timing
  { id: 'itsm', group: 'Timing and seasons', name: 'End-of-day momentum', plain: 'Late in the US session, trades the direction the day has taken so far into the close.', suits: ['intraday'], signal: 'itsm', params: () => ({ hour: 21 }) },
  { id: 'dow', group: 'Timing and seasons', name: 'Monday effect', plain: 'Buys at the start of Monday and holds for the day (a documented weekday pattern in bitcoin).', suits: ['intraday'], signal: 'dow', params: () => ({ day: 1 }) },
  // carry
  { id: 'carry', group: 'Funding (carry)', name: 'Get paid funding', plain: 'Takes the side the crowd is paying for: short when longs pay heavy funding, long when shorts do.', suits: ['swing', 'week'], signal: 'carry', params: () => ({ lookback: 72, band: 0.25 }) },
  // machine learning
  { id: 'rf', group: 'AI (machine learning)', name: 'AI: random forest', plain: 'A machine-learning model (a forest of decision trees) learns from 30+ market readings which way price goes next; trades when it is confident.', suits: ['scalp', 'intraday', 'swing'], signal: 'rf', params: (s) => ({ horizon: fast(s) ? 4 : 24, edge: 0.05 }) },
  { id: 'ols', group: 'AI (machine learning)', name: 'AI: linear forecast', plain: 'A regression combines 30+ market readings into one forecast of the next move; trades the strong forecasts.', suits: ['scalp', 'intraday', 'swing'], signal: 'ols', params: (s) => ({ horizon: fast(s) ? 4 : 24, q: 1 }) },
  { id: 'candle', group: 'AI (machine learning)', name: 'AI: next-candle forecast', plain: 'Reads the shape of recent candles (bodies, wicks, patterns) and forecasts the next candle; trades the clear calls.', suits: ['scalp', 'intraday'], signal: 'candle', params: () => ({ edge: 0.05 }) },
];

// ---------- 2. the market model (a filter: when the strategy is allowed to trade) ----------

export interface ModelOption extends Option {
  filter?: RuleRef | ((s: Style) => RuleRef);
}

export const MODELS: ModelOption[] = [
  { id: 'none', group: 'No filter', name: 'Trade in any market', plain: 'No extra condition: the strategy trades whenever its own rules say so.' },
  { id: 'trend', group: 'Trend', name: 'Only with the big trend', plain: 'Longs only above the long-term average, shorts only below — trade with the tide, not against it.', suits: ['intraday', 'swing', 'week', 'position', 'hold'], filter: (s) => ({ id: 'trend', p: { lookback: Math.max(200, s.L * 8) } }) },
  { id: 'adx-trend', group: 'Trend', name: 'Only when the market is trending (ADX)', plain: 'The ADX indicator measures trend strength; trade only when it says the market is trending.', suits: ['intraday', 'swing', 'week'], filter: { id: 'adx', p: { mode: 0, level: 25 } } },
  { id: 'adx-range', group: 'Trend', name: 'Only when the market is ranging (ADX)', plain: 'Trade only when ADX says there is no strong trend — the place for buy-the-dip strategies.', suits: ['scalp', 'intraday'], filter: { id: 'adx', p: { mode: 1, level: 20 } } },
  { id: 'vr-trend', group: 'Statistical regime', name: 'Only when moves keep going (variance ratio)', plain: 'A statistical test (Lo & MacKinlay) of whether moves have been continuing; trade trend strategies only then.', suits: ['swing', 'week', 'position'], filter: { id: 'vratio', p: { mode: 0, window: 720 } } },
  { id: 'vr-revert', group: 'Statistical regime', name: 'Only when moves snap back (variance ratio)', plain: 'The same test, the other way: moves have been reversing — the place for dip-buying.', suits: ['scalp', 'intraday', 'swing'], filter: { id: 'vratio', p: { mode: 1, window: 720 } } },
  { id: 'hmm-calm', group: 'Statistical regime', name: 'Only in calm markets (hidden-Markov)', plain: 'A model that reads whether the market is in its calm or its stormy state; trade only when calm.', filter: { id: 'hmm', p: { mode: 0 } } },
  { id: 'hmm-storm', group: 'Statistical regime', name: 'Only in stormy markets (hidden-Markov)', plain: 'The same model; trade only in the stormy state (breakouts often need it).', filter: { id: 'hmm', p: { mode: 1 } } },
  { id: 'garch-calm', group: 'Volatility', name: 'Only when volatility is below normal (GARCH)', plain: 'GARCH forecasts how jumpy the coin will be; trade only when it expects less than its normal.', filter: { id: 'garch', p: { mode: 0, ratio: 1 } } },
  { id: 'garch-storm', group: 'Volatility', name: 'Only when volatility is above normal (GARCH)', plain: 'Trade only when GARCH expects more movement than normal — when breakouts have fuel.', filter: { id: 'garch', p: { mode: 1, ratio: 1 } } },
  { id: 'vol-calm', group: 'Volatility', name: 'Only on quieter days', plain: 'Skips the busiest days of the month (measured by realised volatility).', filter: { id: 'volreg', p: { mode: 0, pct: 0.8 } } },
  { id: 'volume', group: 'Activity', name: 'Only on above-normal volume', plain: 'Trades only when volume is above its usual level — more participants, more follow-through.', suits: ['scalp', 'intraday'], filter: { id: 'volume', p: { k: 0.5 } } },
  { id: 'us', group: 'Activity', name: 'Only in US trading hours', plain: 'Trades only from 13:00 to 21:00 UTC, when the most money is moving.', suits: ['scalp', 'intraday'], filter: { id: 'session', p: { s: 0 } } },
  { id: 'eu', group: 'Activity', name: 'Only in European trading hours', plain: 'Trades only from 07:00 to 16:00 UTC.', suits: ['scalp', 'intraday'], filter: { id: 'session', p: { s: 1 } } },
  { id: 'crowd', group: 'Funding', name: 'Avoid crowded trades (funding)', plain: 'No longs when longs are paying heavy funding, no shorts when shorts are — do not join an overcrowded side.', filter: { id: 'crowd', p: { band: 0.2 } } },
];

// ---------- 3. the forecast (a second opinion, or the AI trade filter) ----------

export interface ForecastOption extends Option {
  filter?: RuleRef;
  autoMeta?: boolean;
}

export const FORECASTS: ForecastOption[] = [
  { id: 'none', group: 'No forecast', name: 'No forecast', plain: 'The strategy’s own signal is enough.' },
  { id: 'meta', group: 'AI', name: 'AI trade filter (learns which signals fail)', plain: 'A random forest studies the strategy’s past trades and learns which of its signals tend to lose; it skips those. Kept only if it improves results on data it never saw.', autoMeta: true },
  { id: 'kalman', group: 'Second opinion', name: 'The Kalman trend must agree', plain: 'Trade only in the direction the smart trend line is pointing.', filter: { id: 'agree', p: { model: 3 } } },
  { id: 'candle', group: 'Second opinion', name: 'The AI next-candle forecast must agree', plain: 'Trade only when the candle-shape forecast expects the next candle to go the same way.', suits: ['scalp', 'intraday'], filter: { id: 'agree', p: { model: 0 } } },
  { id: 'ridge', group: 'Second opinion', name: 'The AI linear forecast must agree', plain: 'Trade only when the regression forecast of the next day points the same way.', filter: { id: 'agree', p: { model: 1 } } },
  { id: 'forest', group: 'Second opinion', name: 'The AI random forest must agree', plain: 'Trade only when the forest’s forecast of the next day points the same way.', filter: { id: 'agree', p: { model: 2 } } },
];

// ---------- 4. risk management ----------

export interface RiskOption extends Option {
  sizing?: (s: Style) => Sizing;
  garchStop?: boolean;
  hedge?: boolean;
}

export const RISKS: RiskOption[] = [
  { id: 'fixed', group: 'Position size', name: 'Fixed size, ATR stop', plain: 'The same position every trade; the stop sits a set number of ATRs (average daily range) away.' },
  { id: 'voltarget', group: 'Position size', name: 'Steady risk (volatility targeting)', plain: 'Smaller positions when the market is wild, bigger when calm, so the bot’s ups and downs stay steady. Usually lifts results.', sizing: (s) => ({ mode: 'vol', target: s.L <= 24 ? 1 : s.L >= 720 ? 0.4 : 0.6 }) },
  { id: 'var', group: 'Position size', name: 'Cap the daily loss (value at risk)', plain: 'Sizes each position so a bad day (the worst 1 in 100) costs about 5 % of the account at most.', sizing: () => ({ mode: 'var', target: 0.05 }) },
  { id: 'garchstop', group: 'Stops', name: 'Stops that widen before storms (GARCH)', plain: 'The stop distance follows GARCH’s forecast of volatility, so it gives the trade more room before a storm, not after.', garchStop: true },
  { id: 'steady-garch', group: 'Stops', name: 'Steady risk + GARCH stops', plain: 'Both together: steady position size and storm-aware stops.', sizing: (s) => ({ mode: 'vol', target: s.L <= 24 ? 1 : s.L >= 720 ? 0.4 : 0.6 }), garchStop: true },
  { id: 'hedged', group: 'Hedging', name: 'Market-neutral (hedge with bitcoin)', plain: 'Shorts the right amount of bitcoin against each trade, so you keep the coin’s own move and not the whole market’s. Needs BTC among the coins.', hedge: true },
];

export const STOP_WIDTHS = [
  { id: 'tight', name: 'Tight stop', plain: 'Cuts losers fast; more small losses.', k: 0.7 },
  { id: 'normal', name: 'Normal stop', plain: 'The usual room for this style.', k: 1 },
  { id: 'wide', name: 'Wide stop', plain: 'Gives trades room to breathe; fewer, bigger losses.', k: 1.5 },
];

// ---------- 5. the rules of engagement ----------

export const SIDES = [
  { id: 'both', name: 'Long and short', plain: 'Profit from rises and falls.' },
  { id: 'long', name: 'Long only', plain: 'Only buys; never bets on falls.' },
  { id: 'short', name: 'Short only', plain: 'Only bets on falls.' },
] as const;

export const TAKE_PROFIT = [
  { id: 'trail', name: 'Let winners run (trailing stop)', plain: 'Once a trade is 1R up, the stop follows the price, locking in gains.', targetR: 0, trail: true },
  { id: 'r15', name: 'Take profit at 1.5× the risk', plain: 'Closes when the gain is 1.5 times what was risked.', targetR: 1.5, trail: false },
  { id: 'r2', name: 'Take profit at 2× the risk', plain: 'Closes at twice the risk.', targetR: 2, trail: false },
  { id: 'r3', name: 'Take profit at 3× the risk', plain: 'Closes at three times the risk; wins less often, bigger when it does.', targetR: 3, trail: false },
  { id: 'none', name: 'No profit target', plain: 'Exits only on the stop, the time limit or an opposite signal.', targetR: 0, trail: false },
];

export const HOLDS = [
  { id: 'half', name: 'Shorter hold', plain: 'Half the style’s usual holding time.', k: 0.5 },
  { id: 'normal', name: 'Usual hold', plain: 'The style’s usual holding time.', k: 1 },
  { id: 'long', name: 'Longer hold', plain: 'Twice the style’s usual holding time.', k: 2 },
];

// ---------- the chain ----------

export interface Flow {
  style: StyleId;
  strategy: string;
  model: string;
  model2: string;
  forecast: string;
  risk: string;
  stopWidth: string;
  sides: 'both' | 'long' | 'short';
  takeProfit: string;
  hold: string;
  flip: boolean;
  coins: string;
}

export const FLOW_DEFAULT: Flow = { style: 'swing', strategy: 'tsmom', model: 'trend', model2: 'none', forecast: 'none', risk: 'voltarget', stopWidth: 'normal', sides: 'both', takeProfit: 'trail', hold: 'normal', flip: true, coins: 'BTC ETH SOL' };

const find = <T extends { id: string }>(xs: readonly T[], id: string) => xs.find((x) => x.id === id) ?? xs[0];

const holdText = (h: number) => (h >= 48 ? `${Math.round(h / 24)} days` : `${Math.round(h)} hours`);

/** the chain as the Strategy Lab's strategy, its timeframe and history to test on */
export function buildSpec(f: Flow): { spec: StrategySpec; style: Style; timeframe: Style['timeframe']; years: number; coins: string[]; summary: string[] } {
  const style = STYLE_MAP[f.style] ?? STYLES[2];
  const strat = find(STRATEGIES, f.strategy);
  const filters: RuleRef[] = [];
  for (const id of [f.model, f.model2]) {
    const m = find(MODELS, id);
    if (m.filter) {
      const r = typeof m.filter === 'function' ? m.filter(style) : m.filter;
      if (!filters.some((x) => x.id === r.id)) filters.push(r);
    }
  }
  const fc = find(FORECASTS, f.forecast);
  if (fc.filter && !filters.some((x) => x.id === fc.filter!.id)) filters.push(fc.filter);
  const risk = find(RISKS, f.risk);
  const width = find(STOP_WIDTHS, f.stopWidth);
  const tp = find(TAKE_PROFIT, f.takeProfit);
  const hold = find(HOLDS, f.hold);
  const stop = Math.round(style.stop * width.k * 10) / 10;
  const maxBars = Math.max(1, Math.round((style.holdH * hold.k) / style.tfH));
  const spec: StrategySpec = {
    name: '',
    signal: { id: strat.signal, p: strat.params(style) },
    filters,
    exit: { ...EXIT_DEFAULT, stopAtr: stop, targetR: tp.targetR, trailAtr: tp.trail ? Math.max(1.5, stop) : 0, maxBars, onFlip: f.flip, stopVol: risk.garchStop ? Math.max(2, Math.round(stop * 1.3)) : 0 },
    sides: f.sides,
    ...(risk.sizing ? { sizing: risk.sizing(style) } : {}),
    ...(risk.hedge ? { hedge: 'btc' as const } : {}),
    ...(fc.autoMeta ? { autoMeta: true } : {}),
  };
  spec.name = [strat.name, ...filters.map((x) => FILTER_MAP[x.id]?.name).filter(Boolean), style.name.split(' — ')[0]].join(' · ');
  let coins = f.coins.toUpperCase().split(/[\s,]+/).filter(Boolean).slice(0, 8);
  if (risk.hedge && !coins.includes('BTC')) coins = ['BTC', ...coins];
  const summary = [
    `${style.name}: ${style.timeframe} candles, up to ${holdText(style.holdH * hold.k)} a trade`,
    `Enters: ${SIGNAL_MAP[strat.signal].describe(spec.signal.p)}`,
    ...filters.map((x) => `Only: ${FILTER_MAP[x.id].describe(x.p)}`),
    ...(fc.autoMeta ? ['An AI trade filter learns which signals to skip (kept only if it helps on unseen data)'] : []),
    `Risk: ${risk.name.toLowerCase()} — stop ${risk.garchStop ? `${spec.exit.stopVol} GARCH σ` : `${stop} ATR`}`,
    `Exits: ${tp.name.toLowerCase()}${f.flip ? ', or on an opposite signal' : ''}, at most ${holdText(style.holdH * hold.k)}`,
    `${f.sides === 'both' ? 'Long and short' : f.sides === 'long' ? 'Long only' : 'Short only'} on ${coins.join(', ')}`,
  ];
  return { spec, style, timeframe: style.timeframe, years: style.years, coins, summary };
}

/** options sorted with the ones that suit the style first */
export function forStyle<T extends Option>(xs: T[], style: StyleId): (T & { fits: boolean })[] {
  return xs.map((x) => ({ ...x, fits: !x.suits || x.suits.includes(style) })).sort((a, b) => Number(b.fits) - Number(a.fits));
}

/** a verdict in words for a tested bot */
export function verdictWords(oosSharpe: number, t: number, trades: number): { tone: 'good' | 'ok' | 'bad'; text: string } {
  if (trades < 10) return { tone: 'bad', text: 'Too few trades to judge — try another style, more coins or a looser filter.' };
  if (oosSharpe > 1 && t > 2) return { tone: 'good', text: 'Strong on data it never saw: good return for the risk, and unlikely to be luck.' };
  if (oosSharpe > 0.5 && t > 1.5) return { tone: 'ok', text: 'Promising on unseen data, but not yet proven — it could still be luck.' };
  if (oosSharpe > 0) return { tone: 'ok', text: 'Made a little on unseen data, but not enough for its risk to be convincing.' };
  return { tone: 'bad', text: 'Lost money on data it never saw. Do not deploy it as it is.' };
}
