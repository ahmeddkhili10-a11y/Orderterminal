// What each Quant desk function can become in a bot (the options behind its
// "Use in a bot" button): the pick it maps to in the bot builder, and the
// settings on screen that travel with it.
import { styleFor } from '../lab/bridge';
import type { UseOption } from './UseInBot';

const hoursWords = (h: number) => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${h} hours`);

export const USES = {
  /** NNET: the network as trained on the panel — its size, its horizon, its candles, its coin */
  nnet: (o: { coin: string; tfH: number; ahead: number; hidden: [number, number] }): UseOption[] => {
    const horizon = o.ahead * o.tfH;
    const net = { h1: o.hidden[0], h2: o.hidden[1] };
    const what = `${o.hidden[0]} → ${o.hidden[1]} units, looking ${hoursWords(horizon)} ahead`;
    return [
      { label: 'As the bot’s strategy', plain: `The bot trades this network’s calls (${what}) on ${o.coin}. It replaces the strategies picked so far and sets the bot to this panel’s candles.`, send: { block: 'strategy', id: 'nn', tune: { ...net, horizon, edge: 0.05 }, coins: [o.coin], style: styleFor(o.tfH, horizon), solo: true } },
      { label: 'Join the bot’s strategies', plain: `Added beside the strategies already picked (${what}); you choose how they are joined — all must agree, a majority, or any one.`, send: { block: 'strategy', id: 'nn', tune: { ...net, horizon, edge: 0.05 }, coins: [o.coin] } },
      { label: 'As a second opinion', plain: `The bot keeps its own strategy and only trades when this network (${what}) points the same way.`, send: { block: 'forecast', id: 'nn', tune: { ...net, horizon } } },
      { label: 'As the decision maker', plain: `A network of this size (${o.hidden[0]} → ${o.hidden[1]}) studies the bot’s own past trades and learns which signals to skip.`, send: { block: 'decider', id: 'nn', tune: net } },
      { label: 'As the decision maker, paired with the forest', plain: 'The same, with a decision forest beside it: their odds are averaged.', send: { block: 'decider', id: 'both', tune: net } },
    ];
  },
  var: (): UseOption[] => [{ label: 'Size trades by value at risk', plain: 'Each position is sized so the worst day in a hundred (GARCH value at risk) costs about 5 % of the account at most.', send: { block: 'risk', id: 'var' } }],
  garch: (): UseOption[] => [
    { label: 'Trade only when volatility is below normal', plain: 'A market filter: the bot trades only while GARCH expects less movement than the coin’s long-run level.', send: { block: 'model', id: 'garch-calm' } },
    { label: 'Trade only when volatility is above normal', plain: 'The opposite filter — for breakout strategies that need movement.', send: { block: 'model', id: 'garch-storm' } },
    { label: 'Stops that follow the GARCH forecast', plain: 'The stop distance widens before a storm and tightens in calm.', send: { block: 'risk', id: 'garchstop' } },
    { label: 'Momentum scaled by GARCH volatility (a strategy)', plain: 'A move only counts when it is large against the volatility GARCH expected for it.', send: { block: 'strategy', id: 'vsmom' } },
  ],
  voltarget: (o: { target: number }): UseOption[] => [
    { label: `Volatility targeting at ${Math.round(o.target)} % a year`, plain: 'Positions shrink when the market is wild and grow when calm, so the bot runs at the volatility set on this panel.', send: { block: 'risk', id: 'voltarget', tune: { target: Math.max(0.05, Math.min(2, o.target / 100)) } } },
    { label: 'Kelly sizing (half Kelly)', plain: 'The risk per trade is worked out from the bot’s own tested win rate and payoff, then halved.', send: { block: 'risk', id: 'kelly' } },
  ],
  delta: (): UseOption[] => [{ label: 'Hedge the bot with bitcoin (delta hedge)', plain: 'Each trade is hedged with β × its size in bitcoin, so the bot keeps the coin’s own move and not the market’s.', send: { block: 'risk', id: 'hedged' } }],
  momentum: (): UseOption[] => [
    { label: 'Time-series momentum (a strategy)', plain: 'Long when the coin has risen over the look-back, short when it has fallen.', send: { block: 'strategy', id: 'tsmom' } },
    { label: 'Kalman-filter trend (a strategy)', plain: 'Trades only when the filtered trend slope is clearly away from zero.', send: { block: 'strategy', id: 'kalman' } },
    { label: 'Momentum weighted by volume (a strategy)', plain: 'Moves made on heavy volume decide the direction.', send: { block: 'strategy', id: 'vwmom' } },
    { label: 'The Kalman trend as a second opinion', plain: 'The bot keeps its strategy and trades only in the direction the Kalman trend points.', send: { block: 'forecast', id: 'kalman' } },
  ],
  regimes: (): UseOption[] => [
    { label: 'Trade only when prices have memory (Hurst above 0.55)', plain: 'A filter for trend strategies.', send: { block: 'model', id: 'hurst-trend' } },
    { label: 'Trade only when prices reverse (Hurst below 0.45)', plain: 'A filter for dip-buying strategies.', send: { block: 'model', id: 'hurst-revert' } },
    { label: 'Trade only when moves keep going (variance ratio)', plain: 'Lo and MacKinlay’s test says moves have been persisting.', send: { block: 'model', id: 'vr-trend' } },
    { label: 'Trade only when moves snap back (variance ratio)', plain: 'The same test, the other way.', send: { block: 'model', id: 'vr-revert' } },
    { label: 'Trade only in the calm regime (hidden Markov)', plain: 'The two-state model’s odds of turbulence are under 50 %.', send: { block: 'model', id: 'hmm-calm' } },
    { label: 'Trade only in the turbulent regime (hidden Markov)', plain: 'For strategies that need movement.', send: { block: 'model', id: 'hmm-storm' } },
    { label: 'Ornstein–Uhlenbeck reversion (a strategy)', plain: 'Trades the pull back when price sits far from its equilibrium and has been reverting fast.', send: { block: 'strategy', id: 'ou' } },
  ],
  capm: (): UseOption[] => [
    { label: 'Hedge the market out (beta hedge with bitcoin)', plain: 'The bot shorts β × each position in bitcoin — the CAPM beta on this panel, re-estimated as it goes — and keeps the coin’s alpha.', send: { block: 'risk', id: 'hedged' } },
    { label: 'Trade only with bitcoin’s trend', plain: 'Most of a coin’s move is the market’s: longs only while bitcoin is above its long average.', send: { block: 'model', id: 'btc-trend' } },
  ],
  frontier: (): UseOption[] => [
    { label: 'Split the bot’s money by the efficient frontier', plain: 'The best return for the risk across the bot’s coins, fitted on the training years.', send: { block: 'portfolio', id: 'tangency' } },
    { label: 'Split it for the smoothest ride (minimum variance)', plain: 'The split that made the bot’s combined result swing the least.', send: { block: 'portfolio', id: 'minvar' } },
    { label: 'Split it by calm (inverse volatility)', plain: 'More money on the calmer coins, so each contributes the same risk.', send: { block: 'portfolio', id: 'invvol' } },
  ],
  kelly: (): UseOption[] => [{ label: 'Size the bot’s trades by Kelly (half Kelly)', plain: 'The Lab measures the bot’s own win rate and payoff on the training years and risks half the Kelly fraction a trade.', send: { block: 'risk', id: 'kelly' } }],
  candle: (): UseOption[] => [
    { label: 'The next-candle forecast as the bot’s strategy', plain: 'Trades the forest’s clear calls on the next candle.', send: { block: 'strategy', id: 'candle' } },
    { label: 'As a second opinion', plain: 'The bot trades only when the candle forecast expects the same direction.', send: { block: 'forecast', id: 'candle' } },
  ],
  /** PAIR: the pair on screen — its window and entry threshold */
  pair: (o: { coin: string; windowH: number; k: number; tfH: number }): UseOption[] => [
    { label: `Pairs trade ${o.coin} against bitcoin, hedged`, plain: `Buys ${o.coin} when it is ${o.k} standard deviations cheap against bitcoin and sells when as rich (${hoursWords(o.windowH)} window), short bitcoin against it — the true pairs trade.`, send: { block: 'strategy', id: 'pairs', tune: { window: o.windowH, k: o.k }, coins: ['BTC', o.coin], style: styleFor(o.tfH, o.windowH / 4), solo: true } },
    { label: 'Add the bitcoin hedge', plain: 'Makes the bot market-neutral: each trade carries a bitcoin position against it.', send: { block: 'risk', id: 'hedged' } },
    { label: 'Bitcoin leads, the coin catches up (a strategy)', plain: `Trades ${o.coin} in bitcoin’s direction when it has not yet followed a bitcoin move.`, send: { block: 'strategy', id: 'btclead', coins: ['BTC', o.coin] } },
  ],
  /** SEAS: the hour picked on the map, and the calendar filters */
  seasons: (o: { coin: string; hour: number | null }): UseOption[] => [
    ...(o.hour !== null ? [{ label: `Buy at ${o.hour}:00 UTC for two hours (a strategy)`, plain: `The late-evening rule, moved to the hour picked on the map — tested on ${o.coin} like any other strategy.`, send: { block: 'strategy' as const, id: 'night', tune: { hour: o.hour }, coins: [o.coin], style: 'intraday' as const } }] : []),
    { label: 'The late-evening hours, 21:00–23:00 UTC (a strategy)', plain: 'The published bitcoin pattern: buy at 21:00, sell at 23:00.', send: { block: 'strategy', id: 'night', coins: [o.coin], style: 'intraday' } },
    { label: 'End-of-day momentum (a strategy)', plain: 'Late in the US session, trade the direction the day has taken.', send: { block: 'strategy', id: 'itsm', coins: [o.coin], style: 'intraday' } },
    { label: 'Trade only on weekdays', plain: 'A filter: Monday to Friday, when volume is full.', send: { block: 'model', id: 'weekdays' } },
    { label: 'Trade only at weekends', plain: 'A filter: the thin, quiet weekend market.', send: { block: 'model', id: 'weekends' } },
    { label: 'Trade only in US hours', plain: 'A filter: 13:00 to 21:00 UTC.', send: { block: 'model', id: 'us' } },
  ],
};
