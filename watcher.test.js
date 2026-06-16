// Unit tests for the pure helpers in watcher.js.
// Run with:  node --test
// These import the pure helpers only; main() is guarded so importing does not run.

import test from "node:test";
import assert from "node:assert/strict";

import { derivePrices, driftDecision, summaryHtml, summaryToText } from "./watcher.js";

// --- BUG 1: derived-price validation (latest close, never zeroed) ------------

test("derivePrices keeps valid coins and skips missing / non-positive last closes", () => {
  const ids = ["bitcoin", "ethereum", "solana", "dogecoin"];
  // A gathered OHLCV map: one valid, one non-positive, one missing (fetch failed),
  // one valid. Each entry is the normalized series; only `last` matters here.
  const ohlcv = {
    bitcoin: { last: 65000 }, // valid
    ethereum: { last: 0 },    // non-positive -> skip (would become a fake 0% move)
    // solana absent entirely -> skip (its Coinbase fetch failed)
    dogecoin: { last: 0.4231 }, // valid sub-$1 coin
  };

  const { prices, skipped } = derivePrices(ohlcv, ids);

  // Valid coins pass through unchanged...
  assert.deepEqual(prices, { bitcoin: 65000, dogecoin: 0.4231 });
  // ...and both the missing coin and the non-positive one are skipped.
  assert.deepEqual([...skipped].sort(), ["ethereum", "solana"]);
});

test("derivePrices skips every shape of invalid last (negative, NaN, null, string, undefined)", () => {
  const ids = ["a", "b", "c", "d", "e", "f"];
  const ohlcv = {
    a: { last: -100 },    // negative
    b: { last: NaN },     // NaN
    c: { last: null },    // null
    d: { last: "65000" }, // string, not a number
    e: {},                // present but no last (empty series)
    f: { last: 42 },      // the only valid one
  };

  const { prices, skipped } = derivePrices(ohlcv, ids);

  assert.deepEqual(prices, { f: 42 });
  assert.deepEqual([...skipped].sort(), ["a", "b", "c", "d", "e"]);
});

test("derivePrices on a total failure (no OHLCV) yields no prices and skips all (caller throws -> exit)", () => {
  const ids = ["bitcoin", "ethereum"];

  const { prices, skipped } = derivePrices({}, ids); // Coinbase unreachable -> empty map

  assert.deepEqual(prices, {});
  assert.deepEqual(skipped, ["bitcoin", "ethereum"]);
  assert.equal(Object.keys(prices).length, 0); // main() treats this as a total failure
  // a missing/undefined map is handled the same way, never throwing or zeroing
  assert.deepEqual(derivePrices(undefined, ids).prices, {});
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

// --- georgianSummary rendering: the LLM's HTML string -> email (HTML + text) ---

test("summaryHtml preserves the allowed <br> and <strong> tags and the Georgian text", () => {
  const s = "<br>• <strong>რა მოხდა:</strong> ფასი <strong>$69</strong>-მდე აიწია";
  const out = summaryHtml(s);
  assert.match(out, /^<br>• <strong>რა მოხდა:<\/strong> ფასი <strong>\$69<\/strong>-მდე აიწია$/);
});

test("summaryHtml neutralizes any tag the model wasn't supposed to emit (no HTML injection)", () => {
  const out = summaryHtml('ok <img src=x onerror=alert(1)> <script>bad()</script> <strong>safe</strong>');
  assert.doesNotMatch(out, /<img/i, "the <img> tag is escaped, not rendered");
  assert.doesNotMatch(out, /<script>/i, "the <script> tag is escaped, not rendered");
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/, "shown as inert text instead");
  assert.match(out, /<strong>safe<\/strong>/, "the allowed tag still renders");
});

test("summaryHtml only restores a bare <br>/<strong>, not one carrying attributes", () => {
  const out = summaryHtml('<strong onmouseover=x>nope</strong> <br class=y> <br/> done');
  assert.doesNotMatch(out, /<strong onmouseover/i, "attribute-bearing <strong> stays escaped");
  assert.doesNotMatch(out, /<br class/i, "attribute-bearing <br> stays escaped");
  assert.match(out, /<br>/, "a bare <br/> is restored");
});

test("summaryToText turns <br> into newlines and drops <strong>, for the plain-text body", () => {
  const s = "<br>• <strong>რა მოხდა:</strong> X<br>• <strong>ტენდენცია:</strong> Y";
  assert.equal(summaryToText(s), "• რა მოხდა: X\n• ტენდენცია: Y");
  assert.equal(summaryToText("a<br/>b<BR>c"), "a\nb\nc", "handles <br/> and <BR> case-insensitively");
});
