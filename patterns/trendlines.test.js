// Unit tests for line fitting + two-line geometry. Run:  node --test
import test from "node:test";
import assert from "node:assert/strict";

import { fitLine, lineValue, lineGeometry } from "./trendlines.js";

test("fitLine recovers a perfect line exactly (r2 = 1, residual 0)", () => {
  const pts = [0, 1, 2, 3, 4].map((x) => ({ x, y: 2 * x + 5 }));
  const f = fitLine(pts);
  assert.ok(Math.abs(f.slope - 2) < 1e-12);
  assert.ok(Math.abs(f.intercept - 5) < 1e-12);
  assert.ok(Math.abs(f.r2 - 1) < 1e-12);
  assert.ok(f.rmsResidual < 1e-9);
});

test("fitLine slopePctPerStep is the slope as a % of the mean level (scale-free)", () => {
  const pts = [0, 10].map((x) => ({ x, y: 100 + x })); // slope 1, mean y = 105
  const f = fitLine(pts);
  assert.ok(Math.abs(f.slopePctPerStep - (1 / 105) * 100) < 1e-9);
});

test("fitLine returns null for <2 points or a degenerate (all-x-equal) set", () => {
  assert.equal(fitLine([{ x: 1, y: 1 }]), null);
  assert.equal(fitLine([{ x: 5, y: 1 }, { x: 5, y: 9 }]), null);
  assert.equal(fitLine([]), null);
  assert.equal(fitLine(undefined), null);
});

test("lineValue evaluates the line at a bar", () => {
  assert.equal(lineValue({ slope: 2, intercept: 5 }, 3), 11);
});

test("lineGeometry: parallel lines => convergenceRatio 0 and a null apex", () => {
  const res = fitLine([{ x: 0, y: 110 }, { x: 10, y: 120 }]); // slope 1
  const sup = fitLine([{ x: 0, y: 100 }, { x: 10, y: 110 }]); // slope 1, 10 below
  const g = lineGeometry(res, sup, 0, 10);
  assert.ok(Math.abs(g.convergenceRatio) < 1e-12);
  assert.equal(g.apexBar, null);
});

test("lineGeometry: converging lines => positive ratio and a finite apex ahead", () => {
  const res = fitLine([{ x: 0, y: 130 }, { x: 10, y: 130 }]); // flat at 130
  const sup = fitLine([{ x: 0, y: 100 }, { x: 10, y: 125 }]); // rising 100 -> 125
  const g = lineGeometry(res, sup, 0, 10);
  assert.ok(g.convergenceRatio > 0.4, `ratio ${g.convergenceRatio}`);
  assert.ok(Number.isFinite(g.apexBar) && g.apexBar > 10, `apex ${g.apexBar}`);
});

test("lineGeometry: a near-zero widthStart does NOT inflate convergence (fix 3 — bounded to [-1,1])", () => {
  // widthStart ~ 0.001, widthEnd ~ 5.001 (band widening). The old ÷widthStart
  // formula returned ~ -5000; the stable (÷larger-width) denominator keeps it bounded.
  const res = { slope: 1, intercept: 100, slopePctPerStep: 0 };
  const sup = { slope: 0.5, intercept: 99.999, slopePctPerStep: 0 };
  const g = lineGeometry(res, sup, 0, 10);
  assert.ok(Math.abs(g.convergenceRatio) <= 1 + 1e-9, `ratio ${g.convergenceRatio} must be bounded`);
});
