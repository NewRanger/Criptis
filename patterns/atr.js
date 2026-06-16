// patterns/atr.js — Average True Range (ATR): the volatility unit for the whole
// pattern layer (pure, dependency-free, ESM, Node >=20).
//
// WHY THIS EXISTS: every tolerance in the detectors (pivot prominence, trendline
// residual, breakout proximity) is expressed in ATR units, NOT raw dollars or a
// fixed %. A "0.5% wiggle" means something completely different for BTC vs DOGE;
// an ATR-relative tolerance is self-normalising, so one set of thresholds works
// across every coin. Returns null when there isn't enough data — the same
// fail-closed convention the existing indicators use.

// True Range per bar: max(high-low, |high-prevClose|, |low-prevClose|). The first
// bar has no previous close, so its TR is simply high-low. A bar with non-finite
// OHLC yields a null TR (kept in place, filtered by atr()) so one bad candle can't
// silently shift the average.
export function trueRanges(series = {}) {
  const h = Array.isArray(series.highs) ? series.highs : [];
  const l = Array.isArray(series.lows) ? series.lows : [];
  const c = Array.isArray(series.closes) ? series.closes : [];
  const n = Math.min(h.length, l.length, c.length);
  const tr = [];
  for (let i = 0; i < n; i++) {
    if (![h[i], l[i], c[i]].every(Number.isFinite)) { tr.push(null); continue; }
    if (i === 0) { tr.push(h[i] - l[i]); continue; }
    const prevC = c[i - 1];
    tr.push(
      Number.isFinite(prevC)
        ? Math.max(h[i] - l[i], Math.abs(h[i] - prevC), Math.abs(l[i] - prevC))
        : h[i] - l[i],
    );
  }
  return tr;
}

// Wilder's ATR (latest value). Seeds with the simple mean of the first `period`
// true ranges, then smooths with atr = (atr*(period-1) + TR)/period — the same
// Wilder smoothing the RSI in indicators.js uses. Returns null when fewer than
// `period` valid true ranges exist, so callers degrade gracefully.
export function atr(series, period = 14) {
  if (period < 1) return null;
  const tr = trueRanges(series).filter(Number.isFinite);
  if (tr.length < period) return null;
  let a = tr.slice(0, period).reduce((s, x) => s + x, 0) / period;
  for (let i = period; i < tr.length; i++) a = (a * (period - 1) + tr[i]) / period;
  return a;
}
