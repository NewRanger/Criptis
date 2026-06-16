# `patterns/` — deterministic chart-pattern detection

A pure, dependency-free, **deterministic** layer that recognises chart patterns from
OHLCV candles. No LLM detects anything here: patterns are geometric objects over
swing points, so they are computed, not guessed. That makes every detection
reproducible, unit-testable, and — the whole point — **backtestable**. The LLM's
role inverts elsewhere in Criptis: it stops detecting and starts *explaining* a
pattern that arrives as structured data.

> **Status — Family A complete.** Primitives + all eight trendline-geometry
> patterns, each with an active-pattern containment gate. The swing-structure
> family (double/triple tops & bottoms, head & shoulders) is still to come. See
> [Scope](#scope) below.

## Design principle

Every tolerance is expressed in **ATR units**, never raw dollars or a fixed %.
A "0.5% wiggle" means something completely different for BTC vs DOGE; an
ATR-relative tolerance is self-normalising, so one set of thresholds works across
every coin. The whole layer **fails closed**: when the data can't support a
confident read it returns `[]`, mirroring `breakoutPrefilter()` in
[`../indicators.js`](../indicators.js).

## Architecture

```
series { times, opens, highs, lows, closes, volumes }   (48h hourly)
        │
        ▼  PRIMITIVES (pure, tested, reusable)
  atr.js          ─ ATR: the volatility unit for every tolerance
  pivots.js       ─ findPivots(): strict swing highs/lows + prominence filter
  trendlines.js   ─ fitLine(): (x,y) least-squares + R² + RMS residual
                    lineGeometry(): slopes, band width, convergence, apex
        │
        ▼  DETECTOR (Family A — trendline geometry)
  detectors/trendlinePatterns.js
        │   classify by (resistance slope, support slope, converging?)
        ▼
  confidence.js   ─ 5-factor composite, [0,1]
        │
        ▼
  index.js → detectPatterns(series) → PatternMatch[] (ranked by confidence)
```

## Output schema

Every match is exactly:

```js
{
  patternName,        // e.g. "Ascending Triangle"
  confidence,         // [0,1] composite (see below)
  supportLevel,       // USD — active support (fitted lower line at the latest bar)
  resistanceLevel,    // USD — active resistance (fitted upper line)
  bullishBias,        // [0,1] — upward lean (innate × confidence, bumped on a break)
  bearishBias,        // [0,1] — downward lean; independent of bullishBias by design
  invalidationLevel,  // USD — break of the line the read leans against (from real candles)
  details: { factors, geometry, touchesHigh, touchesLow, atr, resLine, supLine, span }
}
```

`bullishBias` and `bearishBias` are **independent** scores, not `1 − p`
complements — so a neutral pre-breakout shape can honestly report a weak lean on
both sides rather than being forced to pick a direction. `details` is diagnostic
(not part of the contract) and feeds the backtest and the dashboard.

## Family A — the eight trendline patterns

Fit one line through the pivot **highs** (resistance) and one through the pivot
**lows** (support), then classify by slope signs + convergence:

| resistance | support | band | → Pattern | bias | invalidation |
|---|---|---|---|---|---|
| flat | rising | converging | **Ascending Triangle** | bullish | support |
| falling | flat | converging | **Descending Triangle** | bearish | resistance |
| falling | rising | converging | **Symmetrical Triangle** | neutral | nearer edge¹ |
| rising | rising | converging | **Rising Wedge** | bearish | resistance |
| falling | falling | converging | **Falling Wedge** | bullish | support |
| rising | rising | parallel | **Channel Up** | bullish | support |
| falling | falling | parallel | **Channel Down** | bearish | resistance |
| flat | flat | parallel | **Rectangle** | neutral | nearer edge¹ |

Any other geometry (broadening/megaphone, ambiguous convergence, noise) returns
`null` — the detector refuses to label what it can't classify, which is what keeps
the false-positive rate down.

¹ Neutral patterns have no directional thesis, so the active-pattern gate keeps
them only while price is **contained between both lines**; a break of *either* side
resolves them. `invalidationLevel` surfaces the nearer edge (the line whose break
would most imminently end the consolidation).

## Active-pattern (containment) gate

Pivots exclude the most recent `pivotWidth` bars (confirmation lag), so the fitted
lines are **extrapolated** to the current bar. A pattern is reported only while
price is still contained:

- **Directional** patterns die only on a break in their *invalidation* direction
  (a favourable breakout is the thesis confirming, not invalidating).
- **Neutral** patterns die on a break of *either* line.

"Broken" means the close is past the line by more than `invalidationAtr` (0.5) ×
ATR. This prevents reporting e.g. a bullish Channel Up that price has already
fallen out of the bottom of.

## Geometry validity guards

Before a candidate is reported it must survive four guards (added after a live
Ripple "Rising Wedge" turned out to be a degenerate fit):

1. **No crossed/inverted envelope** — resistance must stay above support across the
   whole span, i.e. `widthStart > 0 && widthEnd > 0`. If the fitted lines cross
   inside the window, it isn't a containing envelope → reject.
2. **Future apex (converging patterns)** — the lines must meet *ahead* of the latest
   bar (`apexBar > xN`). A past/at apex means the structure already resolved.
3. **Stable convergence** — `convergenceRatio` is normalised by the *larger* band
   width, never by `widthStart` alone (which exploded to ~10.7 when the lines nearly
   met or crossed). Bounded, not a runaway.
4. **No two-point lines** — two pivots are trivially collinear, so a reported pattern
   needs `≥ minTouchesReport` (3) touches on **both** lines. A 2-touch candidate is
   fit internally but not reported.

Proximity scoring agrees with guard 2: a past apex scores **0** (resolved), not full
credit.

## Confidence model (5 factors)

`confidence` is a weighted mean of five sub-scores in `[0,1]`
([`confidence.js`](confidence.js)):

| factor | meaning | v1 weight |
|---|---|---|
| `fit` | how tightly touches sit on the line — **RMS residual ÷ ATR**, *not* R² | 0.25 |
| `touch` | number of trendline touches (2 → 4 ramps 0 → 1) | 0.20 |
| `symmetry` | geometric regularity (flatness + convergence, or parallelism + equal slopes) | 0.20 |
| `volume` | does volume behave as the archetype expects (contract for triangles, steady for channels) | 0.20 |
| `breakout` | proximity to the trigger (apex for triangles, boundary for channels) | 0.15 |

**Why residual-÷-ATR and not R²:** R² collapses toward 0 for near-flat lines (low
y-variance), which would wrongly punish a perfect horizontal ceiling. RMS residual
relative to ATR is scale-aware and works for flat and sloped lines alike.

**The weights are a documented prior, not measured truth.** The backtest's
calibration step is meant to replace them with weights fit to empirical hit-rate,
turning `confidence` into an actual probability. A missing factor (e.g. no volume
data) drops out and the remaining weights renormalise.

## Determinism guarantees (enforced by tests)

- **Pure** — input is candles + opts; no clock, no randomness, no I/O. Same input ⇒ identical output.
- **Scale invariance** — ×k on all prices keeps the pattern and confidence, scales the levels. (`atr` and residuals scale together; slopes and ratios are scale-free.)
- **Mirror symmetry** — reflecting prices flips a pattern to its directional mirror (Channel Up ↔ Channel Down, Ascending ↔ Descending) and flips the bias.
- **Confirmation lag** — a pivot needs `width` bars on each side, so bars within `width` of either end are never pivots. The backtest replay must honour the same lag (no look-ahead).

## Files

| File | Purpose |
|---|---|
| `atr.js` | Average True Range — the volatility unit |
| `pivots.js` | `findPivots()` — strict swing highs/lows + ATR prominence filter |
| `trendlines.js` | `fitLine()`, `lineValue()`, `lineGeometry()` |
| `detectors/trendlinePatterns.js` | Family-A classifier (the 4 Phase-1 patterns) |
| `confidence.js` | 5-factor confidence sub-scores + composite |
| `index.js` | `detectPatterns()` orchestrator (public entry point) |
| `fixtures/synth.js` | deterministic synthetic candle builders (the fixture library) |
| `fixtures/*.json` | committed snapshots of the builders, for inspection |
| `fixtures/build-fixtures.mjs` | regenerates the JSON snapshots |
| `*.test.js` | unit + property tests (`node --test`) |

## Running

```bash
# unit + property tests
node --test patterns/atr.test.js patterns/pivots.test.js patterns/trendlines.test.js \
            patterns/confidence.test.js patterns/trendlinePatterns.test.js

# regenerate the JSON fixture snapshots from synth.js
node patterns/fixtures/build-fixtures.mjs
```

```js
import { detectPatterns } from "./patterns/index.js";
const matches = detectPatterns(series); // ranked, highest confidence first
```

## Scope

**Implemented:** `atr`, `findPivots`, `fitLine`, `lineGeometry`, all **eight**
Family-A trendline patterns above (each with the active-pattern gate), unit +
property + negative-control tests, fixtures, and this doc. Wired into
[`../watcher.js`](../watcher.js) in **shadow mode** — published to
`public/data.json` for the dashboard only; it does not gate alerts, the email, or
the LLM prompt.

**Deliberately not yet built:**

- Swing-structure family: Double/Triple Top & Bottom, Head & Shoulders, Inverse H&S.
- The prompt change that turns `patternName`/`invalidationLevel` from LLM *outputs*
  into LLM *inputs*.
- The **backtest harness** (`backtest/`) that calibrates `confidence` against
  forward outcomes.

The 48h hourly window is the right production default but a thin sample for the
higher-order patterns (Head & Shoulders, triple tops need ~5+ ordered pivots); the
detectors are timeframe-parametric and will run on daily candles once longer
history is wired in.
