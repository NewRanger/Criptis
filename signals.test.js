// Tests for signals.js — the daily trade-signal decision layer. Run: node --test
//
// Mirrors the determinism discipline of the patterns/ tests: pure, fails-closed,
// ATR-relative, scale-invariant. No clock, no randomness (fixed T0; deterministic
// synthetic series).
import test from "node:test";
import assert from "node:assert/strict";

import { evaluateSignal, VERDICTS, SEVERITY } from "./signals.js";

const T0 = 1_700_000_000_000, DAY = 86_400_000;
const TRADE_VERDICTS = ["BUY", "STRONG_BUY", "SELL", "STRONG_SELL"];

// Deterministic OHLCV builder. `closeFn(i)` drives the close; the band is a fixed
// fraction of price so the whole series scales cleanly (for the scale-invariance test).
function mk(closeFn, { n = 80, band = 0.01, volFn = () => 1000 } = {}) {
  const s = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  for (let i = 0; i < n; i++) {
    const c = closeFn(i);
    s.times.push(T0 + i * DAY);
    s.opens.push(c);
    s.closes.push(c);
    s.highs.push(c * (1 + band));
    s.lows.push(c * (1 - band));
    s.volumes.push(volFn(i));
  }
  return s;
}

const REQUIRED = ["coin", "asOf", "verdict", "severity", "confidence", "netScore", "regime", "confluence", "risk", "factors", "reason"];

test("returns the full schema with typed, finite fields", () => {
  const v = evaluateSignal(mk((i) => 100 + i + Math.sin(i / 4) * 3), { coin: "bitcoin" });
  for (const k of REQUIRED) assert.ok(k in v, `missing field: ${k}`);
  assert.equal(v.coin, "bitcoin");
  assert.ok(VERDICTS.includes(v.verdict), `unknown verdict ${v.verdict}`);
  assert.ok(Object.values(SEVERITY).includes(v.severity));
  assert.ok(Number.isFinite(v.confidence) && v.confidence >= 0 && v.confidence <= 1);
  assert.ok(Number.isFinite(v.netScore) && v.netScore >= -1 && v.netScore <= 1);
  assert.ok(Array.isArray(v.factors) && v.factors.length === 6);
});

test("fails closed on too little data -> NEUTRAL / insufficient-data", () => {
  const v = evaluateSignal(mk((i) => 100 + i, { n: 20 }), { coin: "x" });
  assert.equal(v.verdict, "NEUTRAL");
  assert.equal(v.reason, "insufficient-data");
});

test("fails closed when ATR is zero (a flat, no-range series) -> NEUTRAL / no-atr", () => {
  const flat = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  for (let i = 0; i < 80; i++) {
    flat.times.push(T0 + i * DAY);
    flat.opens.push(100); flat.closes.push(100); flat.highs.push(100); flat.lows.push(100); flat.volumes.push(1000);
  }
  const v = evaluateSignal(flat, { coin: "x" });
  assert.equal(v.verdict, "NEUTRAL");
  assert.equal(v.reason, "no-atr");
});

test("never throws on garbage input -> NEUTRAL", () => {
  for (const bad of [null, undefined, {}, { closes: null }, { closes: [1, 2, 3] }]) {
    const v = evaluateSignal(bad, { coin: "x" });
    assert.equal(v.verdict, "NEUTRAL");
  }
});

test("confluence gate: an impossibly high minAgree can never produce a trade verdict", () => {
  // "no single indicator is a signal" — without enough agreeing factors, the best
  // a forming setup can be is WATCH (or NEUTRAL), never BUY/SELL.
  const v = evaluateSignal(mk((i) => 100 + i * 1.5), { coin: "x", minAgree: 99 });
  assert.ok(!TRADE_VERDICTS.includes(v.verdict), `expected non-trade, got ${v.verdict}`);
});

test("risk gate: an impossibly high minRR caps the verdict below a trade", () => {
  const v = evaluateSignal(mk((i) => 100 + i * 1.5), { coin: "x", minRR: 999 });
  assert.ok(!TRADE_VERDICTS.includes(v.verdict), `expected non-trade, got ${v.verdict}`);
});

test("scale invariance: ×k prices keep the verdict + confidence and scale the levels", () => {
  const shape = (i) => 100 + i + Math.sin(i / 4) * 3;
  const base = evaluateSignal(mk(shape), { coin: "x" });
  const k = 1000;
  const big = evaluateSignal(mk((i) => shape(i) * k), { coin: "x" });
  assert.equal(big.verdict, base.verdict, "verdict is scale-free");
  assert.ok(Math.abs(big.confidence - base.confidence) < 1e-9, "confidence is scale-free");
  assert.ok(Math.abs(big.netScore - base.netScore) < 1e-9, "netScore is scale-free");
  if (Number.isFinite(base.risk.entry) && Number.isFinite(big.risk.entry)) {
    assert.ok(Math.abs(big.risk.entry - k * base.risk.entry) < 1e-3 * k, "entry scales by k");
  }
});

test("a verdict's severity is consistent with its verdict", () => {
  const v = evaluateSignal(mk((i) => 100 + i), { coin: "x" });
  const expected = TRADE_VERDICTS.includes(v.verdict)
    ? (v.verdict.startsWith("STRONG") ? SEVERITY.HIGH : SEVERITY.MEDIUM)
    : v.verdict === "WATCH" ? SEVERITY.LOW : SEVERITY.NONE;
  assert.equal(v.severity, expected);
});
