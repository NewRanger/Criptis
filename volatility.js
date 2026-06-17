// volatility.js — the "storm forecaster" (the honest, predictable layer).
//
// WHY THIS EXISTS: the backtest proved price DIRECTION is a random walk (~50%,
// unforecastable) but VOLATILITY clusters and IS forecastable (~60%). So Criptis
// forecasts the STORM — "big swings likely in the next ~12–24h" — not the direction.
// Like a weather app: it can't call the exact move, but it can warn turbulence is
// coming so you prepare (set a stop, trim size). Direction is surfaced only as a
// LEVEL MAP — the lines whose break reveals direction when the move actually fires.
//
// Invariants (same discipline as patterns/ + signals.js):
//   - Pure: (series, opts) -> object. No clock, randomness, I/O. Deterministic.
//   - Fails closed: thin/None data -> a "calm", low-confidence read, never throws.
//   - Scale-invariant: works in log-returns, so ×k prices give the same forecast.
//   - Probabilities are CONSERVATIVE and grounded in backtest/volforecast.mjs
//     (~58–62% realized), never inflated. Round with round3.

import { findPivots } from "./patterns/pivots.js";

const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const std = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const logReturns = (c) => { const r = []; for (let i = 1; i < c.length; i++) if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1])); return r; };

export const DEFAULTS = Object.freeze({
  volWindow: 24,     // bars used to estimate "current" realized volatility
  medianWindow: 240, // trailing window defining the coin's "normal" volatility
  horizon: 24,       // forecast look-ahead (bars) — ~next 24h on hourly candles
  minBars: 80,       // fails closed below this
  squeezeRatio: 0.7, // currentVol <= this × normal => a squeeze (expansion likely)
  elevatedRatio: 1.1,
  highRatio: 1.5,
  stormProb: 0.6,    // probability at/above which we raise a storm warning
});

function calm(reason, horizon) {
  return {
    storm: false, probability: 0.5, level: "unknown", ratio: null,
    currentVolPct: null, normalVolPct: null, expectedMovePct: null,
    squeeze: false, horizonHours: horizon, reason,
  };
}

// forecastVolatility(series, opts) -> a storm forecast for the next `horizon` bars.
// `probability` is P(the next horizon is more turbulent than this coin's normal),
// deliberately bounded to the ~0.25–0.72 range the backtest actually supports.
export function forecastVolatility(series, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const closes = series?.closes ?? [];
  if (closes.length < o.minBars) return calm("insufficient-data", o.horizon);

  const r = logReturns(closes);
  if (r.length < o.volWindow + 5) return calm("insufficient-data", o.horizon);

  const currentVol = std(r.slice(-o.volWindow));
  // rolling realized vols, then the trailing median = the coin's "normal" level
  const rolls = [];
  for (let i = o.volWindow; i <= r.length; i++) rolls.push(std(r.slice(i - o.volWindow, i)));
  const normalVol = median(rolls.slice(-o.medianWindow));
  if (!(currentVol >= 0) || !(normalVol > 0)) return calm("no-vol", o.horizon);

  const ratio = currentVol / normalVol;
  const squeeze = ratio <= o.squeezeRatio;

  // Probability model — grounded in the backtest, intentionally conservative:
  //  • elevated vol persists (ratio ≥ 1)         -> 0.55 rising toward ~0.70
  //  • a squeeze tends to resolve into expansion -> ~0.62
  //  • genuinely calm (ratio < 1, no squeeze)    -> below 0.5 (no storm)
  let probability;
  if (squeeze) probability = 0.62;
  else if (ratio >= 1) probability = clamp(0.55 + 0.12 * Math.tanh(ratio - 1), 0, 0.7);
  else probability = clamp(0.5 - 0.3 * (1 - ratio), 0.25, 0.5);

  const level = ratio >= o.highRatio ? "high" : ratio >= o.elevatedRatio ? "elevated" : squeeze ? "squeeze" : "calm";
  // expected ~1σ move over the horizon: σ_per_bar × √horizon (random-walk scaling)
  const expectedMovePct = currentVol * Math.sqrt(o.horizon) * 100;

  return {
    storm: probability >= o.stormProb,
    probability: round3(probability),
    level,
    ratio: round3(ratio),
    currentVolPct: round3(currentVol * 100),
    normalVolPct: round3(normalVol * 100),
    expectedMovePct: round3(expectedMovePct),
    squeeze,
    horizonHours: o.horizon,
    reason: probability >= o.stormProb ? (squeeze ? "squeeze-expansion" : "elevated-persistence") : "calm",
  };
}

// levelMap(series) -> the lines whose break reveals DIRECTION when the move fires.
// Direction itself is unforecastable, so we don't guess it — we hand the reader the
// nearest confirmed support/resistance from real pivots and say: a decisive break
// above resistance is the up-move, below support is the down-move. Fails closed to nulls.
export function levelMap(series, opts = {}) {
  const closes = series?.closes ?? [];
  const price = closes.at(-1);
  if (!Number.isFinite(price)) return { price: null, support: null, resistance: null };
  let piv;
  try { piv = findPivots(series, opts); } catch { piv = null; }
  const lows = (piv?.lows ?? []).map((p) => p.price).filter(Number.isFinite);
  const highs = (piv?.highs ?? []).map((p) => p.price).filter(Number.isFinite);
  const support = lows.filter((v) => v <= price).sort((a, b) => b - a)[0] ?? null;
  const resistance = highs.filter((v) => v >= price).sort((a, b) => a - b)[0] ?? null;
  return { price, support, resistance };
}

export default { forecastVolatility, levelMap, DEFAULTS };
