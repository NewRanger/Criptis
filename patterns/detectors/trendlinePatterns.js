// patterns/detectors/trendlinePatterns.js — the trendline-geometry detector.
//
// Family A of the pattern layer: patterns defined by the slopes of the upper
// (resistance) and lower (support) envelopes plus whether they converge or run
// parallel. All eight Family-A patterns are classified from those three facts —
// (sign of resistance slope, sign of support slope, converging vs parallel):
//
//   Ascending Triangle   — flat resistance, rising support, converging   (bullish)
//   Descending Triangle  — falling resistance, flat support, converging  (bearish)
//   Symmetrical Triangle — falling resistance, rising support, converging (neutral)
//   Rising Wedge         — both rising, converging (support steeper)      (bearish)
//   Falling Wedge        — both falling, converging (resistance steeper)  (bullish)
//   Channel Up           — both rising, parallel                          (bullish)
//   Channel Down         — both falling, parallel                         (bearish)
//   Rectangle            — both flat, parallel                            (neutral)
//
// Any other geometry (broadening/megaphone, ambiguous, noisy) returns null — the
// detector refuses to label what it can't classify. The whole detector is pure and
// deterministic: same candles + opts -> identical output. Fails CLOSED (returns [])
// whenever the data can't support a confident geometric read, mirroring
// breakoutPrefilter() in indicators.js.

import { atr } from "../atr.js";
import { findPivots } from "../pivots.js";
import { fitLine, lineGeometry, lineValue } from "../trendlines.js";
import { volumeTrend } from "../../indicators.js";
import * as conf from "../confidence.js";

export const DEFAULTS = {
  atrPeriod: 14,
  pivotWidth: 3,
  minProminenceAtr: 0.5,
  minTouches: 2,        // each line needs at least this many pivots
  maxResidAtr: 0.8,     // a line is valid only if its RMS residual <= this * ATR
  flatSlopePct: 0.05,   // |slope %/bar| below this counts as "flat"
  convergeRatio: 0.4,   // band narrows by >= this fraction => "converging"
  parallelRatio: 0.2,   // |convergenceRatio| <= this (same-sign slopes) => "parallel"
  apexHorizon: 48,      // bars; scales breakout-proximity for converging patterns
  boundaryAtr: 2,       // channel: within this many ATR of a boundary => near breakout
  invalidationAtr: 0.5, // if the latest close is this many ATR past the invalidation
                        // line, the pattern is already broken => not reported
  weights: conf.DEFAULT_WEIGHTS,
};

// Innate directional lean + geometry kind per pattern. `bull`/`bear` are the
// archetype's lean magnitudes BEFORE scaling by confidence; `flatSide` marks which
// trendline (if any) is the flat one — used by the symmetry score for triangles.
// `bias` drives the active-pattern gate:
//   "bull"    — dies on a break BELOW support     (invalidation = support)
//   "bear"    — dies on a break ABOVE resistance  (invalidation = resistance)
//   "neutral" — active only WHILE CONTAINED; a break of EITHER line resolves it
const INNATE = {
  "Ascending Triangle":   { bull: 1.0, bear: 0.2, kind: "converging", flatSide: "res",  bias: "bull" },
  "Descending Triangle":  { bull: 0.2, bear: 1.0, kind: "converging", flatSide: "sup",  bias: "bear" },
  "Symmetrical Triangle": { bull: 0.5, bear: 0.5, kind: "converging", flatSide: null,   bias: "neutral" },
  "Rising Wedge":         { bull: 0.2, bear: 0.9, kind: "converging", flatSide: null,   bias: "bear" },
  "Falling Wedge":        { bull: 0.9, bear: 0.2, kind: "converging", flatSide: null,   bias: "bull" },
  "Channel Up":           { bull: 0.8, bear: 0.3, kind: "parallel",   flatSide: null,   bias: "bull" },
  "Channel Down":         { bull: 0.3, bear: 0.8, kind: "parallel",   flatSide: null,   bias: "bear" },
  "Rectangle":            { bull: 0.5, bear: 0.5, kind: "parallel",   flatSide: null,   bias: "neutral" },
};

