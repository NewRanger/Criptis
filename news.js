// news.js — pull a few recent crypto news headlines from CryptoPanic (ESM, Node >=20).
//
// Optional context for the analysis layer. The free CryptoPanic API needs an auth
// token (CRYPTOPANIC_API_KEY). News is strictly NICE-TO-HAVE: a missing key or any
// failure returns an empty array and NEVER throws, so the watcher's prices, triggers
// and email keep working untouched whether or not news is available.
//
// API: GET https://cryptopanic.com/api/v1/posts/?auth_token=KEY&public=true&kind=news
//   -> { results: [ { title, published_at, ... } ] }, most-recent first.
// We keep the top `limit` text headlines published within the last `maxAgeHours`.

const CRYPTOPANIC = "https://cryptopanic.com/api/v1/posts/";

// Pure + testable: pick the top `limit` headline strings from a CryptoPanic body,
// optionally dropping any post older than `maxAgeMs` (measured against `now`).
// A post with no usable text title is skipped; the published timestamp falls back
// to created_at, and a post with no parseable date is kept (recency unknown, not
// assumed stale) so a malformed date can't silently empty the list.
export function parseHeadlines(json, { limit = 3, maxAgeMs, now } = {}) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const headlines = [];
  for (const post of results) {
    const title = typeof post?.title === "string" ? post.title.trim() : "";
    if (!title) continue;
    if (maxAgeMs != null && now != null) {
      const published = Date.parse(post?.published_at ?? post?.created_at ?? "");
      if (Number.isFinite(published) && now - published > maxAgeMs) continue;
    }
    headlines.push(title);
    if (headlines.length >= limit) break;
  }
  return headlines;
}

// Fetch recent crypto news headlines. Returns string[] (empty on a missing key or
// any error). Never throws — callers can await it unconditionally.
export async function fetchNews({
  limit = 3,
  maxAgeHours = 24,
  timeoutMs = 15000,
  apiKey = process.env.CRYPTOPANIC_API_KEY,
  now = Date.now(),
} = {}) {
  if (!apiKey) {
    console.warn("CRYPTOPANIC_API_KEY not set — continuing with no news");
    return [];
  }
  try {
    const url =
      `${CRYPTOPANIC}?auth_token=${encodeURIComponent(apiKey)}` + "&public=true&kind=news";
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    return parseHeadlines(json, { limit, maxAgeMs: maxAgeHours * 3_600_000, now });
  } catch (err) {
    console.error(`CryptoPanic fetch failed — continuing with no news: ${err.message}`);
    return [];
  }
}
