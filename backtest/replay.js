// backtest/replay.js — walk-forward replay with triple-barrier outcome labeling.
//
// THE WHOLE POINT: turn the forecast model into measured truth. At each historical
// bar i we run the prediction using ONLY data up to i (no look-ahead), then look at
// what price ACTUALLY did over the next `horizon` bars and label the call hit/miss.
// Feed the records to calibrate.js to learn the real probability behind a confidence.
//
// Pure + deterministic: (series, predictFn, opts) -> records[]. No clock, no I/O,
// no randomness. The single most important guarantee is NO LOOK-AHEAD — the
// prediction at bar i sees `series[start..i]`; the outcome uses only bars > i. The
// backtest is worthless the instant that leaks, so it is enforced here and tested.

import { atr } from "../patterns/atr.js";

const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

// Slice a candle series to [start, end) — a fresh sub-series with the same shape.
export function sliceSeries(series, start, end) {
  return {
    times: series.times.slice(start, end),
    opens: series.opens.slice(start, end),
    highs: series.highs.slice(start, end),
    lows: series.lows.slice(start, end),
    closes: series.closes.slice(start, end),
    volumes: series.volumes.slice(start, end),
  };
}

// Triple-barrier label for a directional call at bar i. Scans the FUTURE bars
// (i, i+horizon]: a target at +kAtr·ATR and a stop at -kAtr·ATR (in the predicted
// direction). Whichever is touched first decides it; neither within the horizon =>
// "flat" (timeout), scored by the signed directional return at the horizon close.
// If a single bar straddles both barriers we count the STOP (conservative).
export function labelOutcome(series, i, dir, atrAtI, { horizon = 24, kAtr = 1.5 } = {}) {
  if (dir === 0 || !(atrAtI > 0)) return { label: "flat", forwardReturn: 0, exitBar: i, bars: 0 };
  const entry = series.closes[i];
  const target = entry + dir * kAtr * atrAtI;
  const stop = entry - dir * kAtr * atrAtI;
  const end = Math.min(i + horizon, series.closes.length - 1);
  for (let j = i + 1; j <= end; j++) {
    const hi = series.highs[j], lo = series.lows[j];
    if (dir > 0) {
      if (lo <= stop) return { label: "miss", forwardReturn: round3((stop - entry) / entry), exitBar: j, bars: j - i };
      if (hi >= target) return { label: "hit", forwardReturn: round3((target - entry) / entry), exitBar: j, bars: j - i };
    } else {
      if (hi >= stop) return { label: "miss", forwardReturn: round3((entry - stop) / entry), exitBar: j, bars: j - i };
      if (lo <= target) return { label: "hit", forwardReturn: round3((entry - target) / entry), exitBar: j, bars: j - i };
    }
  }
  const fwd = ((series.closes[end] - entry) / entry) * dir; // signed favorable return
  return { label: "flat", forwardReturn: round3(fwd), exitBar: end, bars: end - i };
}

// Walk-forward replay. `predictFn(subSeries) -> { dir, confidence, meta? }` is called
// with ONLY the bars up to and including i. Records every directional call with its
// measured forward outcome. `sliceWindow` bounds each sub-series to the most recent
// N bars (cost control + matches the production rolling window); omit for expanding.
export function replay(series, predictFn, opts = {}) {
  const { horizon = 24, warmup = 60, kAtr = 1.5, atrPeriod = 14, step = 1, sliceWindow = 300 } = opts;
  const n = series?.closes?.length ?? 0;
  const records = [];
  // Need at least one future bar to score, so stop at n-1 (exclusive of the last bar).
  for (let i = warmup; i < n - 1; i += step) {
    const start = sliceWindow ? Math.max(0, i + 1 - sliceWindow) : 0;
    const sub = sliceSeries(series, start, i + 1); // bars [start..i] — never past i
    let pred;
    try {
      pred = predictFn(sub) || {};
    } catch {
      continue; // a prediction that throws is simply not scored
    }
    const dir = Math.sign(pred.dir ?? 0);
    if (dir === 0) continue; // no directional call at this bar — nothing to score
    const a = atr(sub, atrPeriod); // ATR from data up to i only (no look-ahead)
    const out = labelOutcome(series, i, dir, a, { horizon, kAtr });
    records.push({
      i,
      t: series.times[i],
      dir,
      confidence: Number.isFinite(pred.confidence) ? pred.confidence : null,
      meta: pred.meta ?? null,
      ...out,
    });
  }
  return records;
}

// Convenience predictor that drives the real model: the signals.js directional call.
// Injected into replay() for production runs; tests use their own stubs.
export function signalsPredictor(evaluateSignal) {
  return (sub) => {
    const v = evaluateSignal(sub, {});
    return {
      dir: Math.sign(v.netScore),
      confidence: v.confidence,
      meta: { verdict: v.verdict, regime: v.regime?.trend ?? "range" },
    };
  };
}