// Pure classification from the two slopes + convergence. Returns a pattern name, or
// null for any geometry not in the catalogue (broadening, ambiguous convergence).
// The eight conditions are mutually exclusive: flat/rising/falling partition the
// slope sign, and converging/parallel are disjoint bands (a convergenceRatio
// between them, or a diverging one, falls through to null).
export function classify(resSlopePct, supSlopePct, convergenceRatio, t = DEFAULTS) {
  const flat = (s) => Math.abs(s) < t.flatSlopePct;
  const rising = (s) => s >= t.flatSlopePct;
  const falling = (s) => s <= -t.flatSlopePct;
  const converging = convergenceRatio >= t.convergeRatio;
  const parallel = Math.abs(convergenceRatio) <= t.parallelRatio;

  if (converging && flat(resSlopePct) && rising(supSlopePct)) return "Ascending Triangle";
  if (converging && falling(resSlopePct) && flat(supSlopePct)) return "Descending Triangle";
  if (converging && falling(resSlopePct) && rising(supSlopePct)) return "Symmetrical Triangle";
  if (converging && rising(resSlopePct) && rising(supSlopePct)) return "Rising Wedge";
  if (converging && falling(resSlopePct) && falling(supSlopePct)) return "Falling Wedge";
  if (parallel && rising(resSlopePct) && rising(supSlopePct)) return "Channel Up";
  if (parallel && falling(resSlopePct) && falling(supSlopePct)) return "Channel Down";
  if (parallel && flat(resSlopePct) && flat(supSlopePct)) return "Rectangle";
  return null; // broadening / ambiguous convergence / not a catalogued pattern
}

// Geometric symmetry sub-score in [0,1], per pattern archetype. All inputs are the
// scale-free slopes + convergence already measured by lineGeometry.
function symmetryScore(name, innate, geo, t) {
  const res = geo.resSlopePctPerStep, sup = geo.supSlopePctPerStep;
  const conv = conf.clamp01(geo.convergenceRatio);
  const flatness = (s) => conf.clamp01(1 - Math.abs(s) / t.flatSlopePct);

  if (innate.kind === "parallel") {
    const parallelism = conf.clamp01(1 - Math.abs(geo.convergenceRatio) / t.parallelRatio);
    if (name === "Rectangle") return 0.5 * parallelism + 0.5 * (0.5 * flatness(res) + 0.5 * flatness(sup));
    const meanSlope = (Math.abs(res) + Math.abs(sup)) / 2 || 1;
    const slopeEq = conf.clamp01(1 - Math.abs(res - sup) / meanSlope); // channels: equal slopes
    return 0.5 * parallelism + 0.5 * slopeEq;
  }
  // converging family
  if (innate.flatSide) return 0.5 * flatness(innate.flatSide === "res" ? res : sup) + 0.5 * conv;
  if (name === "Symmetrical Triangle") {
    const mag = (Math.abs(res) + Math.abs(sup)) / 2 || 1; // reward equal & opposite slopes
    return 0.5 * conf.clamp01(1 - Math.abs(Math.abs(res) - Math.abs(sup)) / mag) + 0.5 * conv;
  }
  // wedges: both slopes the same sign, converging — clean convergence is the signal
  const sameSign = Math.sign(res) === Math.sign(sup) ? 1 : 0;
  return 0.5 * conv + 0.5 * sameSign;
}

const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

