# The Strategy Lab

The Strategy Lab turns published trading research into strategies you can
test, rank and deploy into the swarms. It is the **STRATEGY LAB** workspace of
the professional terminal (F2, or type `RSCH`, `LIB`, `BT` or `DEPL` on the
command line).

It never promises an edge. It looks for one the way academic finance does, and
says plainly when it finds none.

## The screens

| Code | Screen | What it does |
|---|---|---|
| `LIB` | Library | Every rule and filter, the papers behind it, and why it should work |
| `RSCH` | Research | Downloads history, tests the library, mixes rules, ranks the top five, deploys |
| `BT` | Backtest builder | Build a strategy by hand from the library and test it |
| `DEPL` | Deployed | The strategies trading in the swarms, on/off, and what they have said |
| `GV` | GARCH volatility | Each coin's fitted GARCH model: the hours ahead as a heat calendar, long run, value at risk |
| `FCST` | Candle forecast | The next candle's expected high, low and odds of closing up, with its out-of-sample record |

## The library

Nineteen entry rules and seven filters, each written from its paper:

| Rule | Family | Papers |
|---|---|---|
| Time-series momentum | momentum | Moskowitz, Ooi & Pedersen (2012); Liu & Tsyvinski (2021); Kakushadze & Serur (2018) |
| Moving-average crossover | trend | Brock, Lakonishok & LeBaron (1992); Kakushadze & Serur; Grobys, Ahmed & Sapkota (2020); Corbet et al. (2019) |
| Three moving averages | trend | Kakushadze & Serur (2018) |
| Price-to-moving-average ratio | trend | Detzel, Liu, Strauss, Zhou & Zhu (2021) |
| Channel breakout | breakout | Brock et al. (1992); Faith (2007); Kakushadze & Serur; Hudson & Urquhart (2021) |
| Support and resistance (pivot points) | breakout | Kakushadze & Serur (2018) |
| Mean reversion (z-score) | reversion | Kakushadze & Serur; Jegadeesh (1990); Lo & MacKinlay (1990) |
| RSI extremes | reversion | Connors & Alvarez (2009); Wilder (1978) |
| Bollinger band breakout | breakout | Bollinger (2001); Hudson & Urquhart (2021) |
| MACD trend | trend | Appel (2005); Hudson & Urquhart (2021) |
| Intraday time-series momentum | momentum | Shen, Urquhart & Wang (2022); Wen, Bouri, Xu & Zhao (2022) |
| Monday effect | seasonal | Caporale & Plastun (2019); Baur, Cahill, Godfrey & Liu (2019) |
| Weekly reversal | reversion | Dobrynskaya (2023); Jegadeesh (1990) |
| Funding carry | carry | He, Manela, Ross & von Wachter (2022); Christin, Routledge, Soska & Zetlin-Jones (2023) |
| Volume-confirmed move | volume | Llorente, Michaely, Saar & Wang (2002); Blume, Easley & O'Hara (1994) |
| Linear forecast (ridge regression) | ml | Gu, Kelly & Xiu (2020); Kakushadze & Serur (2018), the bitcoin ANN |
| Random-forest direction | ml | Breiman (2001); Gu, Kelly & Xiu (2020) |
| Volatility-scaled momentum (GARCH) | momentum | Moskowitz, Ooi & Pedersen (2012); Bollerslev (1986); Liu & Tsyvinski (2021) |
| Next-candle forecast | ml | Nison (1991); Marshall, Young & Rose (2006); Lu, Shiu & Liu (2012); Breiman (2001) |

Filters: long-term trend (Faber 2007), volatility regime (Moreira & Muir 2017;
Barroso & Santa-Clara 2015), trend strength ADX (Wilder 1978), participation
(Blume, Easley & O'Hara 1994), trading session (Baur et al. 2019; Wen et al.
2022), funding crowding (He et al. 2022; Christin et al. 2023), GARCH
volatility regime (Bollerslev 1986; Moreira & Muir 2017; Hansen & Lunde 2005).

