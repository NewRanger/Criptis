// explain-pattern.mjs — audit tool that prints a full, step-by-step explanation of
// why the trendline detector did (or did not) classify a coin's 48h series as a
// pattern. Read-only: no alerts, no email, no LLM, no state writes. Handy when a
// detection looks surprising (it's how the degenerate Ripple "Rising Wedge" was
// diagnosed).
//
//   node patterns/explain-pattern.mjs ripple                     # fetch live, snapshot it
//   node patterns/explain-pattern.mjs --file path/to/series.json # re-audit a saved series
//
// A live fetch is saved to patterns/explain-<coin>.json so the exact numbers stay
// reproducible (live data moves run-to-run; the detector is deterministic on a
// fixed series). Point --file at any saved series, e.g. a fixture under fixtures/.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchSeries } from "../datasource.js";
import {
  detectPatterns, classify, DEFAULTS, findPivots, atr, fitLine, lineGeometry, lineValue,
} from "./index.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const fileIdx = argv.indexOf("--file");

let coin = "ripple";
let series;
if (fileIdx !== -1) {
  const f = argv[fileIdx + 1];
  series = JSON.parse(fs.readFileSync(f, "utf8"));
  coin = series.coinId ?? path.basename(f, ".json");
} else {
  coin = argv[0] ?? "ripple";
  series = await fetchSeries(coin, { hours: 48 });
  const snap = path.join(dir, `explain-${coin}.json`);
  fs.writeFileSync(snap, JSON.stringify(series, null, 2) + "\n");
  console.log(`(snapshot saved to ${path.relative(process.cwd(), snap)} — re-audit with --file)\n`);
}

const t = DEFAULTS;
const px = (x) => (x == null ? "n/a" : Number(x).toFixed(4));
const tISO = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");

console.log(`=== ${coin.toUpperCase()} — trendline pattern audit ===`);
console.log(`series: ${series.closes.length} hourly candles, latest close ${px(series.closes.at(-1))}`);
console.log(`thresholds: flatSlopePct=${t.flatSlopePct} convergeRatio=${t.convergeRatio} parallelRatio=${t.parallelRatio} invalidationAtr=${t.invalidationAtr} maxResidAtr=${t.maxResidAtr} minTouchesReport=${t.minTouchesReport}\n`);

// 7. ATR
const a = atr(series, t.atrPeriod);
console.log(`[7] ATR(${t.atrPeriod}) used for tolerances: ${px(a)}`);

// 1 & 2. pivots
const pivots = findPivots(series, {
  width: t.pivotWidth, minProminenceAtr: t.minProminenceAtr, atrPeriod: t.atrPeriod, atrValue: a,
});
const showPivots = (ps) => ps.map((p) => `#${p.idx}@${tISO(p.t)}=${px(p.price)}`).join("  ");
console.log(`\n[1] pivot HIGHS (${pivots.highs.length}): ${showPivots(pivots.highs) || "none"}`);
console.log(`[2] pivot LOWS  (${pivots.lows.length}): ${showPivots(pivots.lows) || "none"}`);

if (pivots.highs.length < t.minTouches || pivots.lows.length < t.minTouches) {
  console.log(`\n=> too few pivots for two trendlines (need >= ${t.minTouches} each) — detector returns []`);
  process.exit(0);
}

// 3 & 4. trendlines
const resLine = fitLine(pivots.highs.map((p) => ({ x: p.idx, y: p.price })));
const supLine = fitLine(pivots.lows.map((p) => ({ x: p.idx, y: p.price })));
const x0 = Math.min(pivots.highs[0].idx, pivots.lows[0].idx);
const xN = series.closes.length - 1;
const geo = lineGeometry(resLine, supLine, x0, xN);

console.log(`\n[3] RESISTANCE line: slope ${resLine.slope.toFixed(6)}/bar  (${geo.resSlopePctPerStep.toFixed(4)} %/bar)  RMSresid ${px(resLine.rmsResidual)} (${(resLine.rmsResidual / a).toFixed(2)} ATR)`);
console.log(`[4] SUPPORT    line: slope ${supLine.slope.toFixed(6)}/bar  (${geo.supSlopePctPerStep.toFixed(4)} %/bar)  RMSresid ${px(supLine.rmsResidual)} (${(supLine.rmsResidual / a).toFixed(2)} ATR)`);

