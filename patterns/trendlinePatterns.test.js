// Integration tests for the Phase-1 trendline detector — the architecture
// validation. Run:  node --test
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectPatterns } from "./index.js";
import {
  ascendingTriangle, descendingTriangle, symmetricalTriangle, rectangle,
  risingWedge, fallingWedge, channelUp, channelDown,
  invalidatedChannelUp, invalidatedChannelDown, setLastClose, broadening, noise,
  twoTouchRisingWedge,
} from "./fixtures/synth.js";
import { findPivots, atr, fitLine, lineGeometry } from "./index.js";

const REQUIRED = [
  "patternName", "confidence", "supportLevel", "resistanceLevel",
  "bullishBias", "bearishBias", "invalidationLevel",
];
const top = (series, opts) => detectPatterns(series, opts)[0];

test("Ascending Triangle: detected, bullish, invalidation at the rising support", () => {
  const m = top(ascendingTriangle());
  assert.equal(m.patternName, "Ascending Triangle");
  assert.ok(m.bullishBias > m.bearishBias);
  assert.ok(m.supportLevel < m.resistanceLevel);
  assert.equal(m.invalidationLevel, m.supportLevel);
  assert.ok(m.confidence > 0 && m.confidence <= 1);
});

test("Descending Triangle: detected, bearish, invalidation at the falling resistance", () => {
  const m = top(descendingTriangle());
  assert.equal(m.patternName, "Descending Triangle");
  assert.ok(m.bearishBias > m.bullishBias);
  assert.equal(m.invalidationLevel, m.resistanceLevel);
});

test("Channel Up: detected, bullish, invalidation at the lower channel line", () => {
  const m = top(channelUp());
  assert.equal(m.patternName, "Channel Up");
  assert.ok(m.bullishBias > m.bearishBias);
  assert.equal(m.invalidationLevel, m.supportLevel);
});

test("Channel Down: detected, bearish, invalidation at the upper channel line", () => {
  const m = top(channelDown());
  assert.equal(m.patternName, "Channel Down");
  assert.ok(m.bearishBias > m.bullishBias);
  assert.equal(m.invalidationLevel, m.resistanceLevel);
});

test("every match carries the full required schema with finite numbers", () => {
  const m = top(channelUp());
  for (const k of REQUIRED) assert.ok(k in m, `missing field: ${k}`);
  for (const k of REQUIRED.filter((x) => x !== "patternName")) {
    assert.ok(Number.isFinite(m[k]), `${k} is not a finite number`);
  }
  assert.ok(m.bullishBias >= 0 && m.bullishBias <= 1);
  assert.ok(m.bearishBias >= 0 && m.bearishBias <= 1);
});

// --- The four detectors completing Family A ---------------------------------

test("Symmetrical Triangle: detected, neutral bias, invalidation at the nearer edge", () => {
  const m = top(symmetricalTriangle());
  assert.equal(m.patternName, "Symmetrical Triangle");
  assert.ok(Math.abs(m.bullishBias - m.bearishBias) < 1e-9, "no directional lean until it breaks");
  assert.ok(m.supportLevel < m.resistanceLevel);
  assert.ok(m.invalidationLevel === m.supportLevel || m.invalidationLevel === m.resistanceLevel);
});

test("Rectangle: detected (no longer refused), neutral bias", () => {
  const m = top(rectangle());
  assert.equal(m.patternName, "Rectangle");
  assert.ok(Math.abs(m.bullishBias - m.bearishBias) < 1e-9);
  assert.ok(m.supportLevel < m.resistanceLevel);
});

test("Rising Wedge: detected, bearish, invalidation at resistance", () => {
  const m = top(risingWedge());
  assert.equal(m.patternName, "Rising Wedge");
  assert.ok(m.bearishBias > m.bullishBias, "a rising wedge leans bearish");
  assert.equal(m.invalidationLevel, m.resistanceLevel);
});

test("Falling Wedge: detected, bullish, invalidation at support", () => {
  const m = top(fallingWedge());
  assert.equal(m.patternName, "Falling Wedge");
  assert.ok(m.bullishBias > m.bearishBias, "a falling wedge leans bullish");
  assert.equal(m.invalidationLevel, m.supportLevel);
});

// --- Negative controls: geometry the detector must REFUSE -------------------

test("refuses a broadening / megaphone (diverging band is not in the catalogue)", () => {
  assert.deepEqual(detectPatterns(broadening()), []);
});

