// indicators.js — pure, dependency-free technical-analysis helpers (ESM, Node >=20).
//
// IMPORTANT: everything here is DESCRIPTIVE. It characterises the recent past.
// Nothing forecasts a future price. Treat the output as context for a human to
// read, never as a buy/sell signal. The numbers describe "what shape is this
// move in" — not "what happens next".
//
// Assumes a fairly dense, uniformly-spaced close series (e.g. ~24 hourly points).
// All functions return null when there isn't enough data, so callers can degrade
// gracefully instead of crashing. Longer windows sharpen as history grows.

const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : NaN);
export const last = (a) => (Array.isArray(a) && a.length ? a[a.length - 1] : undefined);

// Simple moving average of the last `period` values.
export function sma(values, period) {
  if (!Array.isArray(values) || period < 1 || values.length < period) return null;
  return mean(values.slice(-period));
}

// Exponential moving average (latest value). Seeded with the SMA of the first
// `period` points, then smoothed with k = 2/(period+1).
export function ema(values, period) {
  if (!Array.isArray(values) || period < 1 || values.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(values.slice(0, period));
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

// Wilder's RSI (latest value), 0..100. >70 is commonly called "overbought",
// <30 "oversold". On crypto these are weak hints, not rules.
export function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period, avgLoss = loss / period;
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Bollinger bands (latest). pctB: 0 at the lower band, 1 at the upper band;
// outside [0,1] means price has pushed beyond the band (a "stretched" move).
export function bollinger(values, period = 20, k = 2) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const mid = mean(slice);
  const sd = Math.sqrt(mean(slice.map((x) => (x - mid) ** 2)));
  const upper = mid + k * sd, lower = mid - k * sd;
  const price = last(values);
  const pctB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  return { mid, upper, lower, sd, pctB, bandwidth: mid ? (upper - lower) / mid : 0 };
}

// Least-squares linear regression over the last `period` points (x = 0..n-1).
// slopePctPerStep: slope as a % of the average level (scale-free, comparable
// across coins). r2: 0..1, how tidily the points sit on the line (trend "cleanness").
export function linreg(values, period) {
  const slice = Array.isArray(values) ? values.slice(-period) : [];
  const n = slice.length;
  if (n < 2) return null;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += slice[i]; sxy += i * slice[i]; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;
  let ssTot = 0, ssRes = 0;
  for (let i = 0; i < n; i++) {
    ssTot += (slice[i] - yMean) ** 2;
    ssRes += (slice[i] - (slope * i + intercept)) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return { slope, intercept, r2, slopePctPerStep: yMean ? (slope / yMean) * 100 : 0 };
}

// Volume confirmation (optional): is recent volume above its own baseline?
// A move backed by rising volume is conventionally "stronger" than one on
// fading volume — again, context, not proof.
export function volumeTrend(volumes, recent = 3, base = 12) {
  const v = Array.isArray(volumes) ? volumes.filter((x) => Number.isFinite(x)) : [];
  if (v.length < base) return null;
  const r = mean(v.slice(-recent));
  const b = mean(v.slice(-base));
  return { recent: r, base: b, ratio: b ? r / b : 1, rising: r > b };
}

// ---------------------------------------------------------------------------
// readout(series, opts) — fold the indicators into a DESCRIPTIVE summary.
//   series = { closes: number[], volumes?: number[] }
// Returns structured facts plus a one-sentence factual summary. Deliberately
// makes no prediction; leave any "what might happen / what to watch" softening
// to the LLM paragraph, which is constrained to describe-don't-advise.
// ---------------------------------------------------------------------------
export function readout(series, opts = {}) {
  const closes = (series && series.closes) || [];
  const volumes = (series && series.volumes) || null;
  const { shortP = 6, longP = 18, rsiP = 14, bbP = 20, regP = 12 } = opts;

  const price = last(closes);
  const eS = ema(closes, shortP);
  const eL = ema(closes, longP);
  const r = rsi(closes, rsiP);
  const bb = bollinger(closes, bbP);
  const lr = linreg(closes, regP);
  const vol = volumes ? volumeTrend(volumes) : null;
  const slopePct = lr ? lr.slopePctPerStep : null;

  // Cleanliness: how tidy the trend is (R²).
  let cleanliness = "unknown";
  if (lr) cleanliness = lr.r2 > 0.7 ? "clean" : lr.r2 > 0.3 ? "moderate" : "choppy";

  // Direction: short MA vs long MA, agreeing with the slope sign — but only
  // call a trend when the line actually fits (R² > 0.3). Noise stays "flat".
  let direction = "flat";
  if (eS != null && eL != null && slopePct != null && lr && lr.r2 > 0.3) {
    if (eS > eL && slopePct > 0) direction = "up";
    else if (eS < eL && slopePct < 0) direction = "down";
  }

  // Stretch: is the move overextended? (RSI extremes or price beyond a band.)
  let stretch = "mid-range";
  if (r != null && r >= 70) stretch = "overextended-up";
  else if (r != null && r <= 30) stretch = "overextended-down";
  else if (bb && bb.pctB > 1) stretch = "overextended-up";
  else if (bb && bb.pctB < 0) stretch = "overextended-down";

  // Factual one-liner — numbers only, no forecast.
  const bits = [];
  bits.push(direction === "flat" ? "No clear trend" : `${direction === "up" ? "Up" : "Down"}trend`);
  if (lr) bits.push(`${cleanliness} (R²=${lr.r2.toFixed(2)})`);
  if (r != null) bits.push(`RSI ${r.toFixed(0)}`);
  if (bb) {
    bits.push(bb.pctB > 1 ? "price above upper band"
      : bb.pctB < 0 ? "price below lower band"
      : `${Math.round(bb.pctB * 100)}% across the band`);
  }
  if (vol) bits.push(vol.rising ? "volume rising" : "volume easing");

  return {
    price,
    direction,
    cleanliness,
    stretch,
    momentumPctPerStep: slopePct,
    rsi: r,
    pctB: bb ? bb.pctB : null,
    emaShort: eS,
    emaLong: eL,
    r2: lr ? lr.r2 : null,
    volume: vol,
    summary: bits.join(", ") + ".",
  };
}
