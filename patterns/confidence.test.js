// Unit tests for the pure confidence sub-scores + composite. Run:  node --test
import test from "node:test";
import assert from "node:assert/strict";

import { scoreTouch, scoreFit, scoreVolume, scoreBreakoutConverging, scoreBreakoutParallel, composite, DEFAULT_WEIGHTS } from "./confidence.js";

test("scoreTouch ramps from 2 touches (0) to 4 touches (1), then clamps", () => {
  assert.equal(scoreTouch(2), 0);
  assert.equal(scoreTouch(3), 0.5);
  assert.equal(scoreTouch(4), 1);
  assert.equal(scoreTouch(10), 1);
});

test("scoreFit is 1 at zero residual and 0 at lambda*ATR (ATR-relative, not R²)", () => {
  assert.equal(scoreFit(0, 2), 1);
  assert.equal(scoreFit(3, 2), 0); // lambda 1.5 -> 1.5*2 = 3
  assert.ok(Math.abs(scoreFit(1.5, 2) - 0.5) < 1e-9);
  assert.equal(scoreFit(1, 0), 0); // no ATR -> 0, not NaN
});

test("scoreVolume rewards contraction for triangles, steadiness for channels", () => {
  assert.ok(scoreVolume(0.5, "contraction") > scoreVolume(1.2, "contraction"));
  assert.ok(scoreVolume(1.0, "steady") > scoreVolume(1.6, "steady"));
  assert.equal(scoreVolume(undefined), undefined, "absent volume drops out of the mean");
});

test("scoreBreakout: a near FUTURE apex scores high; a PAST/at apex scores 0 (fix 5)", () => {
  assert.equal(scoreBreakoutConverging(47, 47), 0, "apex reached => resolved, no credit");
  assert.equal(scoreBreakoutConverging(30, 47), 0, "past apex => 0 (used to be a wrong 1.0)");
  assert.ok(scoreBreakoutConverging(48, 47) > 0.9, "apex just ahead => near-full credit");
  assert.ok(scoreBreakoutConverging(80, 47) < scoreBreakoutConverging(55, 47), "nearer future apex scores higher");
  // close sitting on the upper boundary scores higher than mid-channel
  assert.ok(scoreBreakoutParallel(142, 142, 128, 2) > scoreBreakoutParallel(135, 142, 128, 2));
});

test("composite renormalises over present factors (missing volume doesn't drag it to 0)", () => {
  assert.ok(Math.abs(composite({ fit: 1, touch: 1, symmetry: 1, volume: 1, breakout: 1 }) - 1) < 1e-12);
  assert.ok(Math.abs(composite({ fit: 1, touch: 1, symmetry: 1, volume: undefined, breakout: 1 }) - 1) < 1e-12);
  // only `fit` present at 1, the rest 0 -> weighted mean = w_fit (weights sum to 1)
  assert.ok(Math.abs(composite({ fit: 1, touch: 0, symmetry: 0, volume: 0, breakout: 0 }) - DEFAULT_WEIGHTS.fit) < 1e-12);
});