test("refuses noisy / random geometry (no clean trendline fit)", () => {
  // a few independent seeds — none should hallucinate a pattern out of noise
  for (const seed of [1, 12345, 67890, 555]) {
    assert.deepEqual(detectPatterns(noise(seed)), [], `seed ${seed} produced a phantom pattern`);
  }
});

// --- Family A geometry guards (from the live Ripple audit) ------------------

// The captured real Ripple series whose fitted lines CROSS inside the window
// (widthStart < 0) and whose apex sits in the PAST — the degenerate "Rising Wedge"
// the audit flagged. Both the crossed-envelope guard and the future-apex guard
// reject it.
const rippleCrossed = () =>
  JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "crossed-envelope.json"), "utf8"));

test("guard 1+2: the crossed-envelope / past-apex Ripple wedge is now rejected", () => {
  const s = rippleCrossed();
  // document WHY: the fitted resistance/support cross inside the window (a width
  // goes negative) and the apex is behind the latest bar
  const a = atr(s, 14);
  const p = findPivots(s, { atrValue: a });
  const res = fitLine(p.highs.map((q) => ({ x: q.idx, y: q.price })));
  const sup = fitLine(p.lows.map((q) => ({ x: q.idx, y: q.price })));
  const x0 = Math.min(p.highs[0].idx, p.lows[0].idx);
  const xN = s.closes.length - 1;
  const g = lineGeometry(res, sup, x0, xN);
  assert.ok(g.widthStart < 0 || g.widthEnd < 0, "the lines cross inside the window");
  assert.ok(g.apexBar != null && g.apexBar <= xN, "the apex is in the past");
  assert.deepEqual(detectPatterns(s), [], "=> no pattern reported");
});

test("guard 3: the same series no longer yields a runaway convergenceRatio", () => {
  const s = rippleCrossed();
  const a = atr(s, 14);
  const p = findPivots(s, { atrValue: a });
  const res = fitLine(p.highs.map((q) => ({ x: q.idx, y: q.price })));
  const sup = fitLine(p.lows.map((q) => ({ x: q.idx, y: q.price })));
  const g = lineGeometry(res, sup, Math.min(p.highs[0].idx, p.lows[0].idx), s.closes.length - 1);
  // crossed lines (opposite-sign widths) bound the ratio to [-2, 2]; the point is
  // it is no longer a runaway ~10.7 from dividing by a near-zero widthStart.
  assert.ok(Math.abs(g.convergenceRatio) <= 2 + 1e-9, `convergenceRatio ${g.convergenceRatio} must be bounded (was ~10.7)`);
});

test("guard 4: a valid 2-touch Rising Wedge is NOT reported, but IS once the gate is relaxed", () => {
  assert.deepEqual(detectPatterns(twoTouchRisingWedge()), [], "2 pivot highs => not reported");
  const relaxed = detectPatterns(twoTouchRisingWedge(), { minTouchesReport: 2 })[0];
  assert.equal(relaxed.patternName, "Rising Wedge", "geometry is valid — only the touch gate filtered it");
});

// --- Active-pattern gate: a pattern price has already broken out of (in the
// invalidation direction) is dead, not active, and must not be reported.

test("an already-broken Channel Up (close below the lower line beyond tolerance) is filtered out", () => {
  // the fitted lines are unchanged (only the last, unconfirmed bar moved) — it is
  // still Channel Up geometry, but price has fallen out of the bottom.
  assert.deepEqual(detectPatterns(invalidatedChannelUp()), []);
});

test("an already-broken Channel Down (close above the upper line beyond tolerance) is filtered out", () => {
  assert.deepEqual(detectPatterns(invalidatedChannelDown()), []);
});

test("the gate does NOT over-filter: a small dip within tolerance keeps the Channel Up", () => {
  const base = detectPatterns(channelUp())[0];
  // nudge the latest close just below support but inside the 0.5*ATR tolerance
  const justBelow = base.supportLevel - 0.3 * base.details.atr;
  const m = detectPatterns(setLastClose(channelUp(), justBelow))[0];
  assert.ok(m && m.patternName === "Channel Up", "a dip within tolerance is still an active channel");
});

test("a favourable breakout is NOT treated as invalidation (Channel Up that broke UP is still reported)", () => {
  const base = detectPatterns(channelUp())[0];
  const aboveResistance = base.resistanceLevel + 1.0 * base.details.atr; // broke up, not down
  const m = detectPatterns(setLastClose(channelUp(), aboveResistance))[0];
  assert.ok(m && m.patternName === "Channel Up", "an upside break is the bullish resolution, not invalidation");
});

