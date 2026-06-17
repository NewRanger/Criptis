# Criptis — project memory

Crypto **trader-assistant**. Deterministic chart-pattern detection over Coinbase
daily/hourly candles, surfaced two ways: a **Georgian advisory email** (a coin-trader
assistant — recommendation + entry / stop / target + a risk note, via Resend) and a
**dashboard**. Runs on GitHub Actions hourly. A daily, regime-aware **trade-signal layer**
(`signals.js`) is wired into a daily advisory email.

## Stack & runtime

- **Node ESM, ≥ 20.** No build step, no bundler.
- Runs on **GitHub Actions, hourly** (price + pattern alerts). The daily trader job runs
  once just after the 00:00 UTC daily close — it is a *separate* job from the hourly watcher.
- **Data source: Coinbase Exchange** (free, no key, US-runner-safe where Binance may 451
  from hosted runners). Candle granularities are **1m / 5m / 15m / 1h / 6h / 1d only — there
  is no native 4h** (resample 1h→4h if ever needed).

## Layout

- `datasource.js` — Coinbase candle fetch; `fetchSeries`, `COINBASE_PRODUCTS`
  (CoinGecko id → Coinbase USD pair). NOTE: currently hardcoded to `granularity=3600` (1h);
  the daily trader job needs a `granularity` + candle-count option added here first.
- `patterns/` — **pure, deterministic, dependency-free** detection stack:
  `atr` → `pivots` (`findPivots`) → `trendlines` → `detectors/` → `confidence` →
  `index` (`detectPatterns`, the orchestrator). `patterns/README.md` is the spec;
  `patterns/fixtures/` holds the synthetic builders + committed JSON snapshots.
- `indicators.js` — Bollinger `breakoutPrefilter`, `volumeTrend`.
- `signals.js` — the daily **decision layer**; `evaluateSignal(series, opts)` → one verdict
  per coin (`STRONG_BUY/BUY/WATCH/NEUTRAL/SELL/STRONG_SELL` + confidence + risk geometry).
  Reuses the detectors; computes EMA/RSI/MACD/regime itself. Self-review only.
- `watcher.js` — the runtime: price triggers, `analyze()` (LLM analysis paragraph),
  Resend email, and the Georgian email copy (`PATTERN_COPY`, `ZONE_COPY`, `STRUCTURAL_NOTE`).
- `config.json` — **committed** config (no secrets): `coins`, the three price triggers
  (`changeThresholdPct`, `driftThresholdPct`, `streakLength`), and `patternAlerts`.
- `state.json` — price history (committed by the owner).
- `index.html` + `public/data.json` — the dashboard feed.
- `prompts/analysis.md` — the analysis prompt.
- `backtest/` — calibration harness (the honesty layer): `history.js` (paginated Coinbase
  fetch + cache), `replay.js` (PURE walk-forward, no look-ahead, triple-barrier labels),
  `calibrate.js` (confidence → empirical probability), `run.mjs` (CLI). Writes the committed
  `backtest/calibration.json` that forecast mode reads so a shown probability is measured,
  not guessed.

## Commands

- `node --test` — full suite. `index.js`, `watcher.js`, the dashboard and `signals.js` all
  consume the `patterns/` layer, so run the whole suite, not one file.
- `node watcher.js --dry-run` — render the alert with **no send and no state write**; writes
  `email-preview.html` (gitignored) + the per-coin pattern-alert evaluation. See the
  `preview-alert` skill for forcing a card when nothing triggers.
- `node patterns/fixtures/build-fixtures.mjs` — regenerate the committed fixture snapshots.
- `node backtest/run.mjs --fetch` — download history + recalibrate; writes `backtest/calibration.json`
  (omit `--fetch` to reuse cached history under `backtest/cache/`).

## Always-true rules

**Determinism (`patterns/` + `signals.js`)**
- Pure: input is `(series, opts)` only — no clock, no randomness, no I/O. Same input ⇒
  byte-identical output. Never `Date.now()` / `Math.random()` anywhere, *including fixtures*
  (use the fixed `T0` epoch + the seeded LCG in `synth.js`).
- **Fails closed:** detectors return `[]`, `signals.js` returns `NEUTRAL` — never throw.
- **ATR-relative** thresholds via `atr()` — never raw dollars or a fixed %. Round with `round3`.
- Fixed output schemas; biases are independent `[0,1]` scores (not `1 − p` complements).

**User-facing copy**
- The emails are an **advisory coin-trader assistant**: give a clear recommendation
  (action + entry / stop / target) grounded in the real numbers, in **Georgian**, with a
  short **risk note** (high-risk / your own decision / DYOR). Sent to all recipients.
- Use standard trading terminology (`მხარდაჭერა` / `წინააღმდეგობა`, not `ქვედა/ზედა ზონა`),
  modern literary Georgian, formal `თქვენ`, no calques/barbarisms — see the
  `translate-localize` skill for the full rules.
- Advise, but **never auto-execute** — the app places no orders; the human decides and acts.
- Every new pattern needs a `PATTERN_COPY` entry keyed by its exact `patternName`, or it
  silently falls back to generic `PATTERN_FALLBACK` (a UX regression).

**Trader signals**
- The daily `signals.js` verdict (action + entry / stop / target / R:R) is **rendered into
  the advisory email** to all recipients, with a risk note. Advise — but **never
  auto-execute** (no orders are placed; the human acts).
- Calibrate thresholds/weights against the `backtest/` harness on out-of-sample history,
  never against the chart currently on screen.

**Git**
- **NEVER commit or push.** The owner commits everything (`config.json`, `state.json`,
  `datasource.js`, code) themselves. Summarise what changed (from → to) and let them review.

## Skills (reach for these)

- `add-coin` — track a new coin (the two synced edits: `config.json` + `COINBASE_PRODUCTS`).
- `manage-triggers` — pause / restore / tune the three price triggers and pattern alerts.
- `add-pattern-detector` — add a deterministic chart pattern (detector + fixture + tests +
  Georgian copy).
- `trader-signal` — work on the daily decision engine (`signals.js`): verdicts, regime /
  confluence weights, risk math, wiring the daily job.
- `translate-localize` — translate/localize UI strings & copy (primary target Georgian),
  preserving variables/tags/structure.
- `preview-alert` — preview the alert email locally without sending or dirtying `state.json`.
