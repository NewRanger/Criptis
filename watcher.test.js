// Unit tests for the pure helpers in watcher.js.
// Run with:  node --test
// These import the pure helpers only; main() is guarded so importing does not run.

import test from "node:test";
import assert from "node:assert/strict";

import {
  derivePrices, driftDecision, summaryHtml, summaryToText, toPublicPatterns,
  evaluatePatternAlert, explainPatternAlert, buildBody, buildHtml,
} from "./watcher.js";
import { ascendingTriangle } from "./patterns/fixtures/synth.js";

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

// --- SHADOW MODE: pattern detection -> public/data.json only -----------------

const PUBLIC_PATTERN_FIELDS = [
  "patternName", "confidence", "supportLevel", "resistanceLevel",
  "bullishBias", "bearishBias", "invalidationLevel",
];

test("toPublicPatterns maps a detected pattern to EXACTLY the 7 public fields (drops internal `details`)", () => {
  const stub = () => [{
    patternName: "Channel Up", confidence: 0.8, supportLevel: 127, resistanceLevel: 142,
    bullishBias: 0.65, bearishBias: 0.24, invalidationLevel: 127,
    details: { factors: {}, geometry: {}, resLine: {} }, // internal — must NOT leak
  }];
  const out = toPublicPatterns({ closes: [1] }, stub);
  assert.equal(out.length, 1);
  assert.deepEqual(Object.keys(out[0]).sort(), [...PUBLIC_PATTERN_FIELDS].sort());
  assert.equal("details" in out[0], false, "internal diagnostics never reach the feed");
});

test("toPublicPatterns fails SAFE to [] when the detector throws — it can never break the run", () => {
  const exploding = () => { throw new Error("detector bug"); };
  assert.deepEqual(toPublicPatterns({ closes: [1, 2, 3] }, exploding), []);
});

test("toPublicPatterns returns [] for a missing series (no spot price / failed fetch)", () => {
  assert.deepEqual(toPublicPatterns(null), []);
  assert.deepEqual(toPublicPatterns(undefined), []);
});

test("toPublicPatterns end-to-end: a real Ascending Triangle series yields a clean public pattern", () => {
  const out = toPublicPatterns(ascendingTriangle()); // uses the real detectPatterns
  assert.ok(out.length >= 1, "the fixture forms a detectable pattern");
  assert.equal(out[0].patternName, "Ascending Triangle");
  for (const k of PUBLIC_PATTERN_FIELDS) assert.ok(k in out[0], `missing ${k}`);
  assert.ok(out[0].confidence > 0 && out[0].confidence <= 1);
});

// --- Pattern alerts (opt-in, educational) ------------------------------------

const HOUR = 3_600_000;
const PATTERN = {
  patternName: "Rising Wedge", confidence: 0.9,
  supportLevel: 64000, resistanceLevel: 66000, invalidationLevel: 66000,
  bullishBias: 0.15, bearishBias: 0.66,
};
const ENABLED = { enabled: true, minConfidence: 0.75, cooldownHours: 12 };

test("pattern alerts are OFF by default — enabled:false never alerts", () => {
  assert.equal(evaluatePatternAlert([PATTERN], {}, { ...ENABLED, enabled: false }, 1000), null);
  assert.equal(evaluatePatternAlert([PATTERN], {}, undefined, 1000), null, "missing config -> off");
});

test("a pattern below minConfidence does not alert", () => {
  assert.equal(evaluatePatternAlert([{ ...PATTERN, confidence: 0.5 }], {}, ENABLED, 1000), null);
});

test("a high-confidence active pattern alerts when enabled", () => {
  const r = evaluatePatternAlert([PATTERN], {}, ENABLED, 1000);
  assert.equal(r?.patternName, "Rising Wedge");
});

test("a pattern missing any valid level (support/resistance/invalidation) does not alert", () => {
  for (const bad of [{ supportLevel: null }, { resistanceLevel: NaN }, { invalidationLevel: undefined }]) {
    assert.equal(evaluatePatternAlert([{ ...PATTERN, ...bad }], {}, ENABLED, 1000), null, JSON.stringify(bad));
  }
});

test("cooldown suppresses a repeat of the same coin+pattern within cooldownHours", () => {
  const now = 100 * HOUR;
  // alerted 6h ago, cooldown is 12h -> still muted
  assert.equal(evaluatePatternAlert([PATTERN], { "Rising Wedge": now - 6 * HOUR }, ENABLED, now), null);
  // alerted 13h ago -> past cooldown, alerts again
  assert.ok(evaluatePatternAlert([PATTERN], { "Rising Wedge": now - 13 * HOUR }, ENABLED, now));
  // a DIFFERENT pattern on the same coin is not muted by another's cooldown
  const other = { ...PATTERN, patternName: "Channel Up" };
  assert.ok(evaluatePatternAlert([other], { "Rising Wedge": now - 1 * HOUR }, ENABLED, now));
});

test("evaluatePatternAlert returns the HIGHEST-confidence eligible pattern", () => {
  const lo = { ...PATTERN, patternName: "Lo", confidence: 0.8 };
  const hi = { ...PATTERN, patternName: "Hi", confidence: 0.95 };
  assert.equal(evaluatePatternAlert([lo, hi], {}, ENABLED, 1000).patternName, "Hi");
});

