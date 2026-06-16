// patterns/fixtures/synth.js — deterministic synthetic candle builders.
//
// Each function returns a full { times, opens, highs, lows, closes, volumes }
// series that forms exactly ONE archetypal pattern, with NO randomness and NO
// clock — the geometry IS the documentation, and the output is byte-stable. These
// builders are the fixture library: the unit tests import them directly, and
// build-fixtures.mjs snapshots them to JSON in this folder for inspection.
//
// Construction: price zig-zags between an upper and lower envelope, touching the
// upper line at `highIdx` bars and the lower line at `lowIdx` bars. Phantom
// turning points just outside [0, n-1] make the first/last real pivots strict
// local extrema, so findPivots confirms them.

const T0 = 1_700_000_000_000; // fixed epoch (ms) — deterministic, no Date.now
const HOUR = 3_600_000;

function zigzag({ n = 48, upper, lower, highIdx, lowIdx, spread = 0.5, volFn = () => 1000 }) {
  // Alternating control points (o = 1 at a high touch, 0 at a low touch), plus a
  // phantom before the first and after the last that continue the zig-zag so the
  // boundary pivots turn over (and are therefore strict extrema).
  const ctrl = [
    ...highIdx.map((i) => ({ i, o: 1 })),
    ...lowIdx.map((i) => ({ i, o: 0 })),
  ].sort((a, b) => a.i - b.i);
  const first = ctrl[0], second = ctrl[1];
  const last = ctrl[ctrl.length - 1], prev = ctrl[ctrl.length - 2];
  const ext = [
    { i: first.i - (second.i - first.i), o: second.o },
    ...ctrl,
    { i: last.i + (last.i - prev.i), o: prev.o },
  ];

  const oAt = (x) => {
    if (x <= ext[0].i) return ext[0].o;
    if (x >= ext[ext.length - 1].i) return ext[ext.length - 1].o;
    for (let k = 0; k < ext.length - 1; k++) {
      const A = ext[k], B = ext[k + 1];
      if (x >= A.i && x <= B.i) return A.o + ((x - A.i) / (B.i - A.i)) * (B.o - A.o);
    }
    return 0.5;
  };
  const u = (x) => upper.slope * x + upper.intercept;
  const l = (x) => lower.slope * x + lower.intercept;
  const midAt = (x) => l(x) + oAt(x) * (u(x) - l(x));

  const series = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  for (let i = 0; i < n; i++) {
    const mid = midAt(i);
    series.times.push(T0 + i * HOUR);
    series.opens.push(mid);     // doji bodies; only highs/lows/closes drive detection
    series.closes.push(mid);
    series.highs.push(mid + spread);
    series.lows.push(mid - spread);
    series.volumes.push(volFn(i));
  }
  return series;
}

// Volume profiles: contracting through a triangle's formation, steady in a channel.
const contracting = (i, n = 48) => Math.round(1200 - (i / (n - 1)) * 700); // 1200 -> 500
const steady = () => 1000;

const HIGH_IDX = [6, 18, 30, 42];
const LOW_IDX = [12, 24, 36];

// Flat resistance at 140, support rising from ~104 toward it: converging, bullish.
export const ascendingTriangle = () =>
  zigzag({
    upper: { slope: 0, intercept: 140 },
    lower: { slope: 0.7, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: contracting,
  });

// Falling resistance from 140, flat support at 104: converging, bearish.
export const descendingTriangle = () =>
  zigzag({
    upper: { slope: -0.7, intercept: 140 },
    lower: { slope: 0, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: contracting,
  });

// Both envelopes rising in parallel (constant 14-wide band): Channel Up.
export const channelUp = () =>
  zigzag({
    upper: { slope: 0.5, intercept: 118 },
    lower: { slope: 0.5, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: steady,
  });

// Both envelopes falling in parallel: Channel Down (mirror of Channel Up).
export const channelDown = () =>
  zigzag({
    upper: { slope: -0.5, intercept: 141.5 },
    lower: { slope: -0.5, intercept: 127.5 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: steady,
  });

// Falling resistance + rising support, converging with balanced slopes:
// Symmetrical Triangle (neutral — resolves on whichever side breaks first).
export const symmetricalTriangle = () =>
  zigzag({
    upper: { slope: -0.35, intercept: 140 },
    lower: { slope: 0.35, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: contracting,
  });

// Both envelopes flat and parallel: a Rectangle (neutral range).
export const rectangle = () =>
  zigzag({
    upper: { slope: 0, intercept: 130 },
    lower: { slope: 0, intercept: 120 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: steady,
  });

// Both lines rising but the lower line rising FASTER, so the band converges upward:
// Rising Wedge (bearish).
export const risingWedge = () =>
  zigzag({
    upper: { slope: 0.3, intercept: 122 },
    lower: { slope: 0.6, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: contracting,
  });

// Both lines falling but the upper line falling FASTER, so the band converges down:
// Falling Wedge (bullish) — mirror of the Rising Wedge.
export const fallingWedge = () =>
  zigzag({
    upper: { slope: -0.6, intercept: 136 },
    lower: { slope: -0.3, intercept: 118 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: contracting,
  });

// --- Negative controls: geometry the detector must REFUSE ---

// Rising resistance + falling support => the band WIDENS (a broadening / megaphone).
// Not in the catalogue: convergenceRatio is negative, so classify() returns null.
export const broadening = () =>
  zigzag({
    upper: { slope: 0.4, intercept: 116 },
    lower: { slope: -0.4, intercept: 104 },
    highIdx: HIGH_IDX, lowIdx: LOW_IDX, volFn: steady,
  });

// Deterministic pseudo-random walk (seeded LCG — no Math.random, fully repeatable).
// Pivots scatter, so no clean trendline fits / the geometry is ambiguous => [].
export function noise(seed = 12345, n = 48) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const series = { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] };
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += (rand() - 0.5) * 6; // step in (-3, 3)
    const wick = 0.3 + rand() * 0.6;
    series.times.push(T0 + i * HOUR);
    series.opens.push(price);
    series.closes.push(price);
    series.highs.push(price + wick);
    series.lows.push(price - wick);
    series.volumes.push(900 + Math.round(rand() * 200));
  }
  return series;
}

// Overwrite the latest candle of a series with a flat doji at `price`. The last
// bar is inside the pivot confirmation lag, so this changes the current close
// WITHOUT moving any confirmed pivot or the fitted trendlines — exactly the live
// situation where price breaks out of a channel in the final, unconfirmed bars.
function setLastClose(series, price) {
  const i = series.closes.length - 1;
  series.opens[i] = price;
  series.closes[i] = price;
  series.highs[i] = price + 0.5;
  series.lows[i] = price - 0.5;
  return series;
}

// A rising channel whose LATEST close has broken far BELOW the lower line (~127 at
// the last bar): the geometry is still Channel Up, but the pattern is already
// invalidated and must NOT be reported. (Mirrors the live bitcoin dry-run case.)
export const invalidatedChannelUp = () => setLastClose(channelUp(), 100);

// A falling channel whose LATEST close has broken far ABOVE the upper line (~118.5
// at the last bar): still Channel Down geometry, but invalidated — must not report.
export const invalidatedChannelDown = () => setLastClose(channelDown(), 145);

export { zigzag, setLastClose };
