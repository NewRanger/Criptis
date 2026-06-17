# Criptis

A crypto **trader assistant** that runs entirely on GitHub Actions — no server, no local cron. It watches the market, emails **advisory**, beginner-friendly **Georgian** alerts (recommendation + the levels that matter + a risk note), and publishes a live dashboard.

## The honest core — what it can and can't predict

Criptis was backtested rigorously before any advice was wired in (see [`backtest/`](backtest/)), and the data is blunt:

- **Price direction is a random walk.** Across 5 coins, hourly and daily, trend-following *and* mean-reversion all scored ~50% out-of-sample. **Nobody — and no model here — can reliably forecast up vs. down at these horizons.** Criptis does **not** pretend to.
- **Volatility is forecastable (~60%).** Big moves cluster, so "a storm is coming" *can* be called ahead of time. That's the genuinely useful, weather-app part.

So Criptis works like a weather forecast: it can't tell you the exact move, but it **warns you a storm (a big move) is likely**, hands you the **support/resistance levels** whose break reveals the direction *when it happens*, and tells you to manage risk. It **advises but never executes** — it places no orders; you decide and act. Every email carries a risk note (high-risk / your own decision / DYOR).

## The three jobs

| Job | Cadence | What it sends |
|---|---|---|
| **watch** (`watcher.js`) | hourly | Deterministic price/pattern triggers → an advisory email: a recognised chart pattern with a **recommendation**, support/resistance, invalidation, and (on a confirmed Bollinger breakout) an AI-written Georgian analysis with a recommended action. Publishes `public/data.json` for the dashboard every run. |
| **forecast** (`forecast.js`) | hourly | A **volatility "storm" warning** when a big move is likely in the next ~12–24h: probability, expected swing size, the level map (break of which reveals direction), and risk-management advice. |
| **trader** (`signals.js` → `trader.js`) | daily | A regime-aware **verdict** per coin (BUY/SELL/WATCH/… + confidence + entry/stop/target/R:R), emailed as advice for the actionable ones. NOTE: the backtest shows this layer's *directional* edge is ~50% — treat it as structured context, not a crystal ball. |

All three pull **OHLCV from the Coinbase public API** (free, no key, US-runner-safe), gather optional news headlines (CryptoPanic), and email via **Resend**.

## Dashboard

Every `watch` run rewrites `public/data.json` — a stateless snapshot of each coin's spot price, a descriptive readout, detected chart patterns (shadow mode), and 48h of hourly candles. [`index.html`](index.html) is a dependency-free PWA (vanilla JS, no build) that renders a card per coin with a sparkline and indicator chips, Georgian throughout. Host the repo root as a static site (GitHub Pages, Netlify, any static host).

## Setup

### 1. Resend (email)

