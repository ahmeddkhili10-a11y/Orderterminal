# The crypto swarm

A team of agents trading crypto perpetual futures on Hyperliquid — the order-flow
terminal's counterpart to the meme swarm. Both run at the same time, whichever
tab is on screen (**Meme swarm** / **Crypto swarm** on the top bar, or Ctrl+1 /
Ctrl+2). They share nothing: the meme swarm trades Solana meme coins from its
own Solana wallet; the crypto swarm trades BTC, ETH, SOL (or the coins you
choose) from your Hyperliquid account. Separate money, separate records,
separate forests — no arguing over who gets what.

## The agents

Three agents propose trades; five more vote on them.

| Agent | Proposes / votes | What it does | Built on |
|---|---|---|---|
| **Scalper** | proposes | order-flow scalps on the 1-minute tape: absorption, sweeps, aggressive delta with the book behind it | order-flow imbalance drives short-horizon price changes (Cont, Kukanov & Stoikov 2014) |
| **Auctioneer** | proposes | intraday auction market theory: the session's value area, initial-balance breakouts, the 80 % rule back into prior value | Steidlmayer's market profile, Dalton's *Mind Over Markets*; intraday momentum and reversal in crypto (Wen, Bouri, Xu & Zhao 2022) |
| **Trend** | proposes | time-series momentum: the 20/60/120-day trends vote; entries on hourly 20-bar breakouts in their direction, 2-ATR stop, 4-ATR target, break-even at 1R, trailing from 2R | Moskowitz, Ooi & Pedersen 2012; in crypto, Liu & Tsyvinski 2021; a century of trend following (Hurst, Ooi & Pedersen 2017) |
| **Tape** | votes | the last seconds of aggressive buying and selling and the book: for when flow is with the trade, against when it is against | as the Scalper |
| **Crowd** | votes | funding: when the trade's side pays a lot to hold, it is crowded — a vote against; when the other side pays, a vote for | perpetual futures and funding (He, Manela, Ross & von Wachter 2022) |
| **Guardian** | veto only | a spread over 8 bps or 1-minute moves over 80 bps: no trade | — |
| **Forest** | votes, veto once trusted | the odds of a loss, scratch, win or big win and the expected result in R after costs, from a random forest (Breiman 2001) | learned from every paper, live and refused trade |
| **Risk** | veto | the compounding risk manager (below) | Kelly 1956; fractional Kelly (MacLean, Thorp & Ziemba 2011) |

**The council.** A trade needs no veto and a weighted score of 2 or more: the
proposer counts 1.5, Trend, Tape and Risk 1, Crowd 0.5 for or 1 against, the
Forest 0.5 plus its trust. The proposer and the risk manager alone carry a clean
trade (2.5); the tape against it, or the daily trend against it, stops it. Every
proposal and every vote is in the panel's council feed.

**One position per coin**, a few at most in all: crypto coins move together.

## Compounding, and staying alive

- Every trade risks **1 % of what the account is worth now** (between 0.25 %
  and 2 % after adjustments). Profits make the next trade bigger, losses make it
  smaller — the account compounds.
- The position is sized from the stop; leverage is a consequence, capped at
  **3× per coin and 3× for all positions together**, on isolated margin.
- After 20 closed trades, size follows the record: a quarter of the Kelly bet,
  between half and 1.5× the normal risk. Strong odds from the forest add 15 %,
  weak odds take 25 % off.
- Three-quarter size 10 % under the account's high, half size 20 % under.
- No new trades for the day after losing 5 %; an hour's pause after 3 losses in
  a row.
- **The floor**: no trades under 70 % of the start — and once the account
  reaches 1.25× its start, the floor rises to 80 % of its high and only ever
  goes up. Profits get locked in.
- Hyperliquid's smallest order is $10: a trade that would need more risk than
  allowed to reach it is skipped.

No system can promise to always be in profit. These rules make losses small and
survivable, and let the wins compound.

## Learning

