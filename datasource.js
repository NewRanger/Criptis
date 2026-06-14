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
//     days=1   -> ~289 points at 5-MINUTE spacing, includes volume   <-- used here
//     days>=2  -> DAILY points only (multi-day hourly is paid)
//   We pull days=1, then resampleHourly() collapses it to ~24 hourly points:
//   readout()'s periods (RSI 14, Bollinger 20, EMAs, regression) are meant to
//   span hours, so on the raw 5-min grid they'd only cover the last ~1-2 hours
//   and momentum would be %/5min, not %/hr. If you need more lookback or
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

// Resample a dense intra-hour series to one point per UTC hour. CoinGecko's
// market_chart days=1 returns ~289 points at 5-minute spacing; readout()'s
// periods (RSI 14, Bollinger 20, the EMAs, the regression) are meant to span
// hours, so we collapse each clock hour to its LAST reading. For each UTC hour:
//   close  = the last price in the hour
//   volume = the last volume in the hour — NOT a sum: CoinGecko's total_volumes
//            is a rolling 24h figure, so adjacent 5-min readings nearly repeat
//            and summing would massively double-count.
//   time   = that last point's timestamp (so a partial final hour just yields
//            its latest point).
// Pure; output is chronological. Degrades to empty arrays on empty/missing input.
export function resampleHourly(times, closes, volumes) {
  const ts = Array.isArray(times) ? times : [];
  const cs = Array.isArray(closes) ? closes : [];
  const vs = Array.isArray(volumes) ? volumes : [];
  const byHour = new Map(); // hourIndex -> { t, c, v } of the latest point seen in that hour
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    if (!Number.isFinite(t)) continue;
    const hour = Math.floor(t / 3_600_000);
    const prev = byHour.get(hour);
    if (!prev || t >= prev.t) byHour.set(hour, { t, c: cs[i], v: vs[i] ?? null });
  }
  const times2 = [], closes2 = [], volumes2 = [];
  for (const hour of [...byHour.keys()].sort((a, b) => a - b)) {
    const b = byHour.get(hour);
    times2.push(b.t);
    closes2.push(b.c);
    volumes2.push(b.v ?? null);
  }
  return { times: times2, closes: closes2, volumes: volumes2 };
}

// Fetch one coin's recent series and resample it to hourly. Throws (loudly) on
// HTTP error or if too few valid hourly points came back — so a data outage
// fails the run instead of silently looking like "nothing happened".
export async function fetchSeries(coinId, { days = 1, timeoutMs = 15000, demoKey, minPoints = 5 } = {}) {
  const url = `${CG}/coins/${encodeURIComponent(coinId)}/market_chart?vs_currency=usd&days=${days}`;
  const headers = demoKey ? { "x-cg-demo-api-key": demoKey } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`CoinGecko ${coinId}: HTTP ${res.status} ${res.statusText}`);
  const json = await res.json();
  // Parse the raw 5-minute payload, then collapse to one point per UTC hour so
  // the indicators read over hours, not minutes (see resampleHourly).
  const raw = parseMarketChart(json);
  const series = resampleHourly(raw.times, raw.closes, raw.volumes);
  if (series.closes.length < minPoints) {
    throw new Error(`CoinGecko ${coinId}: only ${series.closes.length} valid hourly points (need ${minPoints})`);
  }
  return { coinId, last: series.closes[series.closes.length - 1], ...series };
}
