import type { ReactElement } from 'react';
import type { PanelProps } from '../ui/controls';
import { AccountsPanel, ACCOUNTS_DEFAULTS } from './AccountsPanel';
import { AlertsPanel, ALERTS_DEFAULTS } from './AlertsPanel';
import { AmtScalper, AMT_DEFAULTS } from './AmtScalper';
import { CryptoSwarm, CRYPTO_SWARM_DEFAULTS } from './CryptoSwarm';
import { DatabasePanel, DATABASE_DEFAULTS } from './DatabasePanel';
import { OrderTicket, TICKET_DEFAULTS } from './OrderTicket';
import { WalletPanel, WALLET_DEFAULTS } from './WalletPanel';
import { YahooPanel, YAHOO_DEFAULTS } from './YahooPanel';
import { TelegramPanel, TELEGRAM_DEFAULTS } from './TelegramPanel';
import { Calculator, CALC_DEFAULTS } from './Calculator';
import { CvdChart, CVD_DEFAULTS } from './CvdChart';
import { DepthChart, DEPTH_DEFAULTS } from './DepthChart';
import { DomLadder, DOM_DEFAULTS } from './DomLadder';
import { FlowPulse, FLOW_DEFAULTS } from './FlowPulse';
import { FootprintChart, FOOTPRINT_DEFAULTS } from './FootprintChart';
import { FundingMonitor, FUNDING_DEFAULTS } from './FundingMonitor';
import { HistoricalChart, HISTORICAL_DEFAULTS } from './HistoricalChart';
import { Journal, JOURNAL_DEFAULTS } from './Journal';
import { LiquidityHeatmap, HEATMAP_DEFAULTS } from './LiquidityHeatmap';
import { Liquidations, LIQ_DEFAULTS } from './Liquidations';
import { NewsFeed, NEWS_DEFAULTS } from './NewsFeed';
import { OpenInterest, OI_DEFAULTS } from './OpenInterest';
import { OptionsFlow, OPTIONS_DEFAULTS } from './OptionsFlow';
import { Orderbook, ORDERBOOK_DEFAULTS } from './Orderbook';
import { OrderbookStats, OBSTATS_DEFAULTS } from './OrderbookStats';
import { Screener, SCREENER_DEFAULTS } from './Screener';
import { SpreadChart, SPREAD_DEFAULTS } from './SpreadChart';
import { SymbolSummary, SUMMARY_DEFAULTS } from './SymbolSummary';
import { TradesTape, TAPE_DEFAULTS } from './TradesTape';
import { VolumeProfilePanel, VPROFILE_DEFAULTS } from './VolumeProfilePanel';
import { Watchlist, WATCHLIST_DEFAULTS } from './Watchlist';
import { WhaleTracker, WHALES_DEFAULTS } from './WhaleTracker';
import { Correl, CORR_DEFAULTS, HEAT_DEFAULTS, HeatGrid, Monitor, MONITOR_DEFAULTS, VOL_DEFAULTS, VolMonitor } from '../pro/MarketPanels';
import { CandleForecastPanel, FCST_DEFAULTS, GarchPanel, GARCH_DEFAULTS } from '../pro/VolPanels';
import { DeltaHedgePanel, DELTA_DEFAULTS, MomentumPanel, MOM_DEFAULTS, RegimePanel, REGM_DEFAULTS, VarPanel, VAR_DEFAULTS, VolTargetPanel, VTGT_DEFAULTS } from '../pro/QuantPanels';
import { LunoLane } from './LunoLane';
import { CapmPanel, CAPM_DEFAULTS, EF_DEFAULTS, FrontierPanel, KellyPanel, KELLY_DEFAULTS } from '../pro/PortfolioPanels';
import { CommandCenter } from '../command/CommandCenter';

/** the Command Center as a panel (the professional terminal's F3) */
function SwarmCommandPanel() {
  return (
    <div className="cc-panel">
      <CommandCenter />
    </div>
  );
}
import { BUILDER_DEFAULTS, LabBuilder, LabDeployed, LabLibrary, LabResearch, LIB_DEFAULTS, RESEARCH_PANEL_DEFAULTS } from '../pro/LabPanels';
import { ProHelp } from '../pro/HelpPanel';

export type Category = 'Charts' | 'Orderflow' | 'Order book' | 'Derivatives' | 'Market' | 'Quant' | 'Account' | 'Algo' | 'Strategy Lab' | 'Tools';

export interface PanelDef {
  id: string;
  title: string;
  description: string;
  category: Category;
  component: (p: PanelProps<any>) => ReactElement;
  defaults: Record<string, unknown>;
  /** reads the aggregate set (has a Σ venue mask) rather than the primary only */
  aggregated?: boolean;
}

