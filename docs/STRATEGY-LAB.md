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

## The library

Seventeen entry rules and six filters, each written from its paper:

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

Filters: long-term trend (Faber 2007), volatility regime (Moreira & Muir 2017;
Barroso & Santa-Clara 2015), trend strength ADX (Wilder 1978), participation
(Blume, Easley & O'Hara 1994), trading session (Baur et al. 2019; Wen et al.
2022), funding crowding (He et al. 2022; Christin et al. 2023).

Exits: a stop in ATR, an optional target in R, a trailing stop from +1R, a
time limit, and whether an opposite signal closes the trade.

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
6. **The top five**, each with a verdict:
   - **EDGE** — passes at least six of the seven tests, including the Sharpe
     and the deflated Sharpe
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
