// patterns/confidence.js — the 5-factor confidence model for the pattern layer.
//
// Each sub-score is in [0,1] and deterministic. The composite is a weighted mean
// (weights renormalised over the factors actually present, so a missing factor —
// e.g. no volume data — redistributes its weight instead of dragging the score to
// zero).
//
// IMPORTANT: the v1 weights below are a documented PRIOR, not measured truth. The
// backtest's calibration step is meant to REPLACE them with weights fit to the
// empirical hit-rate (e.g. a logistic fit of forward success on these sub-scores),
// turning `confidence` into an actual probability. Read the priors as a sensible
// starting point, nothing more.
//
// Factors (per the design):
//   fit       — how tightly the touches sit on the line (RMS residual vs ATR;
//               NOT R², which degenerates on flat lines)
//   touch     — more trendline touches = stronger structure
//   symmetry  — geometric regularity of the shape (pattern-specific)
//   volume    — does volume behave the way the archetype expects
//   breakout  — proximity / decisiveness of the move toward its trigger

export const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export const DEFAULT_WEIGHTS = { fit: 0.25, touch: 0.2, symmetry: 0.2, volume: 0.2, breakout: 0.15 };

// More touches than the bare minimum (2) approaches full credit at `ideal` (4).
export function scoreTouch(touches, { min = 2, ideal = 4 } = {}) {
  if (!Number.isFinite(touches)) return 0;
  return clamp01((touches - min) / (ideal - min));
}

// Tightness of the fit: residual 0 -> 1, residual lambda*ATR -> 0. ATR-relative so
// it is scale-free across coins. Uses RMS residual, deliberately not R².
export function scoreFit(rmsResidual, atrValue, { lambda = 1.5 } = {}) {
  if (!Number.isFinite(rmsResidual) || !Number.isFinite(atrValue) || atrValue <= 0) return 0;
  return clamp01(1 - rmsResidual / (lambda * atrValue));
}

// Converging patterns (triangles/wedges): the closer the FUTURE apex, the more
// imminent the breakout. A past or reached apex (apexBar <= xN) scores 0 — the
// lines have already met, so the structure has resolved/degraded, it is NOT "about
// to break". `horizon` bars ahead or more -> 0.
export function scoreBreakoutConverging(apexBar, xN, { horizon = 48 } = {}) {
  if (!Number.isFinite(apexBar)) return 0;
  if (apexBar <= xN) return 0; // apex reached or in the past -> resolved, not imminent
  return clamp01(1 - (apexBar - xN) / horizon);
}

// Parallel patterns (channels): the nearer price sits to a boundary, the closer a
// breakout/bounce decision is. Mid-channel -> low; touching a line -> high.
export function scoreBreakoutParallel(close, resLevel, supLevel, atrValue, { boundaryAtr = 2 } = {}) {
  if (![close, resLevel, supLevel, atrValue].every(Number.isFinite) || atrValue <= 0) return 0;
  const dist = Math.min(Math.abs(close - resLevel), Math.abs(close - supLevel));
  return clamp01(1 - dist / (boundaryAtr * atrValue));
}

// Volume behaviour. `ratio` = recent / baseline volume (e.g. volumeTrend().ratio).
//   expect "contraction" (triangles/wedges): a falling ratio is healthy.
//   expect "steady" (channels): a ratio near 1 is healthy.
export function scoreVolume(ratio, expect = "steady") {
  if (!Number.isFinite(ratio)) return undefined; // absent -> drop from the mean
  if (expect === "contraction") return clamp01(1.5 - ratio); // 0.5x ->1, 1.0x ->.5, 1.5x ->0
  return clamp01(1 - Math.abs(ratio - 1)); // steady: closeness to 1.0
}

// Weighted mean over whichever factors are present (finite). Missing factors are
// skipped and the remaining weights renormalise.
export function composite(scores, weights = DEFAULT_WEIGHTS) {
  let sum = 0, wsum = 0;
  for (const k of Object.keys(weights)) {
    const s = scores[k];
    if (Number.isFinite(s)) { sum += weights[k] * s; wsum += weights[k]; }
  }
  return wsum > 0 ? clamp01(sum / wsum) : 0;
}
