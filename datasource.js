// datasource.js — fetch a clean, uniformly-spaced price + volume series (ESM, Node >=20).
//
// WHY THIS EXISTS: the old approach self-built a sparse series by appending one
// spot price every ~2h. That made the triggers assume uniform spacing (which
// GitHub cron does not guarantee) and let a bad fetch poison the stored history.
// Pulling a dense series fresh each run fixes both: every run gets clean,
// uniformly-spaced, gap-free data, and a bad fetch just fails that run.
//
// DATA SOURCE NOTE (verify against current docs from your runner):
//   CoinGecko free tier, /coins/{id}/market_chart auto-granularity:
//     days=1   -> hourly points (~24-25), includes volume   <-- used here
//     days>=2  -> DAILY points only (multi-day hourly is paid)
//   So we pull days=1 for a dense recent window. If you need more lookback or
//   true OHLC candles, swap fetchSeries for an exchange klines API (Coinbase
//   api.exchange.coinbase.com/products/{pair}/candles is free, no key, and
//   US-runner-safe; Binance has wider alt coverage but may 451 from some
//   GitHub-hosted runners). The rest of the app only consumes the normalized
//   { times, closes, volumes, last } shape, so the swap is local to this file.

const CG = "https://api.coingecko.com/api/v3";

// Pure + testable: turn a market_chart payload into aligned, validated arrays.
// Drops any point with a non-finite timestamp or a non-positive price so one
// bad row can never reach the indicators.
export function parseMarketChart(json) {
  const prices = Array.isArray(json?.prices) ? json.prices : [];
  const vols = Array.isArray(json?.total_volumes) ? json.total_volumes : [];
  const volByT = new Map();
  for (const row of vols) {
    if (Array.isArray(row) && row.length >= 2 && Number.isFinite(row[0])) {
      volByT.set(row[0], row[1]);
    }
  }
  const times = [], closes = [], volumes = [];
  for (const row of prices) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const [t, p] = row;
    if (!Number.isFinite(t) || !Number.isFinite(p) || p <= 0) continue;
    times.push(t);
    closes.push(p);
    const v = volByT.get(t);
    volumes.push(Number.isFinite(v) ? v : null);
  }
  return { times, closes, volumes };
}

// Fetch one coin's recent series. Throws (loudly) on HTTP error or if too few
// valid points came back — so a data outage fails the run instead of silently
// looking like "nothing happened".
export async function fetchSeries(coinId, { days = 1, timeoutMs = 15000, demoKey, minPoints = 5 } = {}) {
  const url = `${CG}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`;
  const headers = demoKey ? { "x-cg-demo-api-key": demoKey } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CoinGecko ${coinId}: HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  const series = parseMarketChart(json);
  if (series.closes.length < minPoints) {
    throw new Error(`CoinGecko ${coinId}: only ${series.closes.length} valid points (need ${minPoints})`);
  }
  return { coinId, last: series.closes[series.closes.length - 1], ...series };
}
