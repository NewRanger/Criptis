// datasource.js — fetch a clean, uniformly-spaced OHLCV series (ESM, Node >=20).
//
// WHY THIS EXISTS: the watcher needs professional-grade market data — true OHLC
// candles with volume, uniformly spaced — to ground both the deterministic
// triggers and the descriptive readout. We pull it fresh each run from an
// exchange klines API so every run gets clean, gap-free, hourly data and a bad
// fetch just fails that run instead of poisoning a stored history.
//
// DATA SOURCE: Coinbase Exchange public API (free, no key, US-runner-safe):
//   GET https://api.exchange.coinbase.com/products/{PAIR}/candles?granularity=3600
//   -> up to 300 rows of [ time(s), low, high, open, close, volume ], NEWEST first.
//   granularity=3600 => true 1-hour candles aligned to the UTC hour, so (unlike
//   CoinGecko's 5-min market_chart) no resampling is needed: we validate, convert
//   the timestamp seconds->ms, sort oldest-first, and keep the most recent `hours`.
//   Binance has wider alt coverage but may 451 from some GitHub-hosted runners.
//
// config.json lists coins by their CoinGecko id (bitcoin, ethereum, …) for
// continuity; COINBASE_PRODUCTS maps each to its Coinbase USD pair. A coin with
// no mapping (or a failed fetch) throws here and is SKIPPED by the caller — its
// price is never fabricated as 0.

const COINBASE = "https://api.exchange.coinbase.com";

// CoinGecko id -> Coinbase USD product. Extend as coins are added to config.json.
export const COINBASE_PRODUCTS = {
  bitcoin: "BTC-USD",
  ethereum: "ETH-USD",
  solana: "SOL-USD",
  ripple: "XRP-USD",
  dogecoin: "DOGE-USD",
  cardano: "ADA-USD",
  litecoin: "LTC-USD",
  chainlink: "LINK-USD",
  "avalanche-2": "AVAX-USD",
  polkadot: "DOT-USD",
};

// Resolve a coin id to its Coinbase product, allowing an explicit override.
// Throws (loudly) for an unmapped coin so the gap is visible in the logs and the
// caller skips that coin rather than silently dropping or zeroing it.
export function productFor(coinId, override) {
  if (override) return override;
  const product = COINBASE_PRODUCTS[coinId];
  if (!product) {
    throw new Error(`no Coinbase product mapping for "${coinId}" — add it to COINBASE_PRODUCTS`);
  }
  return product;
}

// Pure + testable: turn a Coinbase /candles payload into aligned, validated OHLCV
// arrays, oldest-first. Each row is [ time(seconds), low, high, open, close, volume ].
// Drops any row that isn't a 6-tuple, has a non-finite OHLC/time, or a non-positive
// close — so one bad candle can never reach the indicators or be read as a price.
// Timestamps are converted to ms (the rest of the app works in ms). A non-finite
// volume becomes null (kept, never coerced to 0). Keeps the most recent `hours`.
export function parseCandles(rows, { hours = 48 } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const candles = [];
  for (const row of list) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [t, low, high, open, close, volume] = row;
    if (![t, low, high, open, close].every(Number.isFinite) || close <= 0) continue;
    candles.push({
      t: t * 1000,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Number.isFinite(volume) ? volume : null,
    });
  }
  candles.sort((a, b) => a.t - b.t); // oldest-first, so closes.at(-1) is the latest
  const kept = hours > 0 ? candles.slice(-hours) : candles;
  return {
    times: kept.map((c) => c.t),
    opens: kept.map((c) => c.o),
    highs: kept.map((c) => c.h),
    lows: kept.map((c) => c.l),
    closes: kept.map((c) => c.c),
    volumes: kept.map((c) => c.v),
  };
}

// Fetch one coin's recent OHLCV candles from Coinbase. Retries once (the price
// this returns now feeds the triggers, so a single transient blip shouldn't fail
// the run), then throws so a real data outage is loud — the caller treats that as
// "no price this run" and skips the coin instead of inventing a 0. Returns the
// normalized { times, opens, highs, lows, closes, volumes } plus { coinId, product,
// last } where last is the most recent close.
export async function fetchSeries(
  coinId,
  { hours = 48, timeoutMs = 15000, product, minPoints = 1, retries = 1 } = {},
) {
  const pair = productFor(coinId, product);
  const url = `${COINBASE}/products/${encodeURIComponent(pair)}/candles?granularity=3600`;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "criptis", Accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const rows = await res.json();
      const series = parseCandles(rows, { hours });
      if (series.closes.length < minPoints) {
        throw new Error(`only ${series.closes.length} valid hourly candle(s) (need ${minPoints})`);
      }
      return { coinId, product: pair, last: series.closes.at(-1), ...series };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  throw new Error(`Coinbase ${pair}: ${lastErr.message}`);
}
