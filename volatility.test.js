// Tests for volatility.js — the storm forecaster. Run: node --test
import test from "node:test";
import assert from "node:assert/strict";

import { forecastVolatility, levelMap, DEFAULTS } from "./volatility.js";

const T0 = 1_700_000_000_000, HOUR = 3_600_000;

// Build a series whose per-bar return magnitude is `volFn(i)` (fraction), so we can
// dial volatility up or down deterministically. Alternating sign keeps price ~stable.
function mk(volFn, n = 320, start = 100) {
  const s = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  let c = start;
  for (let i = 0; i < n; i++) {
    const step = (i % 2 ? -1 : 1) * volFn(i) * c;
    const o = c; c = Math.max(1, c + step);
    s.times.push(T0 + i * HOUR); s.opens.push(o); s.closes.push(c);
    s.highs.push(Math.max(o, c) * 1.001); s.lows.push(Math.min(o, c) * 0.999); s.volumes.push(1000);
  }
  return s;
}

test("calm market => no storm", () => {
  const f = forecastVolatility(mk(() => 0.002)); // steady low vol throughout
  assert.equal(f.storm, false);
  assert.ok(f.probability < DEFAULTS.stormProb);
  assert.equal(f.horizonHours, DEFAULTS.horizon);
});

test("a recent volatility spike => storm warning", () => {
  // normal 0.3%/bar, then the last stretch jumps to ~3%/bar
  const f = forecastVolatility(mk((i) => (i >= 290 ? 0.03 : 0.003)));
  assert.equal(f.storm, true, `expected storm, got ${JSON.stringify(f)}`);
  assert.ok(f.ratio > 1, "current vol above normal");
  assert.ok(f.probability >= DEFAULTS.stormProb && f.probability <= 0.72);
  assert.equal(f.level, "high");
  assert.ok(f.expectedMovePct > 0);
});

test("a volatility squeeze (vol well below normal) flags likely expansion", () => {
  const f = forecastVolatility(mk((i) => (i >= 290 ? 0.0005 : 0.004))); // recent calm after normal
  assert.equal(f.squeeze, true);
  assert.equal(f.reason, "squeeze-expansion");
  assert.equal(f.storm, true);
});

test("fails closed on too little data (never throws)", () => {
  const f = forecastVolatility(mk(() => 0.01, 20));
  assert.equal(f.storm, false);
  assert.equal(f.reason, "insufficient-data");
  for (const bad of [null, undefined, {}, { closes: [1, 2] }]) {
    assert.equal(forecastVolatility(bad).storm, false);
  }
});

test("scale invariance: ×k prices give the same forecast (vol lives in log-returns)", () => {
  const base = forecastVolatility(mk((i) => (i >= 290 ? 0.03 : 0.003)));
  const big = forecastVolatility(mk((i) => (i >= 290 ? 0.03 : 0.003), 320, 100 * 1000));
  assert.equal(big.storm, base.storm);
  assert.equal(big.level, base.level);
  assert.ok(Math.abs(big.probability - base.probability) < 1e-9, "probability is scale-free");
});

test("deterministic: same input => identical forecast", () => {
  const s = mk((i) => 0.003 + (i % 7) * 0.0004);
  assert.deepEqual(forecastVolatility(s), forecastVolatility(s));
});

test("levelMap returns nearest support below and resistance above the price (or nulls)", () => {
  const s = mk((i) => 0.01);
  const lm = levelMap(s);
  assert.ok(Number.isFinite(lm.price));
  if (lm.support != null) assert.ok(lm.support <= lm.price);
  if (lm.resistance != null) assert.ok(lm.resistance >= lm.price);
  // never throws on garbage
  assert.deepEqual(levelMap(null), { price: null, support: null, resistance: null });
});
