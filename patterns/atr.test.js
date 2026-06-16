// Unit tests for the ATR volatility unit. Run:  node --test
import test from "node:test";
import assert from "node:assert/strict";

import { atr, trueRanges } from "./atr.js";
import { channelUp } from "./fixtures/synth.js";

test("trueRanges: first bar is high-low, later bars include the previous-close gap", () => {
  const s = { highs: [10, 12, 11], lows: [9, 10, 8], closes: [9.5, 11, 9] };
  // bar0: 10-9 = 1
  // bar1: max(12-10, |12-9.5|, |10-9.5|) = max(2, 2.5, 0.5) = 2.5
  // bar2: max(11-8, |11-11|, |8-11|)     = max(3, 0, 3)     = 3
  assert.deepEqual(trueRanges(s), [1, 2.5, 3]);
});

test("atr returns null below `period` true ranges (fails closed)", () => {
  const s = { highs: [2, 3, 4], lows: [1, 2, 3], closes: [1.5, 2.5, 3.5] };
  assert.equal(atr(s, 14), null);
});

test("atr is a positive, finite number on a full 48h series", () => {
  const a = atr(channelUp(), 14);
  assert.ok(Number.isFinite(a) && a > 0, `got ${a}`);
});

test("atr scales linearly with price (×k prices => ×k ATR) — the basis for ATR-relative tolerances", () => {
  const s = channelUp();
  const k = 7;
  const scaled = { ...s, highs: s.highs.map((x) => x * k), lows: s.lows.map((x) => x * k), closes: s.closes.map((x) => x * k) };
  assert.ok(Math.abs(atr(scaled, 14) - k * atr(s, 14)) < 1e-9);
});

test("atr degrades on empty / missing input without throwing", () => {
  assert.equal(atr({ highs: [], lows: [], closes: [] }), null);
  assert.equal(atr(undefined), null);
});
