# `backtest/` — the calibration harness (the honesty layer)

The forecast can only say *"~65% chance"* if ~65% of past calls at that confidence
**actually worked**. This harness measures that. It replays history bar-by-bar, runs
the real `signals.js` directional call using **only past data**, labels what price
actually did next, and learns the empirical probability behind each confidence
level. Forecast mode then reads `calibration.json` instead of inventing a number.

## The non-negotiable: NO LOOK-AHEAD

A backtest that peeks at the future is worse than none — it manufactures confidence
that doesn't exist. So:

- The prediction at bar `i` is handed **only** `series[start..i]` (a fresh slice).
- The outcome is measured **only** on bars **after** `i`.
- ATR for the barriers is computed from data up to `i`.
- Pivots/patterns already exclude their last `pivotWidth` bars; replaying on a strict
  prefix preserves that — the same confirmation lag the live path uses.

This is enforced in `replay.js` and asserted in `replay.test.js` ("predictFn never
sees a bar later than i").

## How a call is scored — triple-barrier

For a directional call at bar `i`, set a **target** at `+kAtr·ATR` and a **stop** at
`−kAtr·ATR` (in the predicted direction), then scan the next `horizon` bars:

- target touched first → **hit**
- stop touched first → **miss**
- neither within the horizon → **flat** (timeout), scored by the signed return
- one bar straddles both → counted as the **stop** (conservative)

The headline metric is **decisive hit-rate** = `hits / (hits + misses)` — the honest
`P(target before stop | a call at this confidence)`.

## Pipeline

```
history.js   fetchHistory(coin, {granularity, totalCandles})  — paginated Coinbase (300/call), cached
   │
   ▼
replay.js    replay(series, predictFn, {horizon, kAtr, sliceWindow, warmup})  — PURE, no look-ahead
   │           predictFn = signalsPredictor(evaluateSignal)  → { dir, confidence, meta }
   ▼
calibrate.js calibrate(records)  — bin by confidence → empirical decisive hit-rate; by regime; by verdict
   │           evaluateOnTest(testRecords, trainCalibration)  — out-of-sample honesty check
   ▼
run.mjs      CLI → backtest/calibration.json  (committed; forecast mode reads it)
```

## Running

```bash
# first time (or to refresh): download history, then calibrate
node backtest/run.mjs --fetch

# reuse cached history under backtest/cache/ (gitignored)
node backtest/run.mjs

# options (defaults shown)
node backtest/run.mjs --coins=bitcoin,ethereum --granularity=3600 --candles=8760 \
                      --horizon=24 --katr=1.5 --window=300 --split=0.7
```

- `--granularity=3600` (1h) matches the hourly forecast; `--horizon=24` scores the
  next ~6–24h. `--split=0.7` calibrates on the first 70% and checks the held-out 30%.
- Output `calibration.json` carries `train` (the calibration map) and `test` (the
  out-of-sample `mean |promised − actual|` — small means it generalises).

## Honest limitations (read before trusting a number)

- **TA has weak predictive power.** Expect decisive hit-rates near 50% on majors;
  treat anything far above with suspicion (likely a leak or overfit, not alpha).
- Triple-barrier ignores fees/slippage and assumes both barriers are reachable.
- Calibration is only as representative as the history window — a single regime
  (e.g. a long bull) will not generalise to the opposite.
- This calibrates the **probability**, not the **weights**. Tuning `REGIME_WEIGHTS`
  to the per-regime / per-verdict hit-rates is a separate, manual step.

## Tests

`replay.test.js` (no-look-ahead, triple-barrier labeling, determinism) and
`calibrate.test.js` (binning, fallback, out-of-sample eval). Run `node --test`.
