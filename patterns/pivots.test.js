// Unit tests for deterministic pivot detection. Run:  node --test
import test from "node:test";
import assert from "node:assert/strict";

import { findPivots } from "./pivots.js";
import { atr } from "./atr.js";
import { channelUp } from "./fixtures/synth.js";

test("findPivots locates the swing highs and lows of a clean channel", () => {
  const s = channelUp();
  const p = findPivots(s, { atrValue: atr(s, 14) });
  assert.deepEqual(p.highs.map((x) => x.idx), [6, 18, 30, 42]);
  assert.deepEqual(p.lows.map((x) => x.idx), [12, 24, 36]);
});

test("pivot prices come from the high/low arrays, carrying their timestamps", () => {
  const s = channelUp();
  const p = findPivots(s, { atrValue: atr(s, 14) });
  const h0 = p.highs[0];
  assert.equal(h0.price, s.highs[h0.idx]);
  assert.equal(h0.t, s.times[h0.idx]);
});

test("bars within `width` of either end are never pivots (confirmation lag)", () => {
  const s = channelUp();
  const w = 3;
  const p = findPivots(s, { width: w, atrValue: atr(s, 14) });
  const n = s.closes.length;
  for (const { idx } of [...p.highs, ...p.lows]) {
    assert.ok(idx >= w && idx < n - w, `pivot ${idx} too close to an end`);
  }
});

test("a strict local extremum is required (flat plateaus yield no pivot)", () => {
  // a perfectly flat series has no strict maxima/minima anywhere
  const n = 30;
  const flat = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  for (let i = 0; i < n; i++) {
    flat.times.push(i); flat.opens.push(100); flat.closes.push(100);
    flat.highs.push(100.5); flat.lows.push(99.5); flat.volumes.push(1000);
  }
  const p = findPivots(flat, { width: 2 });
  assert.equal(p.highs.length + p.lows.length, 0);
});

test("the prominence filter rejects swings that don't clear minProminenceAtr * ATR", () => {
  const s = channelUp();
  const a = atr(s, 14);
  const lenient = findPivots(s, { minProminenceAtr: 0.5, atrValue: a });
  const strict = findPivots(s, { minProminenceAtr: 50, atrValue: a }); // absurd bar
  assert.ok(lenient.highs.length + lenient.lows.length > 0);
  assert.equal(strict.highs.length + strict.lows.length, 0, "no swing clears 50*ATR");
});
