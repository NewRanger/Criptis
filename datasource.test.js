// Unit tests for the pure helpers in datasource.js (Coinbase OHLCV).
// Run with:  node --test
// parseCandles + productFor are pure — no network. fetchSeries does I/O and is
// exercised manually (node watcher.js --dry-run), not here.

import test from "node:test";
import assert from "node:assert/strict";

import { parseCandles, productFor, COINBASE_PRODUCTS } from "./datasource.js";

const baseS = 1609459200; // 2021-01-01T00:00:00Z in SECONDS (Coinbase candle time unit)
const HOUR = 3600;

test("parseCandles sorts newest-first rows oldest-first, splits OHLCV, converts s->ms", () => {
  // Coinbase returns [ time(s), low, high, open, close, volume ], newest first.
  const rows = [
    [baseS + 2 * HOUR, 9, 11, 10, 10.5, 100],
    [baseS + 1 * HOUR, 8, 10, 9, 9.5, 90],
    [baseS, 7, 9, 8, 8.5, 80],
  ];

  const s = parseCandles(rows, { hours: 48 });

  assert.deepEqual(s.times, [baseS * 1000, (baseS + HOUR) * 1000, (baseS + 2 * HOUR) * 1000], "oldest-first, ms");
  assert.deepEqual(s.opens, [8, 9, 10]);
  assert.deepEqual(s.highs, [9, 10, 11]);
  assert.deepEqual(s.lows, [7, 8, 9]);
  assert.deepEqual(s.closes, [8.5, 9.5, 10.5], "closes.at(-1) is the latest close");
  assert.deepEqual(s.volumes, [80, 90, 100]);
});

test("parseCandles drops malformed rows (non-array, short, non-finite OHLC/time, non-positive close)", () => {
  const rows = [
    [baseS, 1, 2, 1.5, 1.8, 10], // the only valid candle
    "nope", // not an array
    [baseS + HOUR, 1, 2, 1.5], // too short
    [baseS + 2 * HOUR, 1, 2, 1.5, NaN, 5], // non-finite close
    [baseS + 3 * HOUR, 1, 2, 1.5, -3, 5], // non-positive close (would read as a bad price)
    [NaN, 1, 2, 1.5, 2, 5], // non-finite time
  ];

  const s = parseCandles(rows);
  assert.deepEqual(s.closes, [1.8], "only the single valid candle survives");
  assert.deepEqual(s.times, [baseS * 1000]);
});

test("parseCandles keeps a non-finite volume as null, never coerces it to 0", () => {
  const s = parseCandles([[baseS, 1, 2, 1.5, 1.8, "x"]]);
  assert.deepEqual(s.volumes, [null], "missing volume -> null (a 0 would fake 'no trading')");
  assert.deepEqual(s.closes, [1.8]);
});

test("parseCandles keeps only the most recent `hours` candles", () => {
  const rows = [];
  for (let i = 0; i < 60; i++) rows.push([baseS + i * HOUR, i, i + 2, i, i + 1, i]); // 60h, ascending here
  const s = parseCandles(rows, { hours: 48 });
  assert.equal(s.closes.length, 48, "trimmed to the last 48 hourly candles");
  assert.equal(s.times[0], (baseS + 12 * HOUR) * 1000, "first kept candle is 12h in (60 - 48)");
  assert.equal(s.closes.at(-1), 60, "last close is the newest candle's");
});

test("parseCandles degrades on empty / missing / non-array input without throwing", () => {
  assert.deepEqual(parseCandles([]), { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] });
  assert.deepEqual(parseCandles(undefined), { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] });
  assert.deepEqual(parseCandles({ not: "rows" }), { times: [], opens: [], highs: [], lows: [], closes: [], volumes: [] });
});

test("productFor maps known coins, honours an override, throws for an unmapped coin", () => {
  assert.equal(productFor("bitcoin"), "BTC-USD");
  assert.equal(productFor("ripple"), "XRP-USD", "config uses CoinGecko ids; ripple -> XRP-USD");
  assert.equal(productFor("bitcoin", "BTC-EUR"), "BTC-EUR", "explicit override wins");
  assert.throws(() => productFor("not-a-coin"), /no Coinbase product mapping/);
  // every coin in the default config.json must have a mapping
  for (const id of ["bitcoin", "ethereum", "solana", "ripple", "dogecoin"]) {
    assert.ok(COINBASE_PRODUCTS[id], `${id} is mapped`);
  }
});
