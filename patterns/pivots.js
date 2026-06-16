// patterns/pivots.js — deterministic swing-point (pivot) detection.
//
// Pivots are the atoms of chart-pattern geometry: every pattern in this layer is
// defined by the location and height of swing highs and swing lows. This module
// turns a candle series into those swing points, deterministically. Pure, no I/O.

import { atr } from "./atr.js";

// findPivots(series, opts) -> { highs: Pivot[], lows: Pivot[], atr }
//   Pivot = { idx, t, price }
//
// A pivot high at bar i is a high that is the STRICT maximum of highs[i-w .. i+w];
// a pivot low is the strict minimum of lows over the same window. Strict (>) on
// both sides means a flat plateau yields NO pivot — safer than inventing a swing
// where price merely paused.
//
// Bars within `width` of either end are skipped: a swing cannot be CONFIRMED
// without `width` bars on each side. (This confirmation lag must be mirrored by
// the backtest replay so it never trades on a pivot it could not yet have seen —
// the single most common source of look-ahead bias in pattern backtests.)
//
// Prominence filter: a candidate must additionally clear `minProminenceAtr` * ATR
// above (high) / below (low) the opposite extreme inside its window, so micro-
// wiggles don't manufacture phantom patterns. With no ATR available (short
// history) the prominence filter is skipped and only the local-extremum test runs.
export function findPivots(series, opts = {}) {
  const { width = 3, minProminenceAtr = 0.5, atrPeriod = 14, atrValue } = opts;
  const highs = series?.highs ?? [];
  const lows = series?.lows ?? [];
  const times = series?.times ?? [];
  const n = Math.min(highs.length, lows.length);
  const w = Math.max(1, Math.floor(width));

  const a = Number.isFinite(atrValue) ? atrValue : atr(series, atrPeriod);
  const minProm = Number.isFinite(a) ? minProminenceAtr * a : null;

  const pivotHighs = [];
  const pivotLows = [];
  for (let i = w; i < n - w; i++) {
    let isHigh = Number.isFinite(highs[i]);
    let isLow = Number.isFinite(lows[i]);
    let winLowMin = Infinity;   // lowest low in the window (for high prominence)
    let winHighMax = -Infinity; // highest high in the window (for low prominence)
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (!(highs[i] > highs[j])) isHigh = false;
      if (!(lows[i] < lows[j])) isLow = false;
      if (lows[j] < winLowMin) winLowMin = lows[j];
      if (highs[j] > winHighMax) winHighMax = highs[j];
    }
    if (isHigh && (minProm === null || highs[i] - winLowMin >= minProm)) {
      pivotHighs.push({ idx: i, t: times[i], price: highs[i] });
    }
    if (isLow && (minProm === null || winHighMax - lows[i] >= minProm)) {
      pivotLows.push({ idx: i, t: times[i], price: lows[i] });
    }
  }
  return { highs: pivotHighs, lows: pivotLows, atr: Number.isFinite(a) ? a : null };
}
