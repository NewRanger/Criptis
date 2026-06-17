---
name: trader-signal
description: Work on the daily trade-signal layer — the regime-aware decision engine (signals.js) that turns the deterministic patterns/ + indicators output into ONE verdict per coin (BUY/SELL/WATCH/… + confidence + risk geometry), rendered as advice in the daily trader email. Use when asked to add or extend the signal/trader layer, compute or tune buy/sell signals, adjust the confluence or regime weights, change the verdict thresholds or risk math, or wire the daily trader job. Reuses the existing detectors; never reimplements them and never auto-executes (advises, but places no orders).
---

# Work on the trade-signal layer

`signals.js` is the **decision layer**: a pure function `evaluateSignal(series, opts)`
that reads daily OHLCV candles and returns exactly one **verdict** per coin —
`STRONG_BUY / BUY / WATCH / NEUTRAL / SELL / STRONG_SELL`, plus a confidence, a
regime read, the agreeing factors, and a risk geometry (entry / stop / target / R:R).
The verdict is **rendered as advice in the daily trader email** (recommendation +
levels + a risk note) to all recipients. It **advises but never executes** — it
computes a signal and stops there; the app places no orders, the human decides and acts.

This layer sits **on top of** the `patterns/` stack — it does not detect anything
itself. Patterns are still computed deterministically by the detectors; classic
indicators (EMA / RSI / MACD / Bollinger) and the regime read live in `signals.js`,
which combines them into the verdict. Read
[patterns/README.md](../../../patterns/README.md) for the detection layer and the
top of [signals.js](../../../signals.js) for this layer's contract.

## Non-negotiable invariants (tests should enforce these)

- **Pure** — input is `(series, opts)` only. No clock, no randomness, no I/O.
  Same input ⇒ byte-identical verdict.
- **Fails closed** — too few bars, no ATR, or any throw from a reused primitive ⇒
  `NEUTRAL` with a machine `reason` (`insufficient-data` / `no-atr` / `low-confluence`
  / `poor-rr`). Never throws. Mirror `breakoutPrefilter()` and the detectors' `[]`.
- **ATR-relative** — every distance and threshold is expressed in **ATR units** via
  `atr()`, so BTC and SOL share one set of constants. No raw dollars, no fixed %.
- **Confluence gate** — *no single indicator is a signal.* A non-NEUTRAL verdict
  requires `>= minAgree` (default 3) independent factors agreeing in the net
  direction. One factor alone can only ever produce `WATCH`.
- **Regime-conditioned** — the same factor is weighted differently by regime
  (`REGIME_WEIGHTS`): trend-following up-weighted in bull/bear, mean-reversion
  up-weighted in range. This matrix is where the "trader skill" actually lives.
- **Risk-filtered** — a setup with reward:risk below `minRR` (default 1.5) is capped
  at `WATCH`, never promoted to a trade verdict.
- **Fixed output schema** — every result has exactly the fields built in
  `buildVerdict()`. Round with `round3`.
- **Advise, never execute** — the verdict is rendered as advice in the email (with a
  risk note); the app never places an order. The human acts on it.

## Reusable primitives — build on these, don't reinvent

- `detectPatterns(series, opts)` — the ranked detector output; the top active match
  drives the `pattern` factor and supplies `invalidationLevel` for the stop.
- `atr(series, period)` — the volatility unit and the basis for every threshold.
- `findPivots(series, opts)` → `{ highs, lows, atr }` — confirmed swing levels for
  the support/resistance factor and structural stops/targets.
- `volumeTrend(series.volumes)` from [indicators.js](../../../indicators.js) — a
  confidence nudge (volume confirms the move), not a directional vote. NOTE it
  returns an object `{ ratio, rising, … }` (or `null`), not a number — read `.rising`.

The EMA / RSI / MACD / Bollinger helpers are **internal** to `signals.js` (your
`indicators.js` exposes Bollinger + volume, not these). Keep them pure and
dependency-free if you extend them.

## Steps

1. **Tune the engine, not the call site.** Behaviour lives in `DEFAULTS`,
   `BASE_WEIGHTS`, and `REGIME_WEIGHTS` in [signals.js](../../../signals.js).
   Adjusting a threshold = edit `DEFAULTS`; re-weighting a factor by regime = edit
   `REGIME_WEIGHTS`. Adding a new factor = add a vote in `factorVotes()` and an
   entry in both weight maps.
2. **Wire the daily job** — a separate runner from the hourly `watcher.js` (these
   are different jobs: intraday price alerts vs. daily swing signals). It should
   `fetchSeries` daily candles (Coinbase granularity `86400`) for the signal coins,
   call `evaluateSignal(series, { coin })`, and route the result (next step). Run it
   once just after the 00:00 UTC daily close. NOTE: `datasource.js` currently fetches
   1h candles only — add a `granularity` (and candle-count) option before this works.
3. **Surfacing / dedup** — email on `verdict ∈ {BUY, STRONG_BUY, SELL, STRONG_SELL}`
   (and optionally `WATCH`); render the verdict as **advice in Georgian** — the
   recommended action + entry / stop / target / R:R + a short **risk note**
   (high-risk / your own decision / DYOR), to all recipients. Add cooldown/dedup so one
   persistent setup doesn't re-fire daily (a follow-up; v1 may email every actionable day).
4. **Calibrate against the backtest, never against the chart you're staring at.** The
   thresholds and `REGIME_WEIGHTS` are a documented prior, not measured truth. Use the
   `backtest/` harness (forward-outcome labelling on out-of-sample history, honouring
   the same pivot confirmation lag the live path uses) to set them. This is the same
   eval-loop discipline as the rest of the repo — overfitting thresholds to recent
   moves is the #1 failure mode.
5. **Write tests** — mirror the detector tests: a verdict for a known constructed
   setup (direction, full schema with finite numbers), the confluence gate (one
   factor ⇒ at most `WATCH`), the R:R cap (poor R:R ⇒ `WATCH`), fails-closed on too
   little data, and a determinism property (scale invariance: ×k prices ⇒ same
   verdict + confidence, scaled levels). Run `node --test`.

## Verify, then hand off

- `node --test` is green and a daily-candle dry run prints a sane verdict per coin.
- For the email card, use [/preview-alert](../preview-alert/SKILL.md).
- **Do not commit or push** — this repo's owner always commits themselves.
  Summarise what changed (which weights/thresholds, from → to) and let them review.
