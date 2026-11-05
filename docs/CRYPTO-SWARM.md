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

## The market island

The crypto tab opens on the market island: the whole terminal is one 3D world
you move through. No panels on it — only the small market card (top left), the
connectors (top bar) and the money (bottom centre).

- **The lake in the middle is the order book.** Across is price, back to front
  is time (15 minutes ago to now), height is the liquidity resting at that price
  at that time: walls of orders rise as hills. **The glowing river is the
  price**, flowing to the orb of the price now. **Trades are lights** where and
  when they printed: gold for buyers, red for sellers.
- **The Exchange** (west) is the live book as a city: a tower per price level,
  bids cyan on one side of the avenue, asks orange on the other, nearest the
  price at the front. Towers grow and shrink as the book changes.
- **The Fields** (east) are the volume profile: a crop row per price, as tall
  as the volume traded there; the point of control is the golden row.
- **The Harbor** (the south-east bay) is the tape. The biggest trades sail in
  as boats with a wake behind them, bigger for bigger trades: gold sails moor
  west of the pier (buyers), red sails east (sellers), as in the book. When one
  docks, "BOUGHT $x" or "SOLD $x" rises over the pier and the crane swings its
  cargo ashore. The crates in the yard are the last minute's buying (west) and
  selling (east); the buoys at the harbour mouth blink green while buyers lead,
  red while sellers do. Hover a boat for its trade, the crates for the minute's
  flow.
- **The Lighthouse** (south-west) is volatility. Three rings of light up the
  tower are the 1, 5 and 15-minute moves (the top is the fastest): green up,
  red down, brighter for bigger. As the market gets wilder the beam turns
  faster and warms from white to red, the swell rises, clouds gather and rain
  falls; a hard 1-minute move brings lightning. While you visit, the beam
  follows your pointer like a searchlight. Hover a ring for its move.
- **The Council** (north) is the swarm: a domed hall with a robot on the plaza
  for each agent, hovering on a small jet, with a ring of light on the ground
  as its gauge and a face screen that shows how it feels. The debate is acted
  out in order:
  - the **proposer** takes the podium under a stage light, talks with its
    hands, and a link of light runs from it to the hall;
  - each **voter** steps forward in turn and links to the proposer: green
    sparks and a raised hand for, red sparks and crossed arms against, grey for
    an abstention, purple and both arms up for a veto. Its bubble says who it
    answers ("CROWD · votes against → TREND") and a ✓ / ✗ / – stays by its name
    until the verdict;
  - the **verdict** turns every link and the hall green (trade) or red (pass),
    the banner says why, and every robot jumps. When the order goes out, a gold
    link runs from the proposer to the price.
  The speaker's name glows and its ring pulses, so you always know who is
  talking. While the swarm is stopped the robots power down.
- **Explore**: click a place or a minion and the camera flies there; its reading
  appears beside it as a hologram, with a line to what it describes. Hover
  anything for a peek. Drag to look round, scroll to zoom, **W A S D** or the
  arrows to glide over the island, **Q / E** to turn; click the sea or press
  **Esc** to fly home.
- **The money** is a slim strip at the bottom centre: the swarm (wake / stop),
  the account, today, the open position and the floor.
- **▦ Panels** on the top bar switches to the classic panels (footprint,
  heatmap, DOM, bots, the Crypto Swarm panel); **◈ Island** brings it back.

One canvas draws everything, at 30 frames a second, and nothing while the tab
is hidden. Without 3D graphics (WebGL) the island says so; the panels still work.