// --- dry-run pattern-alert diagnostics ---------------------------------------

test("explainPatternAlert: no patterns -> empty breakdown, decision no", () => {
  const d = explainPatternAlert([], {}, ENABLED, 1000);
  assert.equal(d.count, 0);
  assert.equal(d.top, null);
  assert.equal(d.confidence, null);
  assert.equal(d.decision, false);
});

test("explainPatternAlert: an eligible pattern reports every flag true and decision YES", () => {
  const d = explainPatternAlert([PATTERN], {}, ENABLED, 1000);
  assert.equal(d.count, 1);
  assert.equal(d.top, "Rising Wedge");
  assert.equal(d.confidence, 0.9);
  assert.equal(d.enabled, true);
  assert.equal(d.passedMinConfidence, true);
  assert.equal(d.levelsValid, true);
  assert.equal(d.cooldownBlocked, false);
  assert.equal(d.decision, true);
});

test("explainPatternAlert: when disabled, the per-condition flags still describe the top pattern but decision is no", () => {
  const d = explainPatternAlert([PATTERN], {}, { ...ENABLED, enabled: false }, 1000);
  assert.equal(d.enabled, false);
  assert.equal(d.passedMinConfidence, true, "flags still reflect what WOULD pass");
  assert.equal(d.levelsValid, true);
  assert.equal(d.decision, false, "but a disabled config never alerts");
});

test("explainPatternAlert: a cooled-down pattern reports cooldownBlocked true and decision no", () => {
  const now = 100 * HOUR;
  const d = explainPatternAlert([PATTERN], { "Rising Wedge": now - 2 * HOUR }, ENABLED, now);
  assert.equal(d.cooldownBlocked, true);
  assert.equal(d.decision, false);
});

test("explainPatternAlert: a low-confidence pattern reports passedMinConfidence false", () => {
  const d = explainPatternAlert([{ ...PATTERN, confidence: 0.4 }], {}, ENABLED, 1000);
  assert.equal(d.passedMinConfidence, false);
  assert.equal(d.decision, false);
});

// --- email rendering: combination + safety -----------------------------------

const PA = { patternName: "Channel Up", confidence: 0.82, supportLevel: 64000, resistanceLevel: 66000, invalidationLevel: 64000 };
function priceAlert(extra = {}) {
  return {
    coin: "bitcoin", price: 65000, changePct: 2.0, driftPct: null, streak: null,
    reasons: ["+2.00% ბოლო შემოწმების შემდეგ (ზღვარი 1.5%)"],
    history: [{ t: 1000, p: 64000 }, { t: 2000, p: 65000 }],
    readout: null, analysis: null, prefilter: { pass: false, reason: "x" },
    ...extra,
  };
}

test("existing price-trigger alert still renders its reason and NO pattern block", () => {
  const body = buildBody([priceAlert()]);
  assert.match(body, /BITCOIN/);
  assert.match(body, /მიზეზი:/);
  assert.doesNotMatch(body, /Chart-structure observation/, "no pattern block when there is no pattern");
});

test("a coin with BOTH a price trigger and a pattern renders ONE combined card", () => {
  const body = buildBody([priceAlert({ patternAlert: PA })]);
  assert.equal((body.match(/BITCOIN —/g) || []).length, 1, "one card, not two");
  assert.match(body, /მიზეზი:.*ბოლო შემოწმების/, "keeps the price-trigger reason");
  assert.match(body, /Chart-structure observation/, "and adds the pattern observation");
  assert.match(body, /Channel Up/);
});

test("a pattern-only alert renders the educational block and NOT the 'analysis unavailable' line", () => {
  const body = buildBody([priceAlert({ reasons: [], patternAlert: PA })]);
  assert.match(body, /Chart-structure observation/);
  assert.doesNotMatch(body, /ანალიზი დროებით მიუწვდომელია/, "pattern-only cards skip the AI note");
  assert.match(body, /chart pattern observed/, "reason line marks the pattern observation");
});

test("pattern email uses the required educational framing and NO buy/sell instruction", () => {
  const body = buildBody([priceAlert({ reasons: [], patternAlert: PA })]);
  // the three required safety framings are present
  assert.match(body, /Worth checking/);
  assert.match(body, /Chart-structure observation/);
  assert.match(body, /Not a buy\/sell instruction/);
  // OUTSIDE the explicit disclaimer line, there is no buy/sell / action language
  const withoutDisclaimer = body.replace(/.*Not a buy\/sell instruction.*\n?/g, "");
  assert.doesNotMatch(withoutDisclaimer, /\b(buy|sell|long|short|target|leverage)\b/i, "no buy/sell language outside the disclaimer");
  // and no Georgian buy/sell IMPERATIVES anywhere
  assert.doesNotMatch(body, /(იყიდე|გაყიდე|შეიძინე|გაასხვისე)/);
});

test("the HTML email also combines into one card and carries the disclaimer", () => {
  const html = buildHtml([priceAlert({ patternAlert: PA })]);
  assert.equal((html.match(/BITCOIN/g) || []).length, 1, "one card");
  assert.match(html, /Chart-structure observation/);
  assert.match(html, /Not a buy\/sell instruction/);
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
