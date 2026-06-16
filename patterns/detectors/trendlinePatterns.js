// patterns/detectors/trendlinePatterns.js — the trendline-geometry detector.
//
// Family A of the pattern layer: patterns defined by the slopes of the upper
// (resistance) and lower (support) envelopes plus whether they converge or run
// parallel. PHASE 1 implements four of the eight Family-A patterns:
//
//   Ascending Triangle  — flat resistance, rising support, converging   (bullish)
//   Descending Triangle — falling resistance, flat support, converging  (bearish)
//   Channel Up          — both lines rising, parallel                   (bullish)
//   Channel Down        — both lines falling, parallel                  (bearish)
//
// Symmetrical Triangle, Rising/Falling Wedge and Rectangle are deliberately NOT
// classified yet (they return null) so the architecture can be validated first.
//
// The whole detector is pure and deterministic: same candles + opts -> identical
// output. Fails CLOSED (returns []) whenever the data can't support a confident
// geometric read, mirroring breakoutPrefilter() in indicators.js.

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
// trendline is the flat one (used by the symmetry score for triangles).
// `invalidateBelow` marks the break direction that kills the pattern: bullish
// patterns die on a break BELOW support, bearish ones on a break ABOVE resistance.
const INNATE = {
  "Ascending Triangle":  { bull: 1.0, bear: 0.2, kind: "converging", flatSide: "res", invalidateBelow: true },
  "Descending Triangle": { bull: 0.2, bear: 1.0, kind: "converging", flatSide: "sup", invalidateBelow: false },
  "Channel Up":          { bull: 0.8, bear: 0.3, kind: "parallel", invalidateBelow: true },
  "Channel Down":        { bull: 0.3, bear: 0.8, kind: "parallel", invalidateBelow: false },
};

// Pure classification from the two slopes + convergence. Returns a pattern name or
// null for any geometry not covered by Phase 1.
export function classify(resSlopePct, supSlopePct, convergenceRatio, t = DEFAULTS) {
  const flat = (s) => Math.abs(s) < t.flatSlopePct;
  const rising = (s) => s >= t.flatSlopePct;
  const falling = (s) => s <= -t.flatSlopePct;
  const converging = convergenceRatio >= t.convergeRatio;
  const parallel = Math.abs(convergenceRatio) <= t.parallelRatio;

  if (converging && flat(resSlopePct) && rising(supSlopePct)) return "Ascending Triangle";
  if (converging && falling(resSlopePct) && flat(supSlopePct)) return "Descending Triangle";
  if (parallel && rising(resSlopePct) && rising(supSlopePct)) return "Channel Up";
  if (parallel && falling(resSlopePct) && falling(supSlopePct)) return "Channel Down";
  return null; // Symmetrical Triangle / Wedges / Rectangle — not in Phase 1
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
  // broken through the invalidation line by more than an ATR-relative tolerance,
  // the structure is dead, not active. Drop it rather than report e.g. a bullish
  // Channel Up that price has already fallen out of the bottom of.
  const invalidationLevel = innate.invalidateBelow ? supportLevel : resistanceLevel;
  const invalidationTol = t.invalidationAtr * a;
  const invalidated = innate.invalidateBelow
    ? close < invalidationLevel - invalidationTol
    : close > invalidationLevel + invalidationTol;
  if (invalidated) return [];

  // --- Confidence sub-scores ---
  const touches = Math.min(pivots.highs.length, pivots.lows.length);
  const sTouch = conf.scoreTouch(touches);
  const sFit = conf.scoreFit(Math.max(resLine.rmsResidual, supLine.rmsResidual), a);

  const vt = volumeTrend(series.volumes);
  let sBreakout, sVolume, sSym;
  if (innate.kind === "converging") {
    sBreakout = conf.scoreBreakoutConverging(geo.apexBar, xN, { horizon: t.apexHorizon });
    sVolume = conf.scoreVolume(vt?.ratio, "contraction");
    const flatSlope = innate.flatSide === "res" ? geo.resSlopePctPerStep : geo.supSlopePctPerStep;
    const flatness = conf.clamp01(1 - Math.abs(flatSlope) / t.flatSlopePct);
    sSym = 0.5 * flatness + 0.5 * conf.clamp01(geo.convergenceRatio);
  } else {
    sBreakout = conf.scoreBreakoutParallel(close, resistanceLevel, supportLevel, a, {
      boundaryAtr: t.boundaryAtr,
    });
    sVolume = conf.scoreVolume(vt?.ratio, "steady");
    const parallelism = conf.clamp01(1 - Math.abs(geo.convergenceRatio) / t.parallelRatio);
    const meanSlope = (Math.abs(geo.resSlopePctPerStep) + Math.abs(geo.supSlopePctPerStep)) / 2 || 1;
    const slopeEq = conf.clamp01(1 - Math.abs(geo.resSlopePctPerStep - geo.supSlopePctPerStep) / meanSlope);
    sSym = 0.5 * parallelism + 0.5 * slopeEq;
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