Each trade is described by 15 numbers when it is proposed (the agent, side,
reward-to-risk, stop width, daily trend, flow, book, spread, volatility,
funding, hour, position in value, the agent's recent record, the coin). When it
closes, its result in R is the label: loss, scratch, win, big win. Trades the
council refused are followed anyway to their stop, target or time limit (the
shadow book), so the forest also learns what refusing cost or saved. It
retrains every 10 minutes once it has 30 trades; until then a prior shaped by
the research decides, and the learned forest's weight grows with its data
(n / (n + 40)). The prior alone never vetoes.

## On your phone

Every trade sends three Telegram messages, each with a picture of the chart it
trades on (entry, stop, target, the value area):

1. **The setup** — coin, long or short, the agent; entry, stop and target; the
   potential gain in dollars and R against the risk; the positioning (why there,
   why that stop); the odds; the council's votes.
2. **Managing** — the first decision after entry (stop to break-even, trailing,
   or "halfway to target, holding"), and every decision so far.
3. **The result** — green for a profit, red for a loss: P&L in dollars and R,
   entry → exit, how long it was held, fees, the account after it, how it was
   managed, and a verdict in plain words.

Switch it in the Telegram panel: **Crypto swarm trades on Telegram**.

## Paper and live

- **Paper** (default): a $30 paper account (≈ R500, change it under Rules)
  trading Hyperliquid's real prices, with fees and slippage counted. No key
  needed.
- **Live**: choose your Hyperliquid key (🔌 Connect → Hyperliquid, see
  [HYPERLIQUID.md](HYPERLIQUID.md)) with “Allow trading” ticked; a dialog asks
  you to confirm. Orders are market orders within the ticket's order cap; every
  position gets an exchange-side stop half a risk unit beyond the swarm's own,
  which follows break-even and trailing moves. A testnet key trades the
  testnet.
- The top bar's kill switch stops the crypto swarm too; positions keep their
  exchange stops. **Stop & close all** closes them at market.

The order-flow agents (Scalper, Auctioneer) learn the session's value first:
expect 20–60 minutes before their first proposals.

## References

- Breiman, L. (2001). Random forests. *Machine Learning* 45.
- Cont, R., Kukanov, A. & Stoikov, S. (2014). The price impact of order book events. *Journal of Financial Econometrics* 12(1).
- Dalton, J., Jones, E. & Dalton, R. (2007). *Mind Over Markets*. Wiley.
- He, S., Manela, A., Ross, O. & von Wachter, V. (2022). Fundamentals of perpetual futures. Working paper.
- Hurst, B., Ooi, Y. H. & Pedersen, L. H. (2017). A century of evidence on trend-following investing. *Journal of Portfolio Management* 44(1).
- Kelly, J. L. (1956). A new interpretation of information rate. *Bell System Technical Journal* 35(4).
- Liu, Y. & Tsyvinski, A. (2021). Risks and returns of cryptocurrency. *Review of Financial Studies* 34(6).
- MacLean, L., Thorp, E. & Ziemba, W. (2011). *The Kelly Capital Growth Investment Criterion*. World Scientific.
- Moskowitz, T., Ooi, Y. H. & Pedersen, L. H. (2012). Time series momentum. *Journal of Financial Economics* 104(2).
- Wen, Z., Bouri, E., Xu, Y. & Zhao, Y. (2022). Intraday return predictability in the cryptocurrency markets: momentum, reversal, or both. *North American Journal of Economics and Finance* 62.

## The Command Center

The crypto swarm is a view of its own, apart from the terminal: **Crypto
swarm** on the top bar (or Ctrl+2; Ctrl+1 goes back to the terminal). It is
the Command Center — the black-and-chrome screen the meme swarm had, carried
over — with everything that runs strategies on your accounts in its drawer:
**⇢ Deploy strategies**, **Swarm · rules**, **Accounts**, **Order ticket**,
**AMT bots**, **Alerts**, **Telegram**, **Wallet**, **Luno**, **Calculator**,
**Journal** and **Database** (**☰ Accounts & tools** opens it). The terminal
shows none of it; the only link is the strategies the Strategy Lab deploys.

- **Top**: the swarm's talk scrolling past, **⇢ Deploy** and **Start / Stop**.
- **Left**: the account and its P&L curve; the coin in focus (5-minute candles
  from the swarm's exchange, entry and exit marks, stop and target lines); the
  feeds (each coin, its daily trend, price and funding); capital at risk (each
  open position in R).
- **Centre — the swarm core**: what the agents read flows in from the left
  (feeds, Scalper, Auctioneer, Trend, the Lab's strategies, funding), each coin
  is a sphere of particles — bigger as its signals heat up, cyan for the daily
  trend, magenta for signal heat — held coins sit at the far tip, and the
  results flow out to the right. 3D where the machine draws WebGL, flat
  otherwise. Click a coin to focus it.
- **Right**: the account (equity, peak, drawdown, **Account · rules** opens the
  full swarm panel: paper or live, keys, agents, risk), the results and the
  execution tape.
- **Bottom — the gauges**: Scalper, Auctioneer, Trend; **Lab · deploy** (the
  deploy gate); the Council (how many proposals it lets through); the Forest
  (its accuracy, or samples while it learns); the Optimizer (risk a trade and
  the drawdown it is cutting for); Exposure; the daily Loss limit; the Floor.
  Then the live feed.

### The deploy gate

Click **Lab · deploy** (or **⇢ Deploy**) to deploy Strategy Lab strategies into
the swarm, switch them on and off or remove them. The chain is fixed:

1. the strategy's own tested entry rules fire on a closed candle;
2. the council votes (the proposer, the daily trend, the tape, the crowd);
3. the forest gives its odds and can veto;
4. the guardian checks the market and can veto; the risk manager decides the
   size — and can veto;
5. only then is the trade executed, and the strategy's own exits manage it.

A deployed strategy can never overrule the council, the forest or the risk
manager. Its tested sizing (a volatility target or a VaR budget) can only ask
for a **smaller** trade in a storm, never a bigger one.
