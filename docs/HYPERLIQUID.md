# Hyperliquid: trading the order-flow terminal

The order-flow terminal (▥ **Order flow** on the meme terminal's bar) reads the
whole market: trades from Binance, Bybit, OKX, Coinbase and Hyperliquid in one
footprint, heatmap, DOM and volume profile. That needs no key. To *trade* it,
the bots and the order ticket use Hyperliquid: crypto futures (perpetuals) on
BTC, ETH, SOL and most altcoins, long or short, with no account form and no
documents.

## How it works

- **Your account is a wallet** (Binance Wallet, Phantom, MetaMask…), and its
  money is **USDC**. Hyperliquid runs on its own blockchain; nobody holds an
  account for you.
- **The terminal trades through an API wallet**: a separate key you create on
  Hyperliquid and approve once from your wallet. It can place and cancel
  orders; it can **never withdraw**. The terminal refuses your main wallet's own
  key.
- **No IP whitelist**, no key permissions to tick: the problems the Binance key
  had do not exist here.
- Costs at the base tier: about 0.045 % per market order, 0.015 % per resting
  limit order. Smallest order: **$10**. Leverage is capped per coin
  (about 40× on BTC down to 3–10× on small coins); the terminal always uses
  **isolated** margin, so a position can only lose its own margin.

## Funding it

1. Get **USDC on the Arbitrum network** into **your own wallet**. From Binance:
   buy USDC, then withdraw it on **Arbitrum One** to your Binance Wallet
   address (or move it to Binance Wallet in the app). From Phantom: swap to USDC
   on Arbitrum. Keep a little ETH on Arbitrum for the network fee.
2. On **app.hyperliquid.xyz**, connect that wallet and press **Deposit**.
   **At least 5 USDC** must arrive, or it is not credited.
3. **Never** withdraw from an exchange straight to Hyperliquid's deposit
   address: Hyperliquid credits whoever *sent* it — the exchange's wallet, not
   you — and the money is lost.

## Connecting the terminal

1. app.hyperliquid.xyz → **More → API** → name it (Novus Ordo) → **Generate** →
   **Authorize API Wallet** (your wallet asks you to sign). Copy the private key
   it shows: it is shown once. An account needs a deposit before it can
   authorize API wallets.
2. Novus Ordo → 🔌 **Connect → Hyperliquid**: **Main wallet address** = the
   address you deposited with (0x…); **API wallet private key** = the key you
   copied. Save.
3. **Test live**: it confirms the API wallet is approved for your account (and
   warns when it expires). Tick **Allow trading** when you want orders placed.

To practise with no money at risk: make the API wallet on
**app.hyperliquid-testnet.xyz** (its faucet gives test USDC), tick
**testnet / sandbox** on the key, and run the bots live against the testnet.

## Running the bots on it

**Bots** on the order-flow terminal's top bar → new bot:

- **Paper**: exchange `hyperliquid`, symbol `BTC/USDC:USDC` (or the **chart** button next to
  it). It trades Hyperliquid's real prices on paper.
- **Live**: choose the Hyperliquid key; the bot sizes from the USDC on the
  account, stays under the coin's leverage cap, sets isolated margin, and keeps
  to the ticket's order cap and rate limit. Market entries are sent with a worst
  price 2 % away (closes and stops 5 %, so they always fill).
- For a small account (~R500 ≈ $27) use the **Growth** or **Adaptive** preset,
  low leverage (2–3×), and one coin: with a $10 minimum there is room for one
  or two positions at a time.
- Each entry, the moment a trade is safe, each exit with its result, and any
  failure go to Telegram (Telegram panel → **Order-flow bot trades on
  Telegram**) and pop up here.

Futures can be liquidated. Paper-trade first, then the testnet, then small.