test("active-pattern gate: a Rising Wedge that broke UP through resistance is invalidated", () => {
  const base = top(risingWedge()); // bearish -> dies on an upside break
  const above = base.resistanceLevel + 2.0 * base.details.atr;
  assert.deepEqual(detectPatterns(setLastClose(risingWedge(), above)), []);
});

test("active-pattern gate: a Falling Wedge that broke DOWN through support is invalidated", () => {
  const base = top(fallingWedge()); // bullish -> dies on a downside break
  const below = base.supportLevel - 2.0 * base.details.atr;
  assert.deepEqual(detectPatterns(setLastClose(fallingWedge(), below)), []);
});

test("active-pattern gate: a neutral Symmetrical Triangle resolves on EITHER break", () => {
  const base = top(symmetricalTriangle());
  const a = base.details.atr;
  assert.deepEqual(detectPatterns(setLastClose(symmetricalTriangle(), base.resistanceLevel + 2 * a)), [], "upside break resolves it");
  assert.deepEqual(detectPatterns(setLastClose(symmetricalTriangle(), base.supportLevel - 2 * a)), [], "downside break resolves it");
});

test("active-pattern gate: a neutral Rectangle broken out either side is not reported", () => {
  const base = top(rectangle());
  const a = base.details.atr;
  assert.deepEqual(detectPatterns(setLastClose(rectangle(), base.resistanceLevel + 2 * a)), []);
  assert.deepEqual(detectPatterns(setLastClose(rectangle(), base.supportLevel - 2 * a)), []);
});

test("fails closed on too little data", () => {
  assert.deepEqual(detectPatterns({ times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] }), []);
  const s = channelUp();
  const cut = (a) => a.slice(0, 10);
  const short = { times: cut(s.times), opens: cut(s.opens), highs: cut(s.highs), lows: cut(s.lows), closes: cut(s.closes), volumes: cut(s.volumes) };
  assert.deepEqual(detectPatterns(short), []);
});

// --- Property tests: the determinism guarantees that make this layer trustworthy.

const scale = (s, k) => ({ ...s, opens: s.opens.map((x) => x * k), highs: s.highs.map((x) => x * k), lows: s.lows.map((x) => x * k), closes: s.closes.map((x) => x * k) });

test("scale invariance: ×k prices keep the pattern + confidence and scale the levels", () => {
  const base = top(channelUp());
  const big = top(scale(channelUp(), 10));
  assert.equal(big.patternName, base.patternName);
  assert.ok(Math.abs(big.confidence - base.confidence) < 1e-9, "confidence is scale-free");
  assert.ok(Math.abs(big.resistanceLevel - 10 * base.resistanceLevel) < 1e-6);
});

// Reflect prices about a constant: highs<->lows swap and negate, so an up-pattern
// becomes its down-mirror. This proves the classifier is sign-symmetric (the
// architecturally meaningful invariant). Confidence stays close but not bit-equal:
// slopePctPerStep normalises by price LEVEL, and reflecting about a constant shifts
// that level — so the symmetry sub-score moves slightly. (The multiplicative
// scale-invariance above is the exact guarantee.)
const mirror = (s, c = 300) => ({
  times: s.times, volumes: s.volumes,
  opens: s.opens.map((x) => c - x), closes: s.closes.map((x) => c - x),
  highs: s.lows.map((x) => c - x), lows: s.highs.map((x) => c - x),
});

test("mirror symmetry: a reflected Channel Up is a Channel Down with a flipped bias", () => {
  const up = top(channelUp());
  const down = top(mirror(channelUp()));
  assert.equal(down.patternName, "Channel Down");
  assert.ok(down.bearishBias > down.bullishBias, "the up-lean reflects to a down-lean");
  assert.ok(Math.abs(down.confidence - up.confidence) < 0.05, "structurally the same shape");
});

test("mirror symmetry: a reflected Descending Triangle is a bullish Ascending Triangle", () => {
  const desc = top(descendingTriangle());
  const asc = top(mirror(descendingTriangle()));
  assert.equal(asc.patternName, "Ascending Triangle");
  assert.ok(asc.bullishBias > asc.bearishBias);
  assert.ok(Math.abs(asc.confidence - desc.confidence) < 0.05);
});

test("detects from a committed JSON fixture on disk (file-based fixtures work)", () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const series = JSON.parse(fs.readFileSync(path.join(dir, "fixtures", "channel-up.json"), "utf8"));
  assert.equal(detectPatterns(series)[0].patternName, "Channel Up");
});
