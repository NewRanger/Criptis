// Unit tests for the two pure trigger/validation helpers in watcher.js.
// Run with:  node --test
// These import the pure helpers only; main() is guarded so importing does not run.

import test from "node:test";
import assert from "node:assert/strict";

import { parsePrices, driftDecision } from "./watcher.js";

// --- BUG 1: fetched-price validation -----------------------------------------

test("parsePrices keeps valid coins and skips missing / non-positive prices", () => {
  const ids = ["bitcoin", "ethereum", "solana", "dogecoin"];
  // A fabricated simple/price body: one valid, one non-positive, one missing, one valid.
  const data = {
    bitcoin: { usd: 65000 }, // valid
    ethereum: { usd: 0 },    // non-positive -> skip (would become a fake 0% move)
    // solana absent entirely -> skip (a 429/partial body drops a coin)
    dogecoin: { usd: 0.4231 }, // valid sub-$1 coin
  };

  const { prices, skipped } = parsePrices(data, ids);

  // Valid coins pass through unchanged...
  assert.deepEqual(prices, { bitcoin: 65000, dogecoin: 0.4231 });
  // ...and both the missing coin and the non-positive one are skipped.
  assert.deepEqual([...skipped].sort(), ["ethereum", "solana"]);
});

test("parsePrices skips every shape of invalid usd (negative, NaN, null, string, undefined)", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const data = {
    a: { usd: -100 },     // negative
    b: { usd: NaN },      // NaN
    c: { usd: null },     // null
    d: { usd: "65000" },  // string, not a number
    e: {},                // present but no usd
    f: { usd: 42 },       // the only valid one
  };

  const { prices, skipped } = parsePrices(data, ids);

  assert.deepEqual(prices, { f: 42 });
  assert.deepEqual([...skipped].sort(), ["a", "b", "c", "d", "e"]);
});

test("parsePrices on a total failure yields no prices and skips all (caller throws -> retry/exit)", () => {
  const ids = ["bitcoin", "ethereum"];
  const data = { status: { error_code: 429 } }; // CoinGecko rate-limit body, no coins

  const { prices, skipped } = parsePrices(data, ids);

  assert.deepEqual(prices, {});
  assert.deepEqual(skipped, ["bitcoin", "ethereum"]);
  assert.equal(Object.keys(prices).length, 0); // fetchPrices treats this as total failure
});

// --- BUG 2: drift edge-trigger latch -----------------------------------------

const THRESHOLD = 4;
const REARM = 0.8; // re-arm band: |drift| < 4 * 0.8 = 3.2

test("driftDecision: edge-triggers once, latches on a sustained move, re-fires on reversal", () => {
  // 1. first cross of the threshold -> fire, latch the direction
  let d = driftDecision(6, THRESHOLD, 0, REARM);
  assert.deepEqual(d, { fire: true, nextDir: 1 }, "first cross fires and latches +1");

  // 2. still over the threshold next run -> no fire, stays latched
  d = driftDecision(6.5, THRESHOLD, 1, REARM);
  assert.deepEqual(d, { fire: false, nextDir: 1 }, "sustained move does not re-fire");

  // 2b. inside the hysteresis band (3.2 <= |drift| <= 4) -> no fire, NOT yet re-armed
  d = driftDecision(3.5, THRESHOLD, 1, REARM);
  assert.deepEqual(d, { fire: false, nextDir: 1 }, "hysteresis band keeps the latch set");

  // 3. eased below the re-arm band (< 3.2) -> no fire, re-arm to 0
  d = driftDecision(3, THRESHOLD, 1, REARM);
  assert.deepEqual(d, { fire: false, nextDir: 0 }, "easing below re-arm disarms the latch");

  // 4. crosses again after re-arming -> fire, latch again
  d = driftDecision(7, THRESHOLD, 0, REARM);
  assert.deepEqual(d, { fire: true, nextDir: 1 }, "fresh cross after re-arm fires again");

  // 5. genuine reversal: latched +1, now drifts past the threshold the other way -> fire
  d = driftDecision(-6, THRESHOLD, 1, REARM);
  assert.deepEqual(d, { fire: true, nextDir: -1 }, "sign-flip reversal re-fires");
});

test("driftDecision: first run after deploy (prevDir defaulted to 0) on a mid-drift coin fires once", () => {
  // existing committed state.json lacks lastDriftDir, so callers pass `?? 0`
  const first = driftDecision(5.5, THRESHOLD, 0, REARM);
  assert.deepEqual(first, { fire: true, nextDir: 1 }, "mid-drift coin fires on first deploy run");
  // ...then the latch it returns suppresses the next run
  const next = driftDecision(5.5, THRESHOLD, first.nextDir, REARM);
  assert.equal(next.fire, false, "and stays quiet thereafter");
});

test("driftDecision: REARM = 1.0 means no hysteresis (re-arms the moment it drops below threshold)", () => {
  const d = driftDecision(3.9, THRESHOLD, 1, 1.0); // 3.9 < 4*1.0 -> re-arm immediately
  assert.deepEqual(d, { fire: false, nextDir: 0 });
});
