# The commercial edition (selling Novus Ordo)

The copy that is sold is a separate build of the same app. It is built with:

```bash
npm run dist:commercial          # Windows, macOS and Linux
npm run dist:commercial:win      # one platform at a time: :win, :mac, :linux
```

The installers land in `release/commercial/` with `INSTALL.txt`, the buyer's
install guide.

## What makes it the commercial edition

The edition is fixed when the app is built (`NOVUS_EDITION=commercial`, set by
`scripts/dist-commercial.mjs`); it cannot be switched at run time.

| | Personal edition (the owner's copy) | Commercial edition (sold) |
|---|---|---|
| Ledger key | built-in key until the owner sets one | **none built in** — each buyer creates their own on first launch |
| Licence | none | Gumroad licence key, when a product id is configured (below) |
| Terms | none | the licence agreement and risk disclosure (`src/shared/terms.ts`) must be accepted; also shown by the Windows installer |
| Data folder | `Novus Ordo` | `Novus Ordo Terminal` — a copy installed beside the owner's never sees the owner's keys |
| Source maps | yes | none |
| Crypto swarm paper account | $30 | $1,000 |
| Credits | Quincy Gininda | Quincy Gininda (unchanged: lock screen, top bar, window title, exe details, installer, terms) |

Nothing personal is ever in an installer: exchange keys, Telegram, wallets,
settings and history live in each user's own data folder. The build script
checks the built code for the personal edition's key digest and for source maps,
and refuses to package if it finds either. `node e2e/commercial.mjs` runs the
built Linux app as a buyer would.

## Turning on licence keys (Gumroad)

1. In Gumroad, create the product and, under its content/settings, tick
   **"Generate a unique license key per sale"**.
2. Copy the product's **product ID** (shown with the licence-key option, or in
   the product's edit URL).
3. Build with it:

   ```bash
   NOVUS_GUMROAD_PRODUCT=<product id> npm run dist:commercial
   # optional: NOVUS_SEATS=3   computers per licence (default 3)
   ```

A buyer then enters their key on first launch. The app asks Gumroad's licence
API (`POST https://api.gumroad.com/v2/licenses/verify`, product id + key — no
secret needed). The first check on a computer counts one activation; a fourth
computer is refused. Every 3 days the key is checked again without counting; a
refund, chargeback, dispute or ended subscription stops it; a copy that cannot
reach Gumroad keeps working for 30 days. **Settings → Licence → Deactivate this
computer** gives a seat back. (Built without a product id, the commercial
edition has no licence check — anyone with the installer can use it.)

## Before selling: what only you can do

- **Have the terms read by a lawyer.** `src/shared/terms.ts` is a sound
  starting point (licence, no advice, trading risk, keys, no warranty, liability
  cap, South African law) but is not legal advice for your situation.
- **Code signing.** The installers are not signed. Windows shows a SmartScreen
  warning ("More info → Run anyway") and macOS asks buyers to run two Terminal
  commands (in `INSTALL.txt`). To remove both: a Windows code-signing
  certificate, and an Apple Developer account ($99 a year) to sign and notarise
  the macOS apps — done on a Mac, or set up in the build when you have them.
- **Exchange and data terms.** Some data and exchange APIs restrict commercial
  redistribution; the app connects each buyer to the exchanges with their own
  keys and public data, which is the usual arrangement — check the terms of any
  provider you advertise.