export const PANELS: PanelDef[] = [
  { id: 'monitor', title: 'MON · Monitor', category: 'Market', component: Monitor, defaults: { ...MONITOR_DEFAULTS }, description: 'Quote board for every market on the venue: last, change, high, low, volume, funding APR, open interest. Click a row to make it the market.' },
  { id: 'heatgrid', title: 'HMAP · Heat Map', category: 'Market', component: HeatGrid, defaults: { ...HEAT_DEFAULTS }, description: 'The market as tiles, sized by volume and coloured by the day’s change.' },
  { id: 'correl', title: 'CORR · Correlation', category: 'Market', component: Correl, defaults: { ...CORR_DEFAULTS }, description: 'Correlation matrix of returns (7, 30 or 90 days), beta to bitcoin and volatility.' },
  { id: 'volmon', title: 'HVOL · Volatility', category: 'Market', component: VolMonitor, defaults: { ...VOL_DEFAULTS }, description: 'Realised volatility over a day, a week and a month, its term structure and rank.' },
  { id: 'garch', title: 'GV · GARCH volatility', category: 'Market', component: GarchPanel, defaults: { ...GARCH_DEFAULTS }, description: 'Each coin’s fitted GARCH model: forecast volatility for the hours ahead as a heat calendar, the long-run level, persistence, half-life and value at risk.' },
  { id: 'fcst', title: 'FCST · Candle forecast', category: 'Market', component: CandleForecastPanel, defaults: { ...FCST_DEFAULTS }, description: 'Forecast of the next candle (range from GARCH and candle shapes, direction from a random forest), with its out-of-sample record and what drives it.' },
  { id: 'qvar', title: 'VAR · Value at risk', category: 'Quant', component: VarPanel, defaults: { ...VAR_DEFAULTS }, description: 'Value at risk and expected shortfall by five methods (historical, normal, Cornish–Fisher, EWMA, GARCH) at any horizon and confidence, a portfolio line, and each method backtested with Kupiec and Christoffersen tests.' },
  { id: 'qdelta', title: 'DHG · Delta hedging', category: 'Quant', component: DeltaHedgePanel, defaults: { ...DELTA_DEFAULTS }, description: 'Black–Scholes greeks for an option on the coin, the perpetual hedge to hold, a strike ladder, and a delta-hedging backtest by hedge frequency — the volatility risk premium in money.' },
  { id: 'qvtgt', title: 'VTGT · Volatility targeting', category: 'Quant', component: VolTargetPanel, defaults: { ...VTGT_DEFAULTS }, description: 'Volatility by five range estimators, EWMA and GARCH; the position that runs at your target volatility; a vol-targeted buy-and-hold against plain; a Kelly calculator.' },
  { id: 'qmom', title: 'MOM · Momentum', category: 'Quant', component: MomentumPanel, defaults: { ...MOM_DEFAULTS }, description: 'Time-series momentum over a week to six months, scaled by volatility, regression and Kalman trend t-statistics, a composite signal and the cross-sectional rank.' },
  { id: 'qregm', title: 'REGM · Regimes', category: 'Quant', component: RegimePanel, defaults: { ...REGM_DEFAULTS }, description: 'Trending, mean-reverting or random (Hurst, variance ratio, Ornstein–Uhlenbeck half-life), and calm or turbulent (a two-state hidden Markov model), coin by coin.' },
  { id: 'qcapm', title: 'CAPM · Capital asset pricing', category: 'Quant', component: CapmPanel, defaults: { ...CAPM_DEFAULTS }, description: 'Each coin against the market (bitcoin or an equal-weight index): beta, Jensen’s alpha and its t, R², the return CAPM expects, Treynor and information ratios, and the security market line.' },
  { id: 'qef', title: 'EF · Efficient frontier', category: 'Quant', component: FrontierPanel, defaults: { ...EF_DEFAULTS }, description: 'The long-only Markowitz frontier of the coins: minimum-variance and maximum-Sharpe portfolios, the capital market line, equal weight and the Kelly portfolio, with their weights.' },
  { id: 'qkelly', title: 'KELLY · Kelly criterion', category: 'Quant', component: KellyPanel, defaults: { ...KELLY_DEFAULTS }, description: 'Growth-optimal leverage coin by coin and its growth curve, the growth-optimal portfolio, and Kelly on the crypto swarm’s own trade record.' },
  { id: 'luno', title: 'LUNO · Luno lane', category: 'Account', component: LunoLane, defaults: {}, description: 'Optional: crypto against rands on Luno — daily trend bots beside the swarm.' },
  { id: 'lablib', title: 'LIB · Strategy Library', category: 'Strategy Lab', component: LabLibrary, defaults: { ...LIB_DEFAULTS }, description: 'Every rule and filter in the Strategy Lab with the papers behind it and why it should work.' },
  { id: 'labresearch', title: 'RSCH · Research', category: 'Strategy Lab', component: LabResearch, defaults: { ...RESEARCH_PANEL_DEFAULTS }, description: 'Search published rules and their combinations on years of history; rank the top five with out-of-sample tests, Monte Carlo and a deflated Sharpe ratio; deploy them.' },
  { id: 'labbuilder', title: 'BT · Backtest Builder', category: 'Strategy Lab', component: LabBuilder, defaults: { ...BUILDER_DEFAULTS }, description: 'Build a strategy from the library by hand — entry, filters, exits — and backtest it in and out of sample.' },
  { id: 'labdeployed', title: 'DEPL · Deployed', category: 'Strategy Lab', component: LabDeployed, defaults: {}, description: 'The strategies trading in the swarms, on/off, and what the Lab agent has said.' },
  { id: 'prohelp', title: 'HELP · Functions', category: 'Tools', component: ProHelp, defaults: {}, description: 'Every function code and key in the professional terminal.' },
  { id: 'footprint', title: 'Footprint Chart', category: 'Charts', component: FootprintChart, defaults: { ...FOOTPRINT_DEFAULTS }, description: 'Bid×ask clusters, delta, imbalances, POC, heatmap/CVD/VP/bubble overlays, time/tick/volume/range bars.' },
  { id: 'heatmap', title: 'Liquidity Heatmap', category: 'Charts', component: LiquidityHeatmap, defaults: { ...HEATMAP_DEFAULTS }, aggregated: true, description: 'Historical depth-of-market heatmap with trade bubbles and live book profile.' },
  { id: 'historical', title: 'Historical Chart', category: 'Charts', component: HistoricalChart, defaults: { ...HISTORICAL_DEFAULTS }, description: 'Candlesticks or TPO market profile with VWAP, session volume profile, MAs and EMA clouds.' },
  { id: 'vprofile', title: 'Volume Profile', category: 'Charts', component: VolumeProfilePanel, defaults: { ...VPROFILE_DEFAULTS }, description: 'Session or rolling volume profile with POC, value area and delta per level.' },
  { id: 'dom', title: 'DOM Ladder', category: 'Order book', component: DomLadder, defaults: { ...DOM_DEFAULTS }, description: 'Price ladder: resting bids/asks, traded volume, delta and session range. Click a level to price the Order Ticket.' },
  { id: 'orderbook', title: 'Orderbook', category: 'Order book', component: Orderbook, defaults: { ...ORDERBOOK_DEFAULTS }, aggregated: true, description: 'Composite multi-venue order book with per-venue contribution.' },
  { id: 'depth', title: 'Depth Chart', category: 'Order book', component: DepthChart, defaults: { ...DEPTH_DEFAULTS }, aggregated: true, description: 'Cumulative bid/ask depth across venues.' },
  { id: 'obstats', title: 'Orderbook Stats', category: 'Order book', component: OrderbookStats, defaults: { ...OBSTATS_DEFAULTS }, aggregated: true, description: 'Spread, depth within 0.5/2/10% and book imbalance per venue.' },
  { id: 'tape', title: 'Trades Tape', category: 'Orderflow', component: TradesTape, defaults: { ...TAPE_DEFAULTS }, aggregated: true, description: 'Time & sales across venues with size tiers, filters and aggregation.' },
  { id: 'flowpulse', title: 'Flow Pulse', category: 'Orderflow', component: FlowPulse, defaults: { ...FLOW_DEFAULTS }, aggregated: true, description: 'Rolling 30s/1m/5m/15m buy vs sell notional and per-venue delta.' },
  { id: 'cvd', title: 'CVD', category: 'Orderflow', component: CvdChart, defaults: { ...CVD_DEFAULTS }, aggregated: true, description: 'Cumulative volume delta per venue and aggregated.' },
  { id: 'whales', title: 'Whale Tracker', category: 'Orderflow', component: WhaleTracker, defaults: { ...WHALES_DEFAULTS }, aggregated: true, description: 'Large prints and liquidations across venues with net whale flow.' },
  { id: 'liquidations', title: 'Liquidations', category: 'Derivatives', component: Liquidations, defaults: { ...LIQ_DEFAULTS }, aggregated: true, description: 'Forced orders feed with long/short totals and timeline.' },
  { id: 'oi', title: 'Open Interest', category: 'Derivatives', component: OpenInterest, defaults: { ...OI_DEFAULTS }, aggregated: true, description: 'Open interest in USD per venue and aggregated.' },
  { id: 'funding', title: 'Funding', category: 'Derivatives', component: FundingMonitor, defaults: { ...FUNDING_DEFAULTS }, aggregated: true, description: 'Funding rates, APR, countdown and basis across perp venues.' },
  { id: 'options', title: 'Options Flow', category: 'Derivatives', component: OptionsFlow, defaults: { ...OPTIONS_DEFAULTS }, description: 'Deribit option prints: premium, IV, strikes, put/call and block trades.' },
  { id: 'spread', title: 'Spread Chart', category: 'Market', component: SpreadChart, defaults: { ...SPREAD_DEFAULTS }, aggregated: true, description: 'Price difference of each venue versus the primary.' },
  { id: 'summary', title: 'Symbol Summary', category: 'Market', component: SymbolSummary, defaults: { ...SUMMARY_DEFAULTS }, description: 'Price, 24h stats, funding, OI, long/short ratio and basis.' },
  { id: 'screener', title: 'Screener', category: 'Market', component: Screener, defaults: { ...SCREENER_DEFAULTS }, description: 'All perps on a venue: price, change, volume, funding, OI.' },
  { id: 'watchlist', title: 'Watchlist', category: 'Market', component: Watchlist, defaults: { ...WATCHLIST_DEFAULTS }, description: 'Prices for any symbol on any supported venue.' },
  { id: 'yahoo', title: 'Yahoo Finance', category: 'Market', component: YahooPanel, defaults: { ...YAHOO_DEFAULTS }, description: 'Stocks, indices, futures, FX and crypto from Yahoo Finance: quote board, search and candles.' },
  { id: 'news', title: 'News', category: 'Market', component: NewsFeed, defaults: { ...NEWS_DEFAULTS }, description: 'Real-time headlines (Tree of Alpha) filtered by coin.' },
  { id: 'ticket', title: 'Order Ticket', category: 'Account', component: OrderTicket, defaults: { ...TICKET_DEFAULTS }, description: 'Place market, limit, stop and stop-limit orders on any CCXT exchange, with value cap, confirmation and an order log. Click a DOM level to set the price.' },
  { id: 'accounts', title: 'Exchange Accounts', category: 'Account', component: AccountsPanel, defaults: { ...ACCOUNTS_DEFAULTS }, description: 'Balances, positions, open orders and fills from any CCXT exchange using keys in your vault.' },
  { id: 'wallet', title: 'Phantom Wallet', category: 'Account', component: WalletPanel, defaults: { ...WALLET_DEFAULTS }, description: 'Connect Phantom (signed proof of ownership) or watch any Solana address: SOL, tokens and USD value.' },
  { id: 'database', title: 'Database', category: 'Account', component: DatabasePanel, defaults: { ...DATABASE_DEFAULTS }, description: 'Local SQLite: recorded trades per instrument, retention, CSV export, key and wallet counts.' },
  { id: 'swarmcmd', title: 'SWRM · Swarm command', category: 'Algo', component: SwarmCommandPanel, defaults: {}, description: 'The crypto swarm at a glance: the swarm core, its gauges, the account, the execution tape and the live feed — and the deploy gate where Strategy Lab strategies plug in (they propose; the council, the forest and the risk manager decide).' },
  { id: 'cswarm', title: 'Crypto Swarm', category: 'Algo', component: CryptoSwarm, defaults: { ...CRYPTO_SWARM_DEFAULTS }, description: 'A team of agents trading crypto perpetuals on Hyperliquid: Scalper, Auctioneer and Trend propose; Tape, Crowd, Guardian, Forest and Risk vote. Compounding risk, its own account, paper or live, every trade on Telegram with its chart.' },
  { id: 'amt', title: 'AMT Bots', category: 'Algo', component: AmtScalper, defaults: { ...AMT_DEFAULTS }, description: 'Auction Market Theory bots for any symbol — Scalp (rolling value, order flow, minutes) or Intraday (initial balance, prior-day value, holds for hours). Paper or live, on/off switch, backtest on recorded trades.' },
  { id: 'telegram', title: 'Telegram Bot', category: 'Tools', component: TelegramPanel, defaults: { ...TELEGRAM_DEFAULTS }, description: 'Send alerts to Telegram and answer /price and /status from your chat.' },
  { id: 'alerts', title: 'Alerts', category: 'Tools', component: AlertsPanel, defaults: { ...ALERTS_DEFAULTS }, description: 'Twelve alert types evaluated in your browser against the live feed.' },
  { id: 'journal', title: 'Journal', category: 'Tools', component: Journal, defaults: { ...JOURNAL_DEFAULTS }, description: 'Timestamped trading notes stored in your browser.' },
  { id: 'calculator', title: 'Calculator', category: 'Tools', component: Calculator, defaults: { ...CALC_DEFAULTS }, description: 'Position size, risk/reward, liquidation estimate and market-cap math.' },
];

export const PANEL_MAP = Object.fromEntries(PANELS.map((p) => [p.id, p]));
