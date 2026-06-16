// patterns/trendlines.js — line fitting and two-line geometry for the trendline
// pattern family. Pure, dependency-free.
//
// fitLine generalises the close-only linreg() in indicators.js to an arbitrary
// set of (x, y) points, because pivots sit at arbitrary bar indices (not 0..n-1).

// Ordinary least-squares fit through points [{ x, y }]. Returns slope, intercept,
// R², a scale-free slope (% of the mean level per x-step, comparable across coins),
// the RMS residual in PRICE units, and the point count. Returns null for fewer
// than 2 usable points or a degenerate (all-x-equal) set.
//
// NOTE ON R²: R² is unreliable for near-FLAT lines — when y barely varies, the
// total sum of squares is tiny and R² collapses toward 0 even for a perfect
// horizontal ceiling. So the detectors gate and score fit on `rmsResidual`
// (relative to ATR), not R². R² is still returned: it is meaningful for clearly
// sloped lines (channels) and useful for diagnostics and the backtest.
export function fitLine(points) {
  const pts = Array.isArray(points)
    ? points.filter((p) => Number.isFinite(p?.x) && Number.isFinite(p?.y))
    : [];
  const n = pts.length;
  if (n < 2) return null;

  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (const { x, y } of pts) { sx += x; sy += y; sxy += x * y; sxx += x * x; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null; // all x identical — no line

  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const yMean = sy / n;

  let ssTot = 0, ssRes = 0;
  for (const { x, y } of pts) {
    ssTot += (y - yMean) ** 2;
    ssRes += (y - (slope * x + intercept)) ** 2;
  }
  const r2 = ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  return {
    slope,
    intercept,
    r2,
    slopePctPerStep: yMean ? (slope / yMean) * 100 : 0,
    rmsResidual: Math.sqrt(ssRes / n),
    n,
  };
}

// Evaluate a fitted line at bar x.
export const lineValue = (line, x) => line.slope * x + line.intercept;

// Geometry of the resistance/support line pair over the span [x0, xN]. Pure
// measurement — no thresholds, no classification (the detector applies those):
//   resSlopePctPerStep / supSlopePctPerStep : scale-free slopes
//   widthStart / widthEnd : band height (price units) at each end of the span
//   convergenceRatio : fraction the band narrows across the span
//                      (>0 converging toward an apex, ~0 parallel, <0 widening)
//   apexBar : bar index where the two lines meet (null if exactly parallel)
export function lineGeometry(resLine, supLine, x0, xN) {
  const widthStart = lineValue(resLine, x0) - lineValue(supLine, x0);
  const widthEnd = lineValue(resLine, xN) - lineValue(supLine, xN);
  // Stable contraction metric: normalise by the LARGER band width, never by
  // widthStart alone (which explodes when the band nearly closes or the lines have
  // crossed — a sign-flipped widthStart produced spurious "convergence"). Bounded
  // to [-1, 1]: >0 converging, ~0 parallel, <0 widening. For a normal converging
  // band (widthStart > widthEnd > 0) the larger width IS widthStart, so this is
  // identical to the intuitive "fraction the band narrowed" — no recalibration.
  const denom = Math.max(Math.abs(widthStart), Math.abs(widthEnd));
  const convergenceRatio = denom > 0 ? (widthStart - widthEnd) / denom : 0;
  const slopeDiff = resLine.slope - supLine.slope;
  const apexBar = slopeDiff !== 0 ? (supLine.intercept - resLine.intercept) / slopeDiff : null;
  return {
    resSlopePctPerStep: resLine.slopePctPerStep,
    supSlopePctPerStep: supLine.slopePctPerStep,
    widthStart,
    widthEnd,
    convergenceRatio,
    apexBar,
  };
}
