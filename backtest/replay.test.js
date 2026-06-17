// Tests for the backtest replay — the no-look-ahead guarantee above all. Run: node --test
import test from "node:test";
import assert from "node:assert/strict";

import { replay, labelOutcome, sliceSeries } from "./replay.js";

const T0 = 1_700_000_000_000, HOUR = 3_600_000;

// Deterministic OHLCV of length n. closeFn drives the close; a fixed band around it.
function mk(closeFn, n = 120, band = 0.01) {
  const s = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    s.times.push(T0 + i * HOUR);
    s.opens.push(c); s.closes.push(c); s.highs.push(c * (1 + band)); s.lows.push(c * (1 - band)); s.volumes.push(1000);
  }
  return s;
}

test("NO LOOK-AHEAD: predictFn never sees a bar later than i", () => {
  const series = mk((i) => 100 + i);
  const calls = [];
  const predict = (sub) => {
    calls.push({ maxTime: Math.max(...sub.times), len: sub.times.length });
    return { dir: 1, confidence: 0.5 };
  };
  const records = replay(series, predict, { warmup: 60, step: 1, sliceWindow: 0 });
  assert.equal(calls.length, records.length, "one prediction call per record");
  for (let k = 0; k < records.length; k++) {
    const i = records[k].i;
    // the sub-series handed to the model must end EXACTLY at bar i — never beyond
    assert.equal(calls[k].maxTime, series.times[i], `call ${k} saw a future bar`);
    assert.ok(calls[k].maxTime <= series.times[i], "no future leak");
  }
});

test("sliceWindow bounds the sub-series to the last N bars (and still ends at i)", () => {
  const series = mk((i) => 100 + i);
  const seen = [];
  replay(series, (sub) => { seen.push(sub.closes.length); return { dir: 1 }; }, { warmup: 60, sliceWindow: 50 });
  for (const len of seen) assert.ok(len <= 50, `window exceeded: ${len}`);
});

test("labelOutcome: a long that reaches target first => hit", () => {
  const s = { times: [0, 1], opens: [100, 105], highs: [100, 111], lows: [100, 100], closes: [100, 105], volumes: [1, 1] };
  const r = labelOutcome(s, 0, +1, 10, { horizon: 3, kAtr: 1 }); // target 110, stop 90
  assert.equal(r.label, "hit");
  assert.equal(r.exitBar, 1);
});

test("labelOutcome: a long that hits the stop first => miss", () => {
  const s = { times: [0, 1], opens: [100, 95], highs: [100, 100], lows: [100, 89], closes: [100, 95], volumes: [1, 1] };
  const r = labelOutcome(s, 0, +1, 10, { horizon: 3, kAtr: 1 });
  assert.equal(r.label, "miss");
});

test("labelOutcome: neither barrier within horizon => flat, scored by directional return", () => {
  const s = {
    times: [0, 1, 2, 3], opens: [100, 105, 106, 103],
    highs: [100, 105, 106, 104], lows: [100, 95, 96, 97], closes: [100, 105, 106, 103], volumes: [1, 1, 1, 1],
  };
  const r = labelOutcome(s, 0, +1, 10, { horizon: 3, kAtr: 1 }); // target 110, stop 90 — untouched
  assert.equal(r.label, "flat");
  assert.ok(Math.abs(r.forwardReturn - 0.03) < 1e-9, `forwardReturn ${r.forwardReturn}`);
});

test("labelOutcome: same-bar straddle of both barriers counts as the stop (conservative)", () => {
  const s = { times: [0, 1], opens: [100, 100], highs: [100, 112], lows: [100, 88], closes: [100, 100], volumes: [1, 1] };
  const r = labelOutcome(s, 0, +1, 10, { horizon: 3, kAtr: 1 }); // bar straddles 110 and 90
  assert.equal(r.label, "miss", "conservative: count the stop when both touch in one bar");
});

test("a flat dir (0) or zero ATR is not scorable", () => {
  const s = mk((i) => 100 + i, 5);
  assert.equal(labelOutcome(s, 0, 0, 10, {}).label, "flat");
  assert.equal(labelOutcome(s, 0, 1, 0, {}).label, "flat");
});

test("replay is deterministic and only scores directional calls", () => {
  const series = mk((i) => 100 + i + Math.sin(i / 5) * 4);
  const predict = (sub) => ({ dir: sub.closes.length % 2 === 0 ? 1 : 0, confidence: 0.6 });
  const a = replay(series, predict, { warmup: 60 });
  const b = replay(series, predict, { warmup: 60 });
  assert.deepEqual(a, b, "same input => identical records");
  assert.ok(a.every((r) => r.dir !== 0), "dir===0 calls are skipped");
});

test("sliceSeries returns a same-shaped sub-series", () => {
  const s = mk((i) => i, 10);
  const sub = sliceSeries(s, 2, 5);
  assert.deepEqual(sub.closes, [2, 3, 4]);
  for (const k of ["times", "opens", "highs", "lows", "closes", "volumes"]) assert.equal(sub[k].length, 3);
});
