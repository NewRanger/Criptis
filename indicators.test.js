// Unit tests for the pure breakoutPrefilter gate in indicators.js.
// Run with:  node --test
// Pure — no network. The other indicators are exercised end-to-end via readout().

import test from "node:test";
import assert from "node:assert/strict";

import { breakoutPrefilter } from "./indicators.js";

// 24 hourly candles: 23 stable closes at 100 then a final close, paired with a
// stable 1000-volume baseline and a final volume. With 19 of the band-window's 20
// closes at 100, a final close of 105 sits well outside the 2σ upper band (~102.4)
// and a final close of 95 below the lower band (~97.6).
const stable = (last) => [...Array(23).fill(100), last];
const vols = (last) => [...Array(23).fill(1000), last];

test("breakoutPrefilter PASSES on an upper-band breakout backed by a >=1.5x volume spike", () => {
  const r = breakoutPrefilter({ closes: stable(105), volumes: vols(2000) });
  assert.equal(r.pass, true);
  assert.equal(r.breakout, "up");
  assert.equal(r.volumeConfirmed, true);
  assert.ok(r.volumeRatio >= 1.5, `ratio ${r.volumeRatio} should clear 1.5x`);
  assert.ok(r.close > r.upper, "latest close is above the upper band");
  assert.match(r.reason, /breakout up/);
});

test("breakoutPrefilter PASSES symmetrically on a lower-band breakout with a volume spike", () => {
  const r = breakoutPrefilter({ closes: stable(95), volumes: vols(2000) });
  assert.equal(r.pass, true);
  assert.equal(r.breakout, "down");
  assert.ok(r.close < r.lower, "latest close is below the lower band");
});

test("breakoutPrefilter FAILS a real breakout when volume is under 1.5x the 24h average", () => {
  const r = breakoutPrefilter({ closes: stable(105), volumes: vols(1100) }); // ~1.10x
  assert.equal(r.pass, false);
  assert.equal(r.breakout, "up", "the breakout is real...");
  assert.equal(r.volumeConfirmed, false, "...but the volume doesn't confirm it");
  assert.match(r.reason, /< 1\.5x avg/);
});

test("breakoutPrefilter FAILS a big volume spike when price never leaves the band", () => {
  const r = breakoutPrefilter({ closes: Array(24).fill(100), volumes: vols(5000) });
  assert.equal(r.pass, false);
  assert.equal(r.breakout, null);
  assert.equal(r.volumeConfirmed, true, "volume spiked, but there is no breakout");
  assert.match(r.reason, /no breakout/);
});

test("breakoutPrefilter fails CLOSED without enough closes for a Bollinger Band", () => {
  const r = breakoutPrefilter({ closes: Array(10).fill(100), volumes: Array(10).fill(1000) });
  assert.equal(r.pass, false);
  assert.equal(r.breakout, null);
  assert.equal(r.upper, null, "no band could be computed");
  assert.match(r.reason, /not enough price history/);
});

test("breakoutPrefilter fails CLOSED when the latest volume is missing", () => {
  const r = breakoutPrefilter({ closes: stable(105), volumes: vols(null) });
  assert.equal(r.pass, false);
  assert.equal(r.recentVolume, null);
  assert.match(r.reason, /volume data/);
});

test("breakoutPrefilter degrades on empty / missing input without throwing", () => {
  assert.equal(breakoutPrefilter({ closes: [], volumes: [] }).pass, false);
  assert.equal(breakoutPrefilter(undefined).pass, false);
  assert.equal(breakoutPrefilter({}).pass, false);
});

test("breakoutPrefilter honours custom thresholds (volMult)", () => {
  // ~1.92x volume passes the default 1.5x but not a stricter 2.0x gate.
  const candles = { closes: stable(105), volumes: vols(2000) };
  assert.equal(breakoutPrefilter(candles).pass, true);
  assert.equal(breakoutPrefilter(candles, { volMult: 2.0 }).pass, false);
});
