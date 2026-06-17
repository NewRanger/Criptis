---
name: add-coin
description: Add a coin to Criptis so it's tracked, alerted, and shown on the dashboard. Use when asked to add/track/watch a new coin (e.g. "add cardano", "track AVAX", "watch litecoin"). Handles both edits — config.json AND the COINBASE_PRODUCTS mapping — so the coin isn't silently skipped.
---

# Add a coin

Adding a coin takes **two** edits that must stay in sync. Doing only the first is
the classic mistake: a coin listed in `config.json` with **no** Coinbase product
mapping throws in `datasource.js` and is **silently skipped** every run (logged as
a warning, never priced).

Coins are identified by their **CoinGecko id** (`bitcoin`, `ethereum`,
`cardano`, …) for continuity; `COINBASE_PRODUCTS` maps each id to its Coinbase USD
trading pair.

## Steps

1. **Check whether the mapping already exists.** Look at `COINBASE_PRODUCTS` in
   [datasource.js](../../../datasource.js). It already covers: `bitcoin`,
   `ethereum`, `solana`, `ripple`, `dogecoin`, `cardano`, `litecoin`,
   `chainlink`, `avalanche-2`, `polkadot`. If the coin is there, **skip step 3**.

2. **Add the id to `coins`** in [config.json](../../../config.json):
   ```json
   "coins": ["bitcoin", "ethereum", "solana", "ripple", "dogecoin", "cardano"]
   ```
   Use the CoinGecko id, lowercase. (Note `avalanche-2` is the real CoinGecko id
   for AVAX — verify the exact id if unsure.)

3. **Add the Coinbase pair** to `COINBASE_PRODUCTS` in
   [datasource.js](../../../datasource.js), keyed by the same id:
   ```js
   cardano: "ADA-USD",
   ```
   The value is the Coinbase Exchange USD product. Verify the pair exists before
   trusting it — Coinbase lists most majors as `<TICKER>-USD`, but confirm:
   ```powershell
   curl.exe -s "https://api.exchange.coinbase.com/products/ADA-USD/candles?granularity=3600" | Select-Object -First 1
   ```
   A JSON array of candle rows = good; a 404 / `NotFound` = wrong pair (try
   another quote or check Coinbase's product list).

4. **Verify end-to-end** with a dry run (real prices, no send, no state write):
   ```powershell
   node watcher.js --dry-run
   ```
   Confirm the new coin prints a price + readout line (e.g. `cardano: $0.45 …`)
   and does **not** appear in a `skipping:` / `no Coinbase product mapping`
   warning.

## Notes

- **No manual state seeding needed.** The first real run seeds the coin's price
  history; alerts need at least two data points, so the coin starts alerting from
  its second run. `public/data.json` (the dashboard feed) includes the coin from
  its first successful run.
- The **dashboard** ([index.html](../../../index.html)) renders whatever coins are
  in `public/data.json`, so the new coin appears automatically once CI runs.
- `config.json` is **committed** (no secrets) — this is a real config change that
  takes effect in CI on the next hourly run.
- **Do not commit or push.** The repo owner commits `config.json` and
  `datasource.js` themselves — summarise the two edits and let them review.
