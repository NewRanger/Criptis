// Unit tests for the pure parseHeadlines helper in news.js.
// Run with:  node --test
// fetchNews does I/O and degrades to [] on any failure — not unit-tested here.

import test from "node:test";
import assert from "node:assert/strict";

import { parseHeadlines } from "./news.js";

const now = Date.parse("2021-01-02T00:00:00Z");
const DAY = 24 * 3_600_000;

test("parseHeadlines returns the top `limit` non-blank titles within the age window, in order", () => {
  const json = {
    results: [
      { title: "A", published_at: "2021-01-01T23:00:00Z" }, // 1h ago -> keep (1)
      { title: "   ", published_at: "2021-01-01T23:30:00Z" }, // blank -> skip
      { title: "B", published_at: "2021-01-01T22:00:00Z" }, // 2h ago -> keep (2)
      { title: "C", published_at: "2020-12-30T00:00:00Z" }, // 3 days ago -> drop (stale)
      { title: "D", published_at: "2021-01-01T21:00:00Z" }, // 3h ago -> keep (3) => limit hit
      { title: "E", published_at: "2021-01-01T20:00:00Z" }, // never reached
    ],
  };
  assert.deepEqual(parseHeadlines(json, { limit: 3, maxAgeMs: DAY, now }), ["A", "B", "D"]);
});

test("parseHeadlines without a time window just takes the first `limit` titles", () => {
  const json = { results: [{ title: "A" }, { title: "B" }, { title: "C" }] };
  assert.deepEqual(parseHeadlines(json, { limit: 2 }), ["A", "B"]);
});

test("parseHeadlines keeps a post with an unparseable date (recency unknown, not assumed stale)", () => {
  const json = { results: [{ title: "X", published_at: "not-a-date" }] };
  assert.deepEqual(parseHeadlines(json, { limit: 3, maxAgeMs: DAY, now }), ["X"]);
});

test("parseHeadlines falls back to created_at when published_at is absent", () => {
  const json = {
    results: [
      { title: "fresh", created_at: "2021-01-01T23:00:00Z" }, // within 24h -> keep
      { title: "old", created_at: "2020-01-01T00:00:00Z" }, // a year ago -> drop
    ],
  };
  assert.deepEqual(parseHeadlines(json, { limit: 3, maxAgeMs: DAY, now }), ["fresh"]);
});

test("parseHeadlines degrades on empty / missing / malformed bodies without throwing", () => {
  assert.deepEqual(parseHeadlines({ results: [] }), []);
  assert.deepEqual(parseHeadlines(undefined), []);
  assert.deepEqual(parseHeadlines({ results: "nope" }), []);
  assert.deepEqual(parseHeadlines({ results: [{ no: "title" }, { title: 42 }] }), []);
});