1. Create a free account at [resend.com](https://resend.com) and make an API key (`re_...`).
2. Sender: the default `onboarding@resend.dev` only delivers to **your own account email**. To send to anyone, verify a domain and set `email.from` in `config.json` (e.g. `Criptis <alerts@yourdomain.com>`).
3. Recipients come from the **`ALERT_RECIPIENTS`** env var (comma-separated) so personal addresses stay out of the committed `config.json`. **Order matters:** all emails go to everyone at once, and a failed send retries to the **first** recipient alone — so list the Resend **account-owner** address first.

### 2. Anthropic (the `watch` analysis paragraph)

Get a key at [console.anthropic.com](https://console.anthropic.com). The `watch` email's AI analysis needs it; without it that email falls back to raw numbers. The `forecast` and `trader` jobs are deterministic and need no key.

### 3. CryptoPanic (optional — news)

Free token at [cryptopanic.com/developers/api](https://cryptopanic.com/developers/api/). Adds headlines to the analysis context; entirely optional.

### 4. Repo secrets

**Settings → Secrets and variables → Actions → New repository secret**

| Secret | Used by | Value |
|---|---|---|
| `RESEND_API_KEY` | all three | your `re_...` key |
| `ALERT_RECIPIENTS` | all three | comma-separated recipients (owner first) |
| `ANTHROPIC_API_KEY` | watch | your `sk-ant-...` key |
| `CRYPTOPANIC_API_KEY` | watch | CryptoPanic token (optional) |

Never put keys or personal addresses in `config.json` — it's committed.

### 5. Enable the workflows

See [Enabling the workflows](#enabling-the-workflows-in-github-actions) below.

## Configuration (`config.json`)

```json
{
  "coins": ["bitcoin", "ethereum", "solana", "ripple", "dogecoin"],
  "changeThresholdPct": null,
  "driftThresholdPct": null,
  "streakLength": null,
  "patternAlerts": { "enabled": true, "minConfidence": 0.75, "cooldownHours": 12 },
  "forecast": { "stormProb": 0.6, "cooldownHours": 12, "horizon": 24, "candles": 300 },
  "traderSignals": { "minConfidence": 0.5, "granularity": 86400, "candles": 300, "includeWatch": false },
  "email": { "to": [], "from": "Criptis <alerts@criptis.dev>" }
}
```

- **coins** — CoinGecko ids; each must be mapped to a Coinbase USD pair in `COINBASE_PRODUCTS` (`datasource.js`). An unmapped coin is skipped with a warning. (Use the `add-coin` skill.)
- **changeThresholdPct / driftThresholdPct / streakLength** — the three `watch` price triggers; a finite number arms one, `null` pauses it. **All three are currently paused**, so the `watch` email is raised only by the **patternAlerts** path. Restore numeric values (e.g. `1.5` / `4` / `5`) to re-enable. (Use the `manage-triggers` skill.)
- **patternAlerts** — `enabled` gates educational chart-pattern emails; `minConfidence` and `cooldownHours` tune them.
- **forecast** — storm warning: `stormProb` (probability at which to warn), `cooldownHours`, `horizon` (bars ahead, 24 = ~24h), `candles` fetched.
- **traderSignals** — daily verdict: `minConfidence` to email, `granularity` (86400 = daily), `candles`, `includeWatch`.
- **email.from / email.to** — sender, and an optional fallback recipient list used only when `ALERT_RECIPIENTS` is unset.

## Local testing

```bash
# hourly watch email — real prices, printed not sent, state untouched; writes email-preview.html
node watcher.js --dry-run

# hourly storm forecast — printed not sent; writes forecast-preview.html
node forecast.js --dry-run

# daily trader signals — printed not sent; writes trader-preview.html
node trader.js --dry-run

# full test suite (patterns, signals, volatility, watcher, backtest, …)
node --test

# calibration: download history + measure what's forecastable
node backtest/run.mjs --fetch          # writes backtest/calibration.json
node backtest/structure.mjs            # direction: momentum / mean-reversion / random walk?
node backtest/volforecast.mjs          # volatility: how accurate (~60%)?
```

`--dry-run` never sends and never writes state; for the `watch` job set `ANTHROPIC_API_KEY` first to preview the real AI paragraph. (See the `preview-alert` skill.)

## Enabling the workflows in GitHub Actions

1. **Push the repo**, then open the **Actions** tab. If GitHub shows "Workflows aren't running," click **"I understand my workflows, go ahead and enable them."** Scheduled workflows only start once their file is on the **default branch**.
2. **Allow the bot to commit state.** Settings → Actions → General → **Workflow permissions** → select **Read and write permissions**. The `watch` and `forecast` jobs commit `state.json` / `public/data.json` / `forecast-state.json` back, so without this their commit step fails.
3. **Confirm the secrets** from §4 are set.
4. **Test each immediately** (don't wait for the cron): Actions → pick a workflow (*Criptis watch*, *Criptis storm forecast*, *Criptis daily signals*) → **Run workflow** (manual dispatch).
5. The schedules: `watch` and `forecast` run hourly (offset at :13 and :37), `trader` daily at 00:20 UTC. GitHub disables scheduled workflows after 60 days without repo activity; the state commits keep them alive as long as prices move.

## Files

| File / dir | Purpose |
|---|---|
| `watcher.js` | hourly orchestrator — triggers → pattern alerts → AI analysis → advisory email + dashboard feed |
| `signals.js` | daily decision layer — `evaluateSignal()` → one verdict per coin |
| `trader.js` | daily runner — emails the actionable verdicts |
| `volatility.js` | the storm forecaster — `forecastVolatility()` + `levelMap()` |
| `forecast.js` | hourly runner — emails volatility storm warnings |
| `indicators.js` | descriptive readout + Bollinger/volume breakout pre-filter |
| `patterns/` | pure, deterministic chart-pattern detection (see `patterns/README.md`) |
| `backtest/` | calibration harness — proves what's forecastable (see `backtest/README.md`) |
| `datasource.js` | Coinbase OHLCV fetch (granularity-aware: 1h, 1d, …) |
| `news.js` | CryptoPanic headlines (optional) |
| `config.json` | coins, triggers, forecast/trader/pattern settings — no secrets |
| `state.json` / `forecast-state.json` | rolling history / storm cooldowns, committed by CI |
| `public/data.json`, `index.html` | dashboard feed + static PWA |
| `prompts/analysis.md` | system prompt for the AI analysis |
| `.github/workflows/` | `watch.yml` (hourly), `forecast.yml` (hourly), `trader.yml` (daily) |
```
