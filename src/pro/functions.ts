// The professional terminal's functions: short codes typed on the command
// line (or clicked on the function keys) that open a screen in a workspace.
// A coin before the code makes it the market first: "ETH GP", "SOL BOOK".

export type Workspace = 'markets' | 'lab' | 'quant';
/** where a function lives: a terminal workspace, or the crypto swarm's own view */
export type FnHome = Workspace | 'swarm';

export interface Fn {
  code: string;
  name: string;
  /** the panel it opens */
  panel: string;
  ws: FnHome;
  desc: string;
}

export const WORKSPACES: { id: Workspace; name: string; key: string; desc: string }[] = [
  { id: 'markets', name: 'MARKETS', key: 'F1', desc: 'Quotes, charts, order book, flow, derivatives, news' },
  { id: 'lab', name: 'STRATEGY LAB', key: 'F2', desc: 'Research published strategies, test, rank and deploy them' },
  { id: 'quant', name: 'QUANT DESK', key: 'F3', desc: 'Value at risk, delta hedging, volatility targeting, momentum, regimes, GARCH' },
];

export const FUNCTIONS: Fn[] = [
  // markets
  { code: 'MON', name: 'Monitor', panel: 'monitor', ws: 'markets', desc: 'Quote board: last, change, range, volume, funding, open interest' },
  { code: 'HMAP', name: 'Heat map', panel: 'heatgrid', ws: 'markets', desc: 'The market as tiles: size by volume, colour by change' },
  { code: 'GP', name: 'Graph price', panel: 'historical', ws: 'markets', desc: 'Candles or market profile, VWAP, averages' },
  { code: 'GIP', name: 'Footprint', panel: 'footprint', ws: 'markets', desc: 'Intraday footprint: bid × ask, delta, imbalances' },
  { code: 'LHM', name: 'Liquidity heat map', panel: 'heatmap', ws: 'markets', desc: 'Resting liquidity over time with trades' },
  { code: 'CORR', name: 'Correlation', panel: 'correl', ws: 'markets', desc: 'Correlation matrix, beta to bitcoin, volatility' },
  { code: 'HVOL', name: 'Volatility', panel: 'volmon', ws: 'markets', desc: 'Realised volatility: day, week, month, term, rank' },
  { code: 'GV', name: 'GARCH volatility', panel: 'garch', ws: 'markets', desc: 'GARCH forecast volatility: heat calendar, long run, VaR' },
  { code: 'FCST', name: 'Candle forecast', panel: 'fcst', ws: 'markets', desc: 'Next candle: expected range, P(up), out-of-sample record' },
  { code: 'DES', name: 'Description', panel: 'summary', ws: 'markets', desc: 'Price, 24h stats, funding, OI, long/short, basis' },
  { code: 'BOOK', name: 'Order book', panel: 'orderbook', ws: 'markets', desc: 'Composite order book across venues' },
  { code: 'DOM', name: 'Depth ladder', panel: 'dom', ws: 'markets', desc: 'Price ladder with traded volume and delta' },
  { code: 'DPTH', name: 'Depth chart', panel: 'depth', ws: 'markets', desc: 'Cumulative bid and ask depth' },
  { code: 'TAS', name: 'Time & sales', panel: 'tape', ws: 'markets', desc: 'Every trade across venues, sized' },
  { code: 'CVD', name: 'Cumulative delta', panel: 'cvd', ws: 'markets', desc: 'Buy minus sell volume, per venue' },
  { code: 'FLOW', name: 'Flow pulse', panel: 'flowpulse', ws: 'markets', desc: 'Buy vs sell notional, 30 s to 15 min' },
  { code: 'BLCK', name: 'Block trades', panel: 'whales', ws: 'markets', desc: 'Large prints and net whale flow' },
  { code: 'LIQ', name: 'Liquidations', panel: 'liquidations', ws: 'markets', desc: 'Forced orders, long vs short' },
  { code: 'OI', name: 'Open interest', panel: 'oi', ws: 'markets', desc: 'Open interest per venue' },
  { code: 'FUND', name: 'Funding', panel: 'funding', ws: 'markets', desc: 'Funding rates, APR and basis' },
  { code: 'OMON', name: 'Options', panel: 'options', ws: 'markets', desc: 'Deribit option prints, IV, put/call' },
  { code: 'SPRD', name: 'Venue spread', panel: 'spread', ws: 'markets', desc: 'Each venue against the primary' },
  { code: 'VP', name: 'Volume profile', panel: 'vprofile', ws: 'markets', desc: 'Volume at price, value area' },
  { code: 'SCRN', name: 'Screener', panel: 'screener', ws: 'markets', desc: 'Every perpetual on a venue' },
  { code: 'WL', name: 'Watchlist', panel: 'watchlist', ws: 'markets', desc: 'Your symbols on any venue' },
  { code: 'TOP', name: 'Top news', panel: 'news', ws: 'markets', desc: 'Real-time headlines by coin' },
  { code: 'WEI', name: 'World markets', panel: 'yahoo', ws: 'markets', desc: 'Stocks, indices, FX, futures (Yahoo Finance)' },
  // strategy lab
  { code: 'FARM', name: 'Edge finder', panel: 'labfarm', ws: 'lab', desc: 'The strategy farm: breeds, tests and forward-tests bots by itself; the top five to deploy' },
  { code: 'BOT', name: 'Bot builder', panel: 'labflow', ws: 'lab', desc: 'Build a bot block by block in plain English, backtest it, deploy it' },
  { code: 'LIB', name: 'Strategy library', panel: 'lablib', ws: 'lab', desc: 'Every rule, its papers and rationale' },
  { code: 'RSCH', name: 'Research', panel: 'labresearch', ws: 'lab', desc: 'Search, test and rank strategies; deploy the best' },
  { code: 'BT', name: 'Backtest builder', panel: 'labbuilder', ws: 'lab', desc: 'Build a strategy by hand and test it' },
  { code: 'DEPL', name: 'Deployed', panel: 'labdeployed', ws: 'lab', desc: 'Strategies trading in the swarms' },
  // crypto swarm
  { code: 'SWRM', name: 'Crypto swarm', panel: 'command', ws: 'swarm', desc: 'Switch to the crypto swarm view: the core, gauges, deploy gate, tape' },
  { code: 'SWCF', name: 'Swarm rules', panel: 'cswarm', ws: 'swarm', desc: 'Agents, council, trades, rules, paper or live account' },
  { code: 'AMT', name: 'AMT bots', panel: 'amt', ws: 'swarm', desc: 'Auction-market-theory bots' },
  { code: 'TKT', name: 'Order ticket', panel: 'ticket', ws: 'swarm', desc: 'Place orders on any exchange' },
  { code: 'PORT', name: 'Portfolio', panel: 'accounts', ws: 'swarm', desc: 'Balances, positions, orders, fills' },
  { code: 'ALRT', name: 'Alerts', panel: 'alerts', ws: 'swarm', desc: 'Price and flow alerts' },
  // quant desk
  { code: 'VAR', name: 'Value at risk', panel: 'qvar', ws: 'quant', desc: 'VaR and expected shortfall: five methods, any horizon, backtested' },
  { code: 'DHG', name: 'Delta hedging', panel: 'qdelta', ws: 'quant', desc: 'Option greeks, the hedge to hold, hedging backtest' },
  { code: 'VTGT', name: 'Volatility targeting', panel: 'qvtgt', ws: 'quant', desc: 'Volatility estimators, position sizing, Kelly' },
  { code: 'MOM', name: 'Momentum', panel: 'qmom', ws: 'quant', desc: 'Time-series momentum, trend t, Kalman slope, rank' },
  { code: 'REGM', name: 'Regimes', panel: 'qregm', ws: 'quant', desc: 'Hurst, variance ratio, OU half-life, hidden Markov' },
  { code: 'CAPM', name: 'CAPM', panel: 'qcapm', ws: 'quant', desc: 'Beta, alpha, R², security market line' },
  { code: 'EF', name: 'Efficient frontier', panel: 'qef', ws: 'quant', desc: 'Markowitz frontier, max Sharpe, min variance, Kelly portfolio' },
  { code: 'KELLY', name: 'Kelly criterion', panel: 'qkelly', ws: 'quant', desc: 'Growth-optimal leverage, growth curve, a strategy’s Kelly bet' },
  { code: 'NNET', name: 'Neural network', panel: 'qnn', ws: 'quant', desc: 'Train a neural network on a coin, judged on unseen data against a forest' },
  { code: 'PAIR', name: 'Pairs & cointegration', panel: 'qpair', ws: 'quant', desc: 'Which coins are tied to bitcoin, the gap now, who leads' },
  { code: 'SEAS', name: 'Seasonality', panel: 'qseas', ws: 'quant', desc: 'Returns by hour of the day and weekday, with t-statistics' },
  { code: 'MC', name: 'Monte Carlo', panel: 'qmc', ws: 'quant', desc: 'A strategy’s trades as 2,000 futures: growth, drawdown, ruin by risk' },
  // accounts and messages
  { code: 'WALL', name: 'Wallet', panel: 'wallet', ws: 'swarm', desc: 'Phantom balances (and the retired meme swarm wallet)' },
  { code: 'TG', name: 'Telegram', panel: 'telegram', ws: 'swarm', desc: 'Your Telegram bot' },
  { code: 'LUNO', name: 'Luno lane', panel: 'luno', ws: 'swarm', desc: 'Crypto against rands on Luno: daily trend bots' },
  // tools
  { code: 'CALC', name: 'Calculator', panel: 'calculator', ws: 'swarm', desc: 'Size, risk/reward, liquidation' },
  { code: 'NOTE', name: 'Journal', panel: 'journal', ws: 'swarm', desc: 'Timestamped notes' },
  { code: 'DB', name: 'Database', panel: 'database', ws: 'swarm', desc: 'Recorded trades, retention, export' },
];

