# Criptis

Crypto price watcher that runs entirely on GitHub Actions — no server, no local cron. It emails AI-written alerts when the market moves and publishes a live, descriptive dashboard.

Every hour a workflow runs `watcher.js`, which gathers professional-grade market data — 48h of true hourly OHLCV candles per coin from the Coinbase public API, plus a few recent news headlines (CryptoPanic) — derives the latest price, folds it into a set of descriptive indicators, and compares it against the committed `state.json`. It publishes `public/data.json` for the dashboard on **every** run, and **only when a deterministic trigger fires** does it consider an alert: a trigger that clears a Bollinger-band + volume **breakout pre-filter** earns a structured, beginner-friendly **Georgian** analysis from the Anthropic API; one that doesn't gets a raw-numbers alert with no LLM call. Either way you're emailed via Resend. The LLM is never the polling loop — it only writes the analysis after a trigger clears the pre-filter.

## How it works

```
GitHub Actions (cron hourly)
  └─ watcher.js
       ├─ gather market data (before any trigger is evaluated):
       │    • OHLCV — 48h of hourly candles per coin (Coinbase, free, no key; retry once)
       │    • news  — top 3 headlines (CryptoPanic, optional key; [] if missing/fails)
       ├─ derive spot price = latest close (missing ≠ 0); no coin priced → exit 1
       ├─ load state.json, keep last 48 price points per coin (~48h)
       ├─ enrich each coin → descriptive readout (trend/R², RSI, %B, momentum, volume)
       ├─ publish public/data.json for the dashboard (every run, even with no alert)
       ├─ trigger if:
       │    • change since last check  > 1.5%  (changeThresholdPct)
       │    • drift vs ~24h ago        > 4%   (driftThresholdPct, slow-bleed)
       │    • N checks in a row one way  = 5   (streakLength, steady trend)
       ├─ on trigger → breakout pre-filter (price outside Bollinger band on rising volume):
       │    • PASS → Anthropic claude-sonnet-4-6 returns a STRUCTURED, Georgian analysis
       │      (pattern · bias · invalidation level · 3-bullet beginner summary)
       │    • FAIL → raw-numbers "structural alert", no LLM call
       │    (30s timeout — a failed call never blocks the email)
       ├─ one combined email via Resend for all triggered coins
       │    (HTML card per coin + QuickChart sparkline; plain-text fallback;
       │     sent to all recipients, retried to email.to[0] alone on failure)
       └─ always write state.json + public/data.json → workflow commits them [skip ci]
```

## Dashboard

Every run writes `public/data.json` — a stateless snapshot of each coin's spot price, descriptive readout and 48h of hourly candles (rewritten in full each time, unlike the rolling `state.json`). [`index.html`](index.html) is a dependency-free dashboard (vanilla JS, no build step) that reads that feed and renders a card per coin: price, a price sparkline, a plain-language trend verdict, and indicator chips (RSI gauge, %B band position, momentum, volume) with Georgian glossary tooltips. It's an installable PWA (`manifest.json` + `sw.js`).

The UI is purely **descriptive — never advisory**, in Georgian for a complete beginner. Host the repo root as a static site (GitHub Pages, Netlify, or any static host); the page fetches `./public/data.json`, which CI refreshes hourly.

## Setup

### 1. Resend (email notifications)

