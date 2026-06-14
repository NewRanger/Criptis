// Unit tests for resampleHourly in datasource.js.
// Run with:  node --test
// Pure helper — no network. parseMarketChart is exercised indirectly; its own
// behaviour is unchanged by the resample work.

import test from "node:test";
import assert from "node:assert/strict";

import { resampleHourly } from "./datasource.js";

const MIN = 60_000;
const base = 1609459200000; // 2021-01-01T00:00:00.000Z — exactly on a UTC hour boundary

test("resampleHourly collapses a multi-hour 5-min series to one point per UTC hour (last close/volume)", () => {
  // Two full hours of 5-min points plus a partial third hour. Each point gets a
  // unique close (100+i) and volume (1000+i) so "last in the hour" is verifiable
  // and a sum would be obviously wrong.
  const times = [], closes = [], volumes = [];
  let i = 0;
  const push = (m) => { times.push(base + m * MIN); closes.push(100 + i); volumes.push(1000 + i); i++; };
  for (let m = 0;   m < 60;   m += 5) push(m); // hour 0: 12 pts (0..55)
  for (let m = 60;  m < 120;  m += 5) push(m); // hour 1: 12 pts (60..115)
  for (let m = 120; m <= 125; m += 5) push(m); // hour 2 (partial): 2 pts (120, 125)

  const r = resampleHourly(times, closes, volumes);

  assert.equal(r.closes.length, 3, "three UTC hours -> three points");
  assert.deepEqual(r.closes, [111, 123, 125], "close = LAST price in each hour");
  assert.deepEqual(r.volumes, [1011, 1023, 1025], "volume = LAST value in each hour (not a sum)");
  assert.deepEqual(r.times, [base + 55 * MIN, base + 115 * MIN, base + 125 * MIN], "time = last point's timestamp");
  assert.ok(r.times[0] < r.times[1] && r.times[1] < r.times[2], "output stays chronological");
});

test("resampleHourly: partial final hour yields just its last point", () => {
  const times  = [base, base + 30 * MIN, base + 59 * MIN, base + 65 * MIN]; // hour 0 x3, hour 1 x1
  const closes = [10, 11, 12, 99];
  const volumes = [1, 2, 3, 9];
  const r = resampleHourly(times, closes, volumes);
  assert.equal(r.closes.length, 2);
  assert.deepEqual(r.closes, [12, 99], "first hour -> its last close; partial hour -> its lone point");
  assert.deepEqual(r.volumes, [3, 9]);
});

test("resampleHourly carries the last reading even when it is null, and never sums", () => {
  const times   = [base, base + 10 * MIN, base + 20 * MIN]; // all in hour 0
  const closes  = [10, 11, 12];
  const volumes = [5, null, null]; // last reading in the hour is null
  const r = resampleHourly(times, closes, volumes);
  assert.deepEqual(r.closes, [12]);
  assert.deepEqual(r.volumes, [null], "carries the last value (null), not a sum of 5");
});

test("resampleHourly degrades on empty / missing / single-point input without throwing", () => {
  assert.deepEqual(resampleHourly([], [], []), { times: [], closes: [], volumes: [] });
  assert.deepEqual(resampleHourly(undefined, undefined, undefined), { times: [], closes: [], volumes: [] });
  assert.deepEqual(resampleHourly([base], [42], [7]), { times: [base], closes: [42], volumes: [7] });
});

test("resampleHourly skips non-finite timestamps", () => {
  const times   = [base, NaN, base + 30 * MIN];
  const closes  = [10, 999, 12];
  const volumes = [1, 999, 3];
  const r = resampleHourly(times, closes, volumes);
  assert.deepEqual(r.closes, [12], "the NaN-timestamped row is dropped, hour 0 keeps its last valid point");
  assert.deepEqual(r.volumes, [3]);
});
