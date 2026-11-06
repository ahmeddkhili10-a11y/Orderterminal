# The professional terminal

Novus Ordo opens on a professional, Bloomberg-style terminal: dense, flat,
square, every number on screen backed by live data. The classic swarm views
(the Command Center and the 3D island) are one click away (**◐ Classic** on
the top bar; **▤ Pro terminal** brings this back).

## Layout

- **Workspaces** across the top: **MARKETS** (F1), **STRATEGY LAB** (F2),
  **CRYPTO SWARM** (F3), **QUANT DESK** (F4). Each keeps its own layout; drag,
  split and close panels with **✎ Layout**.
- **The command line** under them. Type a function code and press Enter; a
  coin first makes it the market: `ETH GP`, `SOL BOOK`, `HMAP`, `RSCH`.
  Suggestions appear as you type (↑/↓ to pick). **Ctrl+K** or **`** jumps to it.
- **Function keys** for the workspace beside it, and a running **quote tape**
  of the most traded markets.
- **The status line** at the bottom: the feed, the crypto swarm, the Lab, UTC
  and local time.

## Functions

| Code | Screen | | Code | Screen |
|---|---|---|---|---|
| `MON` | Monitor — the quote board | | `LIB` | Strategy library |
| `HMAP` | Heat map | | `RSCH` | Research |
| `GP` | Price graph | | `BT` | Backtest builder |
| `GIP` | Footprint | | `DEPL` | Deployed strategies |
| `LHM` | Liquidity heat map | | `SWRM` | Crypto swarm |
| `CORR` | Correlation matrix, beta | | `AMT` | AMT bots |
| `HVOL` | Volatility monitor | | `TKT` | Order ticket |
| `GV` | GARCH volatility: heat calendar of the hours ahead, model, VaR | | | |
| `FCST` | Candle forecast: next high, low, P(up), track record | | | |
| `DES` | Description / summary | | `PORT` | Portfolio |
| `BOOK` | Order book | | `ALRT` | Alerts |
| `DOM` | Depth ladder | | `LUNO` | Luno lane (rands) |
| `DPTH` | Depth chart | | `VAR` | Value at risk (F4) |
| `TAS` | Time & sales | | `DHG` | Delta hedging (F4) |
| `CVD` | Cumulative delta | | `WALL` | Wallet |
| `FLOW` | Flow pulse | | `TG` | Telegram |
| `BLCK` | Block trades | | `CALC` | Calculator |
| `LIQ` | Liquidations | | `NOTE` | Journal |
| `OI` | Open interest | | `DB` | Database |
| `FUND` | Funding | | `HELP` | Every function |
| `OMON` | Options | | `VTGT` | Volatility targeting (F4) |
| `SPRD` | Venue spread | | `MOM` | Momentum (F4) |
| `VP` | Volume profile | | `REGM` | Regimes (F4) |
| `SCRN` | Screener | | | |
| `WL` | Watchlist | | | |
| `TOP` | Top news | | | |
| `WEI` | World markets (Yahoo Finance) | | | |

## The QUANT desk (F4)

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
- **GV** gains a model choice (best by BIC, GARCH or **GJR-GARCH**) and the
  news-impact curve, which shows GJR's extra response to falls.

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