// 5. both rising?
const cls = (s) => (Math.abs(s) < t.flatSlopePct ? "FLAT" : s > 0 ? "RISING" : "FALLING");
console.log(`\n[5] direction: resistance=${cls(geo.resSlopePctPerStep)}  support=${cls(geo.supSlopePctPerStep)}  -> both rising? ${cls(geo.resSlopePctPerStep) === "RISING" && cls(geo.supSlopePctPerStep) === "RISING"}`);

// 6. converging?
const converging = geo.convergenceRatio >= t.convergeRatio;
const parallel = Math.abs(geo.convergenceRatio) <= t.parallelRatio;
console.log(`[6] band: widthStart ${px(geo.widthStart)} -> widthEnd ${px(geo.widthEnd)}  convergenceRatio ${geo.convergenceRatio.toFixed(3)}  -> ${converging ? "CONVERGING" : parallel ? "PARALLEL" : "ambiguous"}  (apex bar ${geo.apexBar == null ? "n/a" : geo.apexBar.toFixed(1)})`);

// classification
const name = classify(geo.resSlopePctPerStep, geo.supSlopePctPerStep, geo.convergenceRatio, t);
console.log(`\n=> classify() = ${name ?? "null (not in catalogue)"}`);

// 8. close vs levels
const resistanceLevel = lineValue(resLine, xN);
const supportLevel = lineValue(supLine, xN);
const close = series.closes[xN];
const tol = t.invalidationAtr * a;
console.log(`\n[8] latest close ${px(close)} vs support ${px(supportLevel)} / resistance ${px(resistanceLevel)}  (gate tolerance ±${px(tol)} = ${t.invalidationAtr} ATR)`);
console.log(`    distance to support ${(close - supportLevel >= 0 ? "+" : "")}${px(close - supportLevel)} | to resistance ${(close - resistanceLevel >= 0 ? "+" : "")}${px(close - resistanceLevel)}`);

// 9 & 10. touches + sub-scores (from the real detector output)
const match = detectPatterns(series)[0];
console.log(`\n[9] touch count: highs ${pivots.highs.length}, lows ${pivots.lows.length} -> min used ${Math.min(pivots.highs.length, pivots.lows.length)}`);

// Validity guards (mirror the detector — display only; explains a classify()-vs-FINAL gap)
const widthsOk = geo.widthStart > 0 && geo.widthEnd > 0;
const apexOk = !converging || (Number.isFinite(geo.apexBar) && geo.apexBar > xN);
const touchesOk = Math.min(pivots.highs.length, pivots.lows.length) >= t.minTouchesReport;
console.log(`\nvalidity guards: envelope ${widthsOk ? "OK" : "FAIL (lines cross / inverted)"} · ${converging ? `apex ${apexOk ? "future OK" : "FAIL (past/at apex)"}` : "apex n/a (parallel)"} · touches ${touchesOk ? "OK" : `FAIL (< ${t.minTouchesReport} on a line)`}`);

if (match) {
  const f = match.details.factors;
  console.log(`\n[10] confidence sub-scores (weights ${JSON.stringify(t.weights)}):`);
  console.log(`     fit       ${f.fit?.toFixed(3)}`);
  console.log(`     touch     ${f.touch?.toFixed(3)}`);
  console.log(`     symmetry  ${f.symmetry?.toFixed(3)}`);
  console.log(`     volume    ${f.volume === undefined ? "n/a" : f.volume.toFixed(3)}`);
  console.log(`     proximity ${f.breakout?.toFixed(3)}  (breakout factor)`);
  console.log(`\n=> FINAL: ${match.patternName} confidence ${match.confidence}  bull ${match.bullishBias} / bear ${match.bearishBias}  invalidation ${px(match.invalidationLevel)}`);
} else {
  console.log(`\n=> FINAL: detectPatterns() returned []  (classified ${name ?? "null"}${name ? ", then filtered by a validity / active-pattern guard above" : ""})`);
}