// detectTrendlinePatterns(series, opts) -> PatternMatch[]
// PatternMatch = { patternName, confidence, supportLevel, resistanceLevel,
//                  bullishBias, bearishBias, invalidationLevel, details }
// Returns [] (never throws) when the data can't support a read. At most one
// trendline pattern is returned per call (a window has one envelope pair).
export function detectTrendlinePatterns(series, opts = {}) {
  const t = { ...DEFAULTS, ...opts };
  const closes = series?.closes ?? [];
  const n = closes.length;
  if (n < t.atrPeriod + 2) return []; // not enough bars for ATR + structure

  const a = atr(series, t.atrPeriod);
  if (!Number.isFinite(a) || a <= 0) return [];

  const pivots = findPivots(series, {
    width: t.pivotWidth,
    minProminenceAtr: t.minProminenceAtr,
    atrPeriod: t.atrPeriod,
    atrValue: a,
  });
  if (pivots.highs.length < t.minTouches || pivots.lows.length < t.minTouches) return [];

  const resLine = fitLine(pivots.highs.map((p) => ({ x: p.idx, y: p.price })));
  const supLine = fitLine(pivots.lows.map((p) => ({ x: p.idx, y: p.price })));
  if (!resLine || !supLine) return [];

  // Validity gate: the lines must actually hug their touches. Residual-vs-ATR (not
  // R²) so a genuinely flat ceiling isn't rejected for "explaining no variance".
  if (resLine.rmsResidual > t.maxResidAtr * a || supLine.rmsResidual > t.maxResidAtr * a) return [];

  const x0 = Math.min(pivots.highs[0].idx, pivots.lows[0].idx);
  const xN = n - 1;
  const geo = lineGeometry(resLine, supLine, x0, xN);

  const name = classify(geo.resSlopePctPerStep, geo.supSlopePctPerStep, geo.convergenceRatio, t);
  if (!name) return [];

  const innate = INNATE[name];
  const resistanceLevel = lineValue(resLine, xN);
  const supportLevel = lineValue(supLine, xN);
  const close = closes[n - 1];

  // --- Active-pattern gate ---
  // A pattern is only reported while price is still CONTAINED by it. Because the
  // pivots exclude the most recent `pivotWidth` bars (confirmation lag), the fitted
  // lines are extrapolated to the current bar; if the latest close has already
  // broken through past an ATR-relative tolerance, the structure is resolved, not
  // active. Directional patterns die only on a break in their INVALIDATION
  // direction (a favourable breakout is the thesis confirming, not invalidation).
  // Neutral patterns (Symmetrical Triangle, Rectangle) have no thesis — a break of
  // EITHER line resolves them, so they're reported only while price sits inside.
  const tol = t.invalidationAtr * a;
  let invalidationLevel, invalidated;
  if (innate.bias === "bull") {
    invalidationLevel = supportLevel;
    invalidated = close < supportLevel - tol;
  } else if (innate.bias === "bear") {
    invalidationLevel = resistanceLevel;
    invalidated = close > resistanceLevel + tol;
  } else {
    // neutral: void once price leaves the envelope either side; surface the nearer
    // edge (the level whose break would most imminently end the consolidation).
    invalidated = close < supportLevel - tol || close > resistanceLevel + tol;
    invalidationLevel =
      Math.abs(close - supportLevel) <= Math.abs(close - resistanceLevel) ? supportLevel : resistanceLevel;
  }
  if (invalidated) return [];

  // --- Confidence sub-scores ---
  const touches = Math.min(pivots.highs.length, pivots.lows.length);
  const sTouch = conf.scoreTouch(touches);
  const sFit = conf.scoreFit(Math.max(resLine.rmsResidual, supLine.rmsResidual), a);

  const vt = volumeTrend(series.volumes);
  const sSym = symmetryScore(name, innate, geo, t);
  let sBreakout, sVolume;
  if (innate.kind === "converging") {
    sBreakout = conf.scoreBreakoutConverging(geo.apexBar, xN, { horizon: t.apexHorizon });
    sVolume = conf.scoreVolume(vt?.ratio, "contraction"); // triangles/wedges: volume should dry up
  } else {
    sBreakout = conf.scoreBreakoutParallel(close, resistanceLevel, supportLevel, a, { boundaryAtr: t.boundaryAtr });
    sVolume = conf.scoreVolume(vt?.ratio, "steady"); // channels/rectangle: steady volume
  }

  const factors = { fit: sFit, touch: sTouch, symmetry: sSym, volume: sVolume, breakout: sBreakout };
  const confidence = conf.composite(factors, t.weights);

  // --- Directional bias (innate lean scaled by confidence, bumped on a confirmed
  // break of the relevant boundary in the bias direction) ---
  let bull = innate.bull * confidence;
  let bear = innate.bear * confidence;
  if (close > resistanceLevel) bull = conf.clamp01(bull + 0.2 * (1 - bull)); // broke up
  if (close < supportLevel) bear = conf.clamp01(bear + 0.2 * (1 - bear));     // broke down

  return [
    {
      patternName: name,
      confidence: round3(confidence),
      supportLevel,
      resistanceLevel,
      bullishBias: round3(conf.clamp01(bull)),
      bearishBias: round3(conf.clamp01(bear)),
      invalidationLevel,
      details: {
        factors,
        geometry: geo,
        touchesHigh: pivots.highs.length,
        touchesLow: pivots.lows.length,
        atr: a,
        resLine,
        supLine,
        span: [x0, xN],
      },
    },
  ];
}