1. Create a free account at [resend.com](https://resend.com).
2. **API Keys → Create API Key** — copy the `re_...` key.
3. Sender address: the default `onboarding@resend.dev` works out of the box, but Resend only delivers it to **your own account email**. To send to any address, verify a domain under **Domains** and change `email.from` in `config.json` to something like `Criptis <alerts@yourdomain.com>`.
4. Put the recipient(s) in `config.json` → `email.to` (a string or an array). **Order matters:** the watcher sends one email to all recipients at once, and if that send fails it automatically retries to `email.to[0]` **alone** — so list the Resend **account-owner** address first. (That retry is the safety net for the `onboarding@resend.dev` sender, which rejects the whole send if any recipient isn't the account owner.)

### 2. Anthropic

Get an API key from [console.anthropic.com](https://console.anthropic.com). Alerts still work without it (raw numbers, no analysis paragraph), but you want the paragraph.

### 3. CryptoPanic (optional — news headlines)

Get a free auth token at [cryptopanic.com/developers/api](https://cryptopanic.com/developers/api/). It adds recent crypto news headlines to the analysis context. Entirely optional: without the key (or on any failure) the watcher just runs with no news — prices, triggers and email are unaffected. Prices come from Coinbase and never need a key.

### 4. Repo secrets

In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `RESEND_API_KEY` | your `re_...` key |
| `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
| `CRYPTOPANIC_API_KEY` | your CryptoPanic auth token (optional) |

Never put keys in `config.json` — it's committed.

### 5. Enable the workflow

Push the repo, then check **Actions** tab → enable workflows if prompted. Test immediately with **Criptis watch → Run workflow** (manual dispatch). The first run only seeds history — alerts need at least two data points.

Note: GitHub disables scheduled workflows after 60 days without repo activity; the state commits each run keep it alive as long as prices move.

## Configuration (`config.json`)

```json
{
  "coins": ["bitcoin"],
  "changeThresholdPct": 1.5,
  "driftThresholdPct": 4,
  "streakLength": 5,
  "email": {
    "to": ["you@example.com", "someone-else@example.com"],
    "from": "Criptis <onboarding@resend.dev>"
  }
}
```

- **coins** — coin ids (`bitcoin`, `ethereum`, `solana`, …). Each maps to a Coinbase USD pair via `COINBASE_PRODUCTS` in `datasource.js`; adding a coin not in that map logs a warning and skips it, so add the mapping (e.g. `litecoin: "LTC-USD"`) when you add a coin.
- **changeThresholdPct** — alert when the move since the last check (~2h) exceeds this. Lower = noisier.
- **driftThresholdPct** — alert when the price has drifted this far from ~24h ago, even if each 2h step was small. Catches slow bleeds.
- **streakLength** — alert when this many checks in a row (~2h each) move the same direction, even if no single step or the 24h drift crossed a threshold. Catches a steady grind. Fires once when the streak forms, then stays quiet until it breaks. Default 5 (~10h); set higher to require a longer trend.
- **email.to** — recipient(s); a string or an array. List the Resend **account-owner** address **first** — on a send failure the watcher falls back to `email.to[0]` only (see Setup §1).
- **email.from** — sender; must be `onboarding@resend.dev` or an address on a domain you've verified in Resend.

## Local testing

```bash
# real prices, print the email instead of sending, don't touch state.json
node watcher.js --dry-run

# force the trigger path without a real market move:
node watcher.js                          # seed state with the real price
node watcher.js --dry-run --mock-price 1 # huge "drop" → trigger fires, email printed
git checkout state.json                  # discard the locally seeded state
```

`--dry-run` skips both the Resend send and the `state.json` write. The Anthropic call still happens if `ANTHROPIC_API_KEY` is set in your environment, so a real-price `--dry-run` during an actual breakout previews the AI analysis. It also writes the rendered HTML email to `email-preview.html` (gitignored) — open it in a browser to see the card and chart exactly as they'll send.

Note: `--mock-price` synthesizes a flat candle series, so it **fails the breakout pre-filter** — that path exercises the trigger + email plumbing and prints the raw-numbers "structural alert", not the AI paragraph (which needs real candles).

## Files

| File | Purpose |
|---|---|
| `watcher.js` | orchestrator — gather → derive → enrich → publish → trigger → pre-filter → email |
| `datasource.js` | Coinbase OHLCV fetch (48h of hourly candles per coin; retries once) |
| `news.js` | CryptoPanic headline fetch (optional; never rejects, returns `[]` on failure) |
| `indicators.js` | descriptive readout (RSI, %B, momentum, R², volume) + Bollinger/volume breakout pre-filter |
| `config.json` | coins, thresholds, email addresses — no secrets |
| `state.json` | rolling price history, committed back by CI |
| `public/data.json` | dashboard feed — per-coin price, readout & 48h candles; rewritten in full every run |
| `index.html` | static dashboard (vanilla JS, no build) that reads `public/data.json` |
| `manifest.json`, `sw.js` | PWA manifest + service worker |
| `prompts/analysis.md` | system prompt for the analysis — edit freely, it's versioned separately from code |
| `.github/workflows/watch.yml` | hourly schedule; commits `state.json` & `public/data.json` |
