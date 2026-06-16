# Criptis

Crypto price watcher that runs entirely on GitHub Actions — no server, no local cron.

Every hour a workflow runs `watcher.js`, which gathers professional-grade market data — 48h of true hourly OHLCV candles per coin from the Coinbase public API, plus a few recent news headlines (CryptoPanic) — derives the latest price, compares it against the committed `state.json`, and **only when a deterministic trigger fires** calls the Anthropic API for a one-paragraph analysis and emails you via Resend. The LLM is never the polling loop — it only writes the analysis after a trigger.

## How it works

```
GitHub Actions (cron hourly)
  └─ watcher.js
       ├─ gather market data (before any trigger is evaluated):
       │    • OHLCV — 48h of hourly candles per coin (Coinbase, free, no key; retry once)
       │    • news  — top 3 headlines (CryptoPanic, optional key; [] if missing/fails)
       ├─ derive spot price = latest close (missing ≠ 0); no coin priced → exit 1
       ├─ load state.json, keep last 48 price points per coin (~48h)
       ├─ trigger if:
       │    • change since last check  > 1.5%  (changeThresholdPct)
       │    • drift vs ~24h ago        > 4%   (driftThresholdPct, slow-bleed)
       │    • N checks in a row one way  = 5   (streakLength, steady trend)
       ├─ on trigger: Anthropic claude-sonnet-4-6 writes one paragraph
       │    (30s timeout — a failed call never blocks the email)
       ├─ one combined email via Resend if multiple coins trigger
       │    (HTML card per coin + QuickChart sparkline; plain-text fallback)
       └─ always write state.json → workflow commits it back [skip ci]
```

## Setup

### 1. Resend (email notifications)

1. Create a free account at [resend.com](https://resend.com).
2. **API Keys → Create API Key** — copy the `re_...` key.
3. Sender address: the default `onboarding@resend.dev` works out of the box, but Resend only delivers it to **your own account email**. To send to any address, verify a domain under **Domains** and change `email.from` in `config.json` to something like `Criptis <alerts@yourdomain.com>`.
4. Put the recipient address in `config.json` → `email.to`.

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

## Local testing

```bash
# real prices, print the email instead of sending, don't touch state.json
node watcher.js --dry-run

# force the trigger path without a real market move:
node watcher.js                          # seed state with the real price
node watcher.js --dry-run --mock-price 1 # huge "drop" → trigger fires, email printed
git checkout state.json                  # discard the locally seeded state
```

`--dry-run` skips both the Resend send and the `state.json` write. The Anthropic call still happens if `ANTHROPIC_API_KEY` is set in your environment, so you can preview the analysis. It also writes the rendered HTML email to `email-preview.html` (gitignored) — open it in a browser to see the card and chart exactly as they'll send.

## Files

| File | Purpose |
|---|---|
| `watcher.js` | the whole watcher |
| `config.json` | coins, thresholds, email addresses — no secrets |
| `state.json` | rolling price history, committed back by CI |
| `prompts/analysis.md` | system prompt for the analysis — edit freely, it's versioned separately from code |
| `.github/workflows/watch.yml` | schedule + state commit |
