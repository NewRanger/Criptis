// Tests for the calibration math. Run: node --test
import test from "node:test";
import assert from "node:assert/strict";

import { bucketize, groupBy, calibrate, calibratedProbability, evaluateOnTest } from "./calibrate.js";

const rec = (confidence, label, meta = {}) => ({ confidence, label, meta });

test("bucketize: bins by confidence and computes hit-rates", () => {
  const records = [
    rec(0.05, "hit"), rec(0.05, "miss"),                  // bucket 0: 1 hit / 1 miss
    rec(0.95, "hit"), rec(0.95, "hit"), rec(0.95, "miss"), // bucket 9: 2 hit / 1 miss
    rec(0.95, "flat"),                                     // flat doesn't count in decisive
  ];
  const bins = bucketize(records, 10);
  assert.equal(bins[0].n, 2);
  assert.equal(bins[0].decisiveHitRate, 0.5);
  assert.equal(bins[9].n, 4);
  assert.equal(bins[9].hit, 2);
  assert.equal(bins[9].decisiveHitRate, 0.667, "2 hits / (2 hits + 1 miss)");
  assert.equal(bins[9].hitRate, 0.5, "2 hits / 4 total (flat counts against)");
});

test("groupBy: tallies by a meta key", () => {
  const records = [
    rec(0.5, "hit", { regime: "bull" }), rec(0.5, "miss", { regime: "bull" }),
    rec(0.5, "hit", { regime: "bear" }),
  ];
  const g = groupBy(records, "regime");
  assert.equal(g.bull.n, 2);
  assert.equal(g.bull.decisiveHitRate, 0.5);
  assert.equal(g.bear.decisiveHitRate, 1);
});

test("calibrate: assembles overall + byConfidence + byRegime + byVerdict", () => {
  const records = [
    rec(0.8, "hit", { regime: "bull", verdict: "BUY" }),
    rec(0.8, "miss", { regime: "bear", verdict: "SELL" }),
    rec(0.2, "flat", { regime: "range", verdict: "WATCH" }),
  ];
  const c = calibrate(records);
  assert.equal(c.overall.n, 3);
  assert.ok(Array.isArray(c.byConfidence) && c.byConfidence.length === 10);
  assert.ok("bull" in c.byRegime && "BUY" in c.byVerdict);
});

test("calibratedProbability: uses the bucket when it has enough samples, else falls back", () => {
  // bucket 7 (0.7–0.8) well-populated at 60% decisive hit-rate
  const records = [];
  for (let k = 0; k < 60; k++) records.push(rec(0.75, k < 36 ? "hit" : "miss")); // 36/60 = 0.6
  const c = calibrate(records);
  assert.equal(calibratedProbability(0.75, c.byConfidence, c.overall), 0.6);
  // a sparse bucket (0.05) -> falls back to a populated neighbour / overall, never null
  const p = calibratedProbability(0.05, c.byConfidence, c.overall);
  assert.ok(p != null && Number.isFinite(p), "sparse bucket still resolves a probability");
});

test("evaluateOnTest: reports how far promised probabilities miss reality", () => {
  const train = calibrate(Array.from({ length: 40 }, (_, k) => rec(0.75, k < 20 ? "hit" : "miss"))); // promises 0.5 @ bucket7
  const test = Array.from({ length: 20 }, (_, k) => rec(0.75, k < 10 ? "hit" : "miss")); // actual 0.5
  const e = evaluateOnTest(test, train);
  assert.ok(e.meanAbsError != null);
  assert.ok(e.meanAbsError < 0.01, "well-calibrated train should match this test closely");
});