Exits: a stop in ATR **or in GARCH forecast volatility** (σ for the next bar,
known at the bar's close: the stop widens before a storm, not after), an
optional target in R, a trailing stop from +1R, a time limit, and whether an
opposite signal closes the trade. A third of the mixed strategies try a GARCH
stop; the builder has a **GARCH STOP (σ)** box.

## GARCH

Volatility clusters: calm follows calm and storms follow storms (Engle 1982;
Bollerslev 1986), and in crypto the clustering is strong and the tails are fat
(Katsiampa 2017). The Lab fits four models to each coin's in-sample returns —
GARCH(1,1) and GJR-GARCH (Glosten, Jagannathan & Runkle 1993: falls move
volatility more than rises), each with normal or Student-t errors — by maximum
likelihood, and keeps the one with the lowest BIC. GARCH(1,1) is hard to beat
(Hansen & Lunde 2005), so the Lab goes no further.

From the fit it reads:

- **σ for the next bar**, known at each bar's close — an input to every learned
  rule and the meta-labeller (with σ against its long-run level), the scale of
  volatility-scaled momentum, the GARCH stop and the GARCH regime filter;
- **the forecast path**: σ reverts to its long-run level at the speed of the
  persistence (α + β + γ/2), with a half-life in hours;
- **value at risk** over any horizon, from the fitted error distribution;
- **the hour-of-day pattern** (Andersen & Bollerslev 1997), shown as a heat
  calendar on `GV` and on the Research screen.

It is tested, not assumed: out of sample, GARCH's one-step forecasts are scored
against an exponentially weighted average (RiskMetrics, λ = 0.94) and a rolling
one with the QLIKE loss (Patton 2011) and a Diebold–Mariano t.

**GARCH worlds.** The eight leading strategies face one more test. For each
coin the Lab keeps the real history up to the split and simulates the rest from
the coin's own GARCH model driven by its own standardised shocks (filtered
historical simulation, Barone-Adesi, Giannopoulos & Vosper 1999), borrowing
candle shapes and volume from the bars those shocks came from. These worlds
have the coin's volatility clusters and fat tails but no edge. The strategy
runs unchanged in 19 of them; if it beat its real out-of-sample Sharpe in more
than 10 % of them, volatility alone could explain the result and the check
fails.

## Candle forecasting

A candle's **size** is forecastable — volatility clusters — while its
**colour** mostly is not. The Lab treats both honestly. For each coin it
describes every candle by its shape (body, upper and lower wick, where it
closed in its range, range and gap in ATR, run of same-coloured candles, and
the engulfing, doji and hammer/shooting-star patterns of Nison 1991; Caginalp &
Laurent 1998; Lu, Shiu & Liu 2012), adds GARCH σ and the usual momentum and
volume inputs, and trains in sample:

- a **random forest** for the odds that the next candle closes up;
- two **ridge regressions** for the next candle's high and low, as distances
  from its open.

Out of sample it reports the hit rate against always calling the commoner
side, the **Brier skill** of the odds (above zero: they carry information), and
the error of the range forecast against GARCH alone and against the last
candle's range, with **permutation importance** for each input. The
next-candle forest is also a rule in the library (“Next-candle forecast”),
tested like any other; Marshall, Young & Rose (2006) found candlestick patterns
alone had no value, which is why the Lab tests rather than trusts them. The
candle features are inputs to the ridge and forest rules and the meta-labeller.

The **Forecasting** tab on the Research screen shows all of it per coin, and
`FCST` shows the live forecast of the next candle for the board's coin.

From *151 Trading Strategies* (Kakushadze & Serur, SSRN 3247865) the Lab takes
the strategies that apply to a single crypto market: the moving-average,
three-average, channel, support-and-resistance and mean-reversion rules, and a
linear stand-in for its bitcoin neural network. Its cross-sectional stock
strategies, options, fixed income, real estate and the rest need data a crypto
perpetual does not have.

