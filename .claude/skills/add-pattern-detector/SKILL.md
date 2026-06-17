---
name: add-pattern-detector
description: Add a new deterministic chart-pattern detector to the patterns/ layer (detector + synthetic fixture + tests + Georgian email copy). Use when adding a chart pattern such as Double Top/Bottom, Triple Top/Bottom, Head & Shoulders, Inverse H&S, or any new geometry the detector should recognise. Family A (the eight trendline-geometry patterns) is already complete; this is mainly for the swing-structure family.
---

# Add a chart-pattern detector

The `patterns/` layer is **pure, deterministic, dependency-free** chart-pattern
detection over OHLCV candles. No LLM detects anything — patterns are geometric
objects, computed not guessed, so every detection is reproducible, unit-testable
and backtestable. Read [patterns/README.md](../../../patterns/README.md) first;
it is the spec.

A new pattern almost always belongs to a **new family** (swing-structure:
Double/Triple Top & Bottom, Head & Shoulders, Inverse H&S). Family A — the eight
trendline-geometry patterns — is complete, so a new *trendline* variant usually
means editing `classify()` in
[patterns/detectors/trendlinePatterns.js](../../../patterns/detectors/trendlinePatterns.js),
while a swing-structure pattern means a **new detector file**.

## Non-negotiable invariants (tests enforce these)

- **Pure** — input is `(series, opts)` only. No clock, no randomness, no I/O.
  Same input ⇒ byte-identical output. (Do **not** use `Date.now()` or
  `Math.random()` anywhere, including fixtures — use the fixed `T0` epoch and the
  seeded LCG already in `synth.js`.)
- **Fails closed** — return `[]` (never throw) whenever the data can't support a
  confident read. Mirror `breakoutPrefilter()` in `indicators.js`.
- **ATR-relative tolerances** — every threshold is expressed in **ATR units**
  (via `atr()`), never raw dollars or a fixed %. This self-normalises across BTC
  vs DOGE. See `DEFAULTS` in the trendline detector for the pattern.
- **Exact output schema** — each match is exactly these 7 public fields plus a
  diagnostic `details`:
  ```js
  { patternName, confidence, supportLevel, resistanceLevel,
    bullishBias, bearishBias, invalidationLevel, details }
  ```
  `bullishBias` and `bearishBias` are **independent** scores in `[0,1]` (NOT
  `1 − p` complements). Round confidence/biases with the `round3` helper.
- **Determinism guarantees** the test suite checks for every pattern: scale
  invariance (×k prices → same pattern + confidence, scaled levels), mirror
  symmetry (reflected prices flip to the directional mirror + flipped bias),
  confirmation lag (no look-ahead — pivots exclude the last `width` bars).

## Reusable primitives — build on these, don't reinvent

- `atr(series, period)` — the volatility unit ([patterns/atr.js](../../../patterns/atr.js)).
- `findPivots(series, opts)` → `{ highs, lows, atr }`, each pivot `{ idx, t, price }`
  ([patterns/pivots.js](../../../patterns/pivots.js)). Swing-structure patterns are
  built from the ordered sequence of these pivots.
- `fitLine`, `lineValue`, `lineGeometry` ([patterns/trendlines.js](../../../patterns/trendlines.js))
  for any line work (e.g. a neckline).
- `confidence.js` — `scoreFit`, `scoreTouch`, `scoreVolume`, `composite`,
  `clamp01`, `DEFAULT_WEIGHTS`. The composite renormalises over present factors,
  so an absent factor (e.g. no volume) drops out cleanly.
- `volumeTrend(series.volumes)` from [indicators.js](../../../indicators.js).

## Steps

1. **Write the detector** — new family ⇒ `patterns/detectors/<name>.js`
   exporting `detect<Name>(series, opts = {})`. Follow
   `detectTrendlinePatterns()` as the template: guard for enough bars, compute
   ATR, find pivots, classify the geometry, run validity guards, apply the
   **active-pattern (containment) gate** (a pattern price has already broken out
   of in its invalidation direction is dead — return `[]`), compute the 5 (or
   pattern-appropriate) confidence factors, and return the schema object(s).

2. **Wire it into the orchestrator** — in
   [patterns/index.js](../../../patterns/index.js), import the new detector and
   concatenate its matches inside `detectPatterns()`:
   ```js
   const matches = [...detectTrendlinePatterns(series, opts), ...detectMyPattern(series, opts)];
   ```
   The return contract (ranked by confidence, highest first) does not change.
   Re-export the new symbols at the bottom of the file alongside the others.

3. **Add a deterministic fixture builder** — in
   [patterns/fixtures/synth.js](../../../patterns/fixtures/synth.js), export a
   builder that returns a full `{ times, opens, highs, lows, closes, volumes }`
   series forming exactly ONE instance of the pattern. Use the fixed `T0`/`HOUR`
   constants; for any "randomness" use the seeded LCG already in `noise()`.
   Add **negative controls** too (a near-miss the detector must refuse) and, where
   relevant, an `invalidated…` variant via `setLastClose()` (moves only the last,
   unconfirmed bar — exactly the live "broke out in the final bars" case).

4. **Register & regenerate JSON snapshots** — add the builder to
   [patterns/fixtures/build-fixtures.mjs](../../../patterns/fixtures/build-fixtures.mjs),
   then regenerate the committed inspection snapshots:
   ```bash
   node patterns/fixtures/build-fixtures.mjs
   ```

5. **Write tests** — add a `patterns/<name>.test.js` (or extend an existing one)
   mirroring [patterns/trendlinePatterns.test.js](../../../patterns/trendlinePatterns.test.js):
   positive detection (name, bias direction, invalidation level, full schema with
   finite numbers), negative controls (broadening/noise/near-miss → `[]`),
   the active-pattern gate, fails-closed on too little data, and the property
   tests (scale invariance, mirror symmetry). Run:
   ```bash
   node --test
   ```
   Run the whole suite — `index.js`, `watcher.js` and the dashboard all consume
   this layer.

6. **Add beginner-friendly Georgian email copy** — the pattern surfaces in the
   dashboard automatically (shadow mode), but the **email** renders pattern copy
   from `PATTERN_COPY` in [watcher.js](../../../watcher.js). Add an entry keyed by
   the exact `patternName` with: `ka` (Georgian name), `dir` (`"bull"` / `"bear"`
   / `"neutral"`, which selects `ZONE_COPY`), and a one-sentence Georgian `trend`
   description. Write the Georgian per the project's translation rules — standard
   trading terminology (`მხარდაჭერა` / `წინააღმდეგობა`), modern literary Georgian,
   no calques/barbarisms, concise; descriptive only, never advisory, no buy/sell
   language. Without an entry it silently falls back to `PATTERN_FALLBACK` (generic
   copy), which is a regression in user experience.

7. **Update the docs** — extend the catalogue table / Scope section in
   [patterns/README.md](../../../patterns/README.md) so the doc still matches the
   code.

## Verify, then hand off

- `node --test` is green and `public/data.json` regenerates cleanly via
  `node watcher.js --dry-run`.
- Use [/preview-alert](../preview-alert/SKILL.md) to see the new pattern's card
  rendered in the email.
- **Do not commit or push** — this repo's owner always commits themselves.
  Summarise what changed and let them review and commit.