export const FN_MAP = Object.fromEntries(FUNCTIONS.map((f) => [f.code, f]));

/** the function keys shown for each workspace */
export const KEYS: Record<Workspace, string[]> = {
  markets: ['MON', 'GP', 'GIP', 'BOOK', 'TAS', 'HMAP', 'CORR', 'HVOL', 'GV', 'FCST', 'FUND', 'OI', 'LIQ', 'TOP'],
  lab: ['FARM', 'BOT', 'LIB', 'RSCH', 'BT', 'DEPL', 'VAR', 'VTGT', 'REGM', 'GV', 'FCST'],
  quant: ['FARM', 'VAR', 'CAPM', 'EF', 'KELLY', 'NNET', 'PAIR', 'SEAS', 'MC', 'DHG', 'VTGT', 'MOM', 'REGM', 'GV'],
};

export interface Parsed {
  coin: string | null;
  fn: Fn | null;
  workspace: Workspace | null;
  unknown: string[];
}

/** "eth gp <go>" → the coin ETH and the GP function */
export function parseCommand(text: string): Parsed {
  const words = text
    .toUpperCase()
    .replace(/<GO>|<EQUITY>|<CRYPTO>|<CURNCY>/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean);
  let coin: string | null = null;
  let fn: Fn | null = null;
  let workspace: Workspace | null = null;
  const unknown: string[] = [];
  for (const w of words) {
    const ws = WORKSPACES.find((x) => x.name.replace(' ', '') === w || x.id.toUpperCase() === w || x.key === w);
    if (FN_MAP[w]) fn = FN_MAP[w];
    else if (ws) workspace = ws.id;
    else if (w === 'LAB') workspace = 'lab';
    else if (/^[A-Z0-9]{2,10}$/.test(w) && !coin) coin = w;
    else unknown.push(w);
  }
  return { coin, fn, workspace: workspace ?? (fn && fn.ws !== 'swarm' ? fn.ws : null), unknown };
}

/** suggestions for what is being typed: codes and names that match */
export function suggest(text: string, limit = 8): Fn[] {
  const last = text.toUpperCase().split(/\s+/).filter(Boolean).pop() ?? '';
  if (!last) return [];
  const starts = FUNCTIONS.filter((f) => f.code.startsWith(last));
  const names = FUNCTIONS.filter((f) => !starts.includes(f) && (f.name.toUpperCase().includes(last) || f.desc.toUpperCase().includes(last)));
  return [...starts, ...names].slice(0, limit);
}