## How a research run works

1. **History.** Years of candles for the chosen coins (Binance spot first for
   the longest history, then OKX, Bybit, Hyperliquid), cached on disk so the
   next run only fetches what is new; funding history when it can find it.
2. **Split.** The first 70 % of each coin's history trains and selects (in
   sample). The last 30 % is never looked at until the end (out of sample).
3. **The library as published.** Every rule over its parameter grid, in
   sample, on all coins at once with the same rules — a rule that works on
   one coin only is likely luck. **Library comparison** on the Research screen
   shows each paper's best version in and out of sample, side by side.
4. **Mix and match.** The strongest rules are combined with other papers'
   filters and different exits: hundreds of new strategies, still in sample.
5. **The finalists meet unseen data.** The best two dozen (no more than four
   of any one rule, to keep the list varied) run out of sample and face:
   - **Sharpe ratio** out of sample (after fees, slippage and funding)
   - **Newey–West t-statistic** of the mean return (honest when returns are
     autocorrelated)
   - **Deflated Sharpe ratio**: the chance the Sharpe beats the best that
     luck alone would give when choosing among the finalists over this many
     bars (Bailey & López de Prado 2014)
   - **Random-entry Monte Carlo**: the same trades, held as long, on the same
     sides, entered at random times, 500 times — the p-value is how often
     luck did as well
   - **Trade Monte Carlo**: 2,000 shuffles of the trade sequence at 1 % risk
     per trade — the spread of outcomes, the chance of a loss, the drawdowns
   - **Regression on buy-and-hold**: alpha (and its t) and beta — is it more
     than the market's drift?
   - **Random-forest meta-labelling** (López de Prado 2018): a forest learns,
     in sample, which of the strategy's signals tend to fail, and is kept only
     if it lifts the out-of-sample Sharpe
   - **Probability of backtest overfitting** for the group (Bailey, Borwein,
     López de Prado & Zhu 2017)
   - **GARCH worlds** (the leading eight): does it beat simulated markets with
     the coin's own volatility but no edge? (see GARCH above)
6. **The top five**, each with a verdict:
   - **EDGE** — passes all but one of its tests, including the Sharpe and the
     deflated Sharpe
   - **PROMISING** — out-of-sample Sharpe above 0.5, t above 1.5, deflated
     Sharpe above 50 %
   - **NO EDGE** — everything else, said plainly

On pure noise the Lab finds lucky strategies with out-of-sample Sharpe ratios
above 2. The deflated Sharpe and the random-entry test are what stop those
being called an edge; the tests check this.

## Deploying

- **Deploy → Crypto swarm** puts a strategy into the crypto swarm as the
  **Lab** agent. On each closed candle of its own timeframe it reads its signal
  on every coin it was researched on. A new signal is proposed to the council
  like any other agent's: the other agents vote, the risk manager sizes it
  (1 % of the account, compounding), and the trade follows the exits it was
  tested with (stop, target, trail, time limit, opposite signal). Its messages
  carry the tested Sharpe, t and verdict.
- **→ Meme swarm** gives the strategy a vote in the meme swarm's council, read
  on each coin's own market-cap chart. Only rules that make sense on a short,
  wild chart vote (momentum, trend, breakout, volume). They were tested on
  major coins, not meme coins, so they vote but never veto.
- **DEPL** lists what is deployed; switch each on or off, or remove it.

## Honest limits

- Past performance in any backtest, however carefully tested, does not
  guarantee future results. Markets change; edges decay once published.
- Out-of-sample tests on one history are one draw; more coins, more years and
  another timeframe make the verdict firmer.
- The backtester fills at the next bar's open plus slippage and checks the stop
  before the target inside a bar. Real fills in fast markets can be worse.
- A hand-built test (BT) is one trial: its probabilistic Sharpe is not deflated
  for the other strategies you tried. The Research screen corrects for that.
