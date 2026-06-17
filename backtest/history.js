// backtest/history.js — fetch a LONG candle history from Coinbase (paginated) + cache.
//
// Coinbase returns at most 300 candles per request, so deep history needs many
// time-windowed calls walked backward from now. This is the only I/O in the
// backtest; the replay/calibrate layers are pure. Results are cached under
// backtest/cache/ (gitignored) so a calibration run is repeatable without re-fetching.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { productFor, parseCandles, COINBASE_GRANULARITIES } from "../datasource.js";

const COINBASE = "https://api.exchange.coinbase.com";
const PER_CALL = 300; // Coinbase hard cap per /candles request
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.join(__dirname, "cache");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function cachePath(coinId, granularity) {
  return path.join(CACHE_DIR, `${coinId}-${granularity}.json`);
}

// Fetch ~`totalCandles` of history at `granularity` (seconds), oldest-first.
// Windows are walked backward from now, deduped by timestamp, then normalized.
export async function fetchHistory(
  coinId,
  { granularity = 3600, totalCandles = 8760, product, timeoutMs = 20000, delayMs = 400, retries = 2 } = {},
) {
  if (!COINBASE_GRANULARITIES.has(granularity)) {
    throw new Error(`unsupported Coinbase granularity ${granularity}s — use one of ${[...COINBASE_GRANULARITIES].join(", ")}`);
  }
  const pair = productFor(coinId, product);
  const windows = Math.ceil(totalCandles / PER_CALL);
  const nowSec = Math.floor(Date.now() / 1000);
  const byTime = new Map(); // time(sec) -> raw row, dedupes window overlaps

  for (let k = 0; k < windows; k++) {
    const endSec = nowSec - k * PER_CALL * granularity;
    const startSec = endSec - PER_CALL * granularity;
    const url =
      `${COINBASE}/products/${encodeURIComponent(pair)}/candles?granularity=${granularity}` +
      `&start=${new Date(startSec * 1000).toISOString()}&end=${new Date(endSec * 1000).toISOString()}`;

    let rows = null, lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { "User-Agent": "criptis-backtest", Accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status === 429) throw new Error("rate-limited (429)");
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        rows = await res.json();
        break;
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(delayMs * (err.message.includes("429") ? 4 : 2));
      }
    }
    if (!Array.isArray(rows)) {
      console.error(`  ${pair} window ${k + 1}/${windows} failed: ${lastErr?.message ?? "no data"}`);
      continue;
    }
    for (const row of rows) if (Array.isArray(row) && Number.isFinite(row[0])) byTime.set(row[0], row);
    process.stdout.write(`\r  ${pair}: ${byTime.size} candles (${k + 1}/${windows} windows)…   `);
    await sleep(delayMs);
  }
  process.stdout.write("\n");

  const series = parseCandles([...byTime.values()], { limit: totalCandles });
  if (!series.closes.length) throw new Error(`no candles fetched for ${pair}`);
  return { coinId, product: pair, granularity, ...series };
}

export function saveCache(history) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = cachePath(history.coinId, history.granularity);
  fs.writeFileSync(p, JSON.stringify(history));
  return p;
}

export function loadCache(coinId, granularity) {
  const p = cachePath(coinId, granularity);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
