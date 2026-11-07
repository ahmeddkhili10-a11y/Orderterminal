# The professional terminal

Novus Ordo opens on a professional, Bloomberg-style terminal: dense, flat,
square, every number on screen backed by live data. The classic swarm views
(the old order-flow layout) is in Settings.

## Layout

- **Two views**, side by side at the top left: **▤ Terminal** (Ctrl+1) — this
  terminal — and **Crypto swarm** (Ctrl+2), a view of its own for running the
  swarm and your accounts. They meet in one place: strategies deployed from the
  Strategy Lab.
- **Workspaces** across the top of the terminal: **MARKETS** (F1), **STRATEGY
  LAB** (F2), **QUANT DESK** (F3). Each keeps its own layout; drag,
  split and close panels with **✎ Layout**.
- **The command line** under them. Type a function code and press Enter; a
  coin first makes it the market: `ETH GP`, `SOL BOOK`, `HMAP`, `RSCH`.
  Suggestions appear as you type (↑/↓ to pick). **Ctrl+K** or **`** jumps to it.
- **Function keys** for the workspace beside it, and a running **quote tape**
  of the most traded markets.
- **The status line** at the bottom: the feed, the Lab, UTC and local time.
- **Swarm codes** (`SWRM`, `TKT`, `PORT`, `AMT`, `ALRT`, `TG`, `WALL`, `LUNO`,
  `CALC`, `NOTE`, `DB`) switch to the crypto swarm view and open that tool
  there; they never open inside the terminal.

## Functions

| Code | Screen | | Code | Screen |
|---|---|---|---|---|
| `MON` | Monitor — the quote board | | `BOT` | Bot builder |
| | | | `LIB` | Strategy library |
| `HMAP` | Heat map | | `RSCH` | Research |
| `GP` | Price graph | | `BT` | Backtest builder |
| `GIP` | Footprint | | `DEPL` | Deployed strategies |
| `LHM` | Liquidity heat map | | `TKT` | Order ticket |
| `CORR` | Correlation matrix, beta | | `AMT` | AMT bots |
| `HVOL` | Volatility monitor | | | |
| `GV` | GARCH volatility: heat calendar of the hours ahead, model, VaR | | | |
| `FCST` | Candle forecast: next high, low, P(up), track record | | | |
| `DES` | Description / summary | | `PORT` | Portfolio |
| `BOOK` | Order book | | `ALRT` | Alerts |
| `DOM` | Depth ladder | | `LUNO` | Luno lane (rands) |
| `DPTH` | Depth chart | | `VAR` | Value at risk (F3) |
| `SWRM` | Crypto swarm view | | `CAPM` | CAPM (F3) |
| `SWCF` | Swarm rules (swarm view) | | `EF` | Efficient frontier (F3) |
| | | | `KELLY` | Kelly criterion (F3) |
| | | | `NNET` | Neural network (F3) |
| `TAS` | Time & sales | | `DHG` | Delta hedging (F3) |
| `CVD` | Cumulative delta | | `WALL` | Wallet |
| `FLOW` | Flow pulse | | `TG` | Telegram |
| `BLCK` | Block trades | | `CALC` | Calculator |
| `LIQ` | Liquidations | | `NOTE` | Journal |
| `OI` | Open interest | | `DB` | Database |
| `FUND` | Funding | | `HELP` | Every function |
| `OMON` | Options | | `VTGT` | Volatility targeting (F3) |
| `SPRD` | Venue spread | | `MOM` | Momentum (F3) |
| `VP` | Volume profile | | `REGM` | Regimes (F3) |
| `SCRN` | Screener | | | |
| `WL` | Watchlist | | | |
| `TOP` | Top news | | | |
| `WEI` | World markets (Yahoo Finance) | | | |

## The QUANT desk (F3)

Quantitative-finance tools that open beside any instrument. Each follows the
coin on the board, and the tables list a set of coins you choose.

- **VAR — value at risk.** The loss not exceeded 95, 99 or 99.5 % of the time
  over an hour, a day or a week, as a share of the position and in dollars, by
  five methods: historical simulation, normal, Cornish–Fisher (skew and fat
  tails), EWMA (RiskMetrics) and GARCH. Expected shortfall beside it. An
  equal-weight portfolio line shows what diversifying saves. Each method's
  one-hour forecasts over the last 500 hours are backtested: Kupiec (the right
  number of breaches) and Christoffersen (breaches that do not cluster).
- **DHG — delta hedging.** Black–Scholes price and greeks for a call, put or
  straddle on the coin (strike, days, size, bought or sold), priced at the GARCH
  forecast, the realised volatility or your own (Deribit's implied, from
  `OMON`). The hedge to hold on the perpetual now; a strike ladder; and a
  backtest that sells (or buys) the option every day and hedges it every 1, 4, 12
  or 24 hours or never — the variance risk premium in money, and how hedging
  more often narrows the outcomes.
- **VTGT — volatility targeting and sizing.** Volatility by close-to-close,
  Parkinson, Garman–Klass, Rogers–Satchell, Yang–Zhang, EWMA and GARCH; the
  position that runs at your target volatility on your account; buy-and-hold
  against the same coin volatility-targeted; a Kelly calculator.
- **MOM — momentum.** Returns over a week to six months, the month in its own
  standard deviations, the 60-day trend t-statistic, the Kalman slope, a
  composite signal and the cross-sectional rank; the price with its Kalman
  trend.
- **REGM — regimes.** Hurst exponent, variance ratio, Ornstein–Uhlenbeck
  half-life and s-score (trending, mean-reverting or random), and a two-state
  hidden Markov model (calm or turbulent, with the odds hour by hour).
- **CAPM — capital asset pricing.** Each coin against the market (bitcoin or
  an equal-weight index): beta, Jensen's alpha and its t, R², the return CAPM
  expects for that beta, Treynor and information ratios, Sharpe, idiosyncratic
  volatility, and the security market line.
- **EF — efficient frontier.** The long-only Markowitz frontier of the coins,
  with the minimum-variance and maximum-Sharpe (tangency) portfolios, the
  capital market line, equal weight and the Kelly portfolio, and their weights.
  Expected returns are shrunk toward the coins' average (choose how much).
- **KELLY — the Kelly criterion.** Each coin's growth-optimal leverage and
  half Kelly with their growth, the growth curve by leverage (peak at full
  Kelly, back to cash's at twice it), the growth-optimal portfolio under a
  leverage cap, and Kelly on the crypto swarm's own trade record.
- **GV** gains a model choice (best by BIC, GARCH or **GJR-GARCH**) and the
  news-impact curve, which shows GJR's extra response to falls.
- **NNET — the neural network.** Train a small neural network (two hidden
  layers) on a coin's candles to forecast whether it is higher a few candles
  later; the error falls epoch by epoch on screen and it stops when the latest
  training data stops improving. Judged on the last 30 % it never saw against
  a random forest on the same inputs and the two paired: how often each was
  right against guessing, its confident calls as a trading record, what it
  looks at most, and how well its odds held up. The same network is in the
  Strategy Lab as a rule, a second opinion and an AI decision maker.

The same models feed the Strategy Lab: see [STRATEGY-LAB.md](STRATEGY-LAB.md).

## The meme swarm is retired

The meme desk, the meme swarm and its scanner are gone; the terminal is about
crypto. The swarm's old trading wallet is still listed in **WALL** if it
exists, so anything left in it can be sold and sent to your verified Phantom.

## Themes

Five professional themes on the top bar: **Terminal Amber** (black and amber),
**Workspace** (charcoal, orange keys, yellow headings), **Eikon Blue** (navy and
cyan), **Graphite** (grey) and **Paper** (light). Charts, the order book and the
heat maps follow the theme.

## Several screens

- **⧉ on any tab bar** pops that panel out into its own window. It streams its
  own market data; the swarms and the Strategy Lab reach it through the desktop
  app, as they reach the main window.
- **⧉ Screens** on the top bar shows every screen and every window on it. Send
  any window — the terminal itself or a popped-out panel — to any screen:
  **Fill** (maximised), **Full** (full screen, taskbar hidden) or **Float**.
  For example: pop the heat map out, **Fill** the laptop with it, and send the
  terminal **Full** to the monitor.
- Popped-out panels hide while the terminal is locked and come back where they
  were the next time you unlock.
- The meme swarm's panels stay in the main window: the meme swarm runs there.


## Moving tabs between workspaces, views and screens

- **⇄** on any tab bar moves that tab to another workspace (Markets, Strategy
  Lab, Quant desk) or into its own window.
- **⧉ Screens → Open any tool in its own window** — from any view, the crypto
  swarm's included: search any tool (BOT, NNET, VAR, the footprint…), choose a
  screen. The swarm can fill one screen while the quant desk or the bot
  builder fills another; windows stay open whichever view the main window is
  on. The swarm view's drawer has **⧉ Window** for its tools too.
- **⇤ Back to the terminal** on a popped-out window closes it and opens the
  tool where it lives.
