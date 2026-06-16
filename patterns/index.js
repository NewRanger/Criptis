// patterns/index.js — public entry point for the deterministic pattern layer.
//
// detectPatterns(series, opts) runs every available detector over a candle series
// (48h hourly initially) and returns all matches ranked by confidence, highest
// first. PHASE 1 wires only the trendline-geometry detector; later phases add the
// swing-structure detectors (double/triple tops & bottoms, head & shoulders) and
// concatenate their matches here — the return contract does not change.
//
// Each match is the standard object:
//   { patternName, confidence, supportLevel, resistanceLevel,
//     bullishBias, bearishBias, invalidationLevel, details }

import { detectTrendlinePatterns } from "./detectors/trendlinePatterns.js";

export function detectPatterns(series, opts = {}) {
  const matches = [...detectTrendlinePatterns(series, opts)];
  return matches.sort((a, b) => b.confidence - a.confidence);
}

export { detectTrendlinePatterns, classify, DEFAULTS } from "./detectors/trendlinePatterns.js";
export { findPivots } from "./pivots.js";
export { atr, trueRanges } from "./atr.js";
export { fitLine, lineValue, lineGeometry } from "./trendlines.js";
