// signals.js — daily trade-signal evaluator (the decision layer)
//
// Turns the deterministic patterns/ detections + classic indicators into ONE
// regime-aware verdict per coin, for SELF-REVIEW. It computes a signal; it does
// NOT place orders and emits no advice for third parties.
//
// Invariants (same contract as the patterns/ layer — tests should enforce):
//   - Pure:        (series, opts) -> verdict object. No clock, randomness, I/O.
//   - Fails closed: insufficient/ambiguous data -> NEUTRAL, never throws.
//   - ATR-relative: every distance/threshold is in ATR units, so BTC and SOL
//                   share one set of constants (mirrors DEFAULTS in the detectors).
//   - Fixed schema: every result has exactly the fields in buildVerdict().
//   - Round with round3. Advisory-for-self-review only; never auto-executes.
//
// Reuses your DOCUMENTED primitives. VERIFY this import block against your real
// exports/paths — it is the only place a signature mismatch can bite.
import { detectPatterns } from "./patterns/index.js";
import { atr }            from "./patterns/atr.js";
import { findPivots }     from "./patterns/pivots.js";
import { volumeTrend }    from "./indicators.js";

// ---------------------------------------------------------------------------
// small pure utilities
// ---------------------------------------------------------------------------
const round3  = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);
const clamp   = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const clamp01 = (x) => clamp(x, 0, 1);
const last    = (a) => a[a.length - 1];
const isNum   = Number.isFinite;

export const VERDICTS = Object.freeze([
  "STRONG_SELL", "SELL", "WATCH", "NEUTRAL", "BUY", "STRONG_BUY",
]);
export const SEVERITY = Object.freeze({ HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", NONE: "NONE" });

export const DEFAULTS = Object.freeze({
  atrPeriod:   14,
  emaFast:      9,
  emaSlow:     21,
  emaTrend:    50,   // regime anchor — needs >= ~60 daily bars to be meaningful
  rsiPeriod:   14,
  bbPeriod:    20,
  bbK:          2,
  minBars:     60,   // fails closed below this
  minAgree:     3,   // "no single indicator is a signal" — the confluence gate
  minRR:      1.5,   // reject/duck setups with worse reward:risk than this
  stopAtr:    1.8,   // ATR-multiple stop when no structural level applies
  strongScore: 0.55, // |netScore| above this (+ gates) -> STRONG_*
  weakScore:   0.25, // |netScore| above this (+ gates) -> BUY/SELL; sub-gate -> WATCH
});

// Base importance of each directional factor before regime conditioning.
const BASE_WEIGHTS = Object.freeze({ pattern: 1.4, ema: 1.0, macd: 1.0, rsi: 0.9, bb: 0.9, sr: 1.0 });

// The actual "trader skill": the same factor means different things by regime.
// Multipliers applied on top of BASE_WEIGHTS, indexed [regime][factor].
const REGIME_WEIGHTS = Object.freeze({
  //         pattern ema  macd rsi  bb   sr
  bull:  { pattern: 1.0, ema: 1.2, macd: 1.1, rsi: 0.6, bb: 0.7, sr: 1.0 }, // ride trend, don't fade overbought
  bear:  { pattern: 1.0, ema: 1.2, macd: 1.1, rsi: 0.6, bb: 0.7, sr: 1.0 }, // mirror
  range: { pattern: 1.0, ema: 0.5, macd: 0.6, rsi: 1.2, bb: 1.2, sr: 1.2 }, // mean-reversion shines, breakouts are WATCH
});

// ---------------------------------------------------------------------------
// pure indicators (your indicators.js exposes Bollinger + volume, not these,
// so they live here, dependency-free)
// ---------------------------------------------------------------------------
function emaSeries(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period; // SMA seed
  const out = new Array(period - 1).fill(NaN);
  out.push(prev);
  for (let i = period; i < values.length; i++) { prev = values[i] * k + prev * (1 - k); out.push(prev); }
  return out;
}
const emaLast = (values, period) => { const s = emaSeries(values, period); return s.length ? last(s) : NaN; };

function rsiLast(closes, period) {
  if (closes.length <= period) return NaN;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) gain += d; else loss -= d; }
  let ag = gain / period, al = loss / period;                              // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function macdLast(closes, f = 12, s = 26, sig = 9) {
  if (closes.length < s + sig) return { macd: NaN, signal: NaN, hist: NaN };
  const ef = emaSeries(closes, f), es = emaSeries(closes, s);
  const line = closes.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : NaN)).filter(isNum);
  const sigSeries = emaSeries(line, sig);
  const macd = last(line), signal = last(sigSeries);
  return { macd, signal, hist: macd - signal };
}

// Bollinger %position of the last close in [-1..+1] (-1 = lower band, +1 = upper),
// plus current band width and the trailing-median width (for the volatility regime).
function bollinger(closes, period, k) {
  if (closes.length < period) return { pos: NaN, width: NaN, medWidth: NaN };
  const widthAt = (end) => {
    const w = closes.slice(end - period, end);
    const mid = w.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { mid, sd, width: 2 * k * sd };
  };
  const cur = widthAt(closes.length);
  const pos = cur.sd === 0 ? 0 : clamp((last(closes) - cur.mid) / (k * cur.sd), -1.5, 1.5);
  const lookback = Math.min(40, closes.length - period);
  const widths = [];
  for (let e = closes.length - lookback; e <= closes.length; e++) widths.push(widthAt(e).width);
  widths.sort((a, b) => a - b);
  return { pos, width: cur.width, medWidth: widths[Math.floor(widths.length / 2)] };
}

// ---------------------------------------------------------------------------
// regime
// ---------------------------------------------------------------------------
function detectRegime(closes, a, o) {
  const trendEma = emaSeries(closes, o.emaTrend);
  if (!trendEma.length) return { trend: "range", strength: 0, volState: "normal" };
  const lb = Math.min(10, trendEma.filter(isNum).length - 1);
  const slopeUp = last(trendEma) > trendEma[trendEma.length - 1 - lb];
  const above   = last(closes) > last(trendEma);
  const trend   = above && slopeUp ? "bull" : !above && !slopeUp ? "bear" : "range";
  const strength = a > 0 ? clamp01(Math.abs(last(closes) - last(trendEma)) / (3 * a)) : 0;

  const bb = bollinger(closes, o.bbPeriod, o.bbK);
  let volState = "normal";
  if (isNum(bb.width) && isNum(bb.medWidth) && bb.medWidth > 0) {
    if (bb.width < 0.8 * bb.medWidth) volState = "squeeze";
    else if (bb.width > 1.2 * bb.medWidth) volState = "expanded";
  }
  return { trend, strength: round3(strength), volState, _bbPos: bb.pos };
}

// ---------------------------------------------------------------------------
// directional factors — each returns a vote in [-1, +1] (+ = bullish)
// ---------------------------------------------------------------------------
function factorVotes(series, a, regime, o) {
  const { closes } = series;
  const votes = {};

  // pattern: top active match's net directional bias, scaled by its confidence
  const matches = safe(() => detectPatterns(series, {}), []);
  const top = matches && matches[0];
  votes.pattern = top ? clamp((top.bullishBias - top.bearishBias) * (top.confidence ?? 1), -1, 1) : 0;
  const patternRef = top || null;

  // RSI: mean-reversion sign (oversold bullish / overbought bearish)
  const rsi = rsiLast(closes, o.rsiPeriod);
  votes.rsi = isNum(rsi) ? clamp((50 - rsi) / 20, -1, 1) : 0;

  // MACD: histogram normalised by ATR
  const { hist } = macdLast(closes);
  votes.macd = isNum(hist) && a > 0 ? clamp(Math.tanh(hist / a), -1, 1) : 0;

  // EMA fast/slow separation in ATR units (trend-following)
  const ef = emaLast(closes, o.emaFast), es = emaLast(closes, o.emaSlow);
  votes.ema = isNum(ef) && isNum(es) && a > 0 ? clamp((ef - es) / a, -1, 1) : 0;

  // Bollinger position: at lower band -> bullish (mean reversion). Regime weights
  // down-weight this in trends, where a band-ride is continuation not reversal.
  votes.bb = isNum(regime._bbPos) ? clamp(-regime._bbPos, -1, 1) : 0;

  // Support/Resistance proximity from confirmed pivots, in ATR units
  votes.sr = supportResistanceVote(series, a, o);

  return { votes, patternRef };
}

function supportResistanceVote(series, a, o) {
  const piv = safe(() => findPivots(series, {}), null);
  if (!piv || a <= 0) return 0;
  const price = last(series.closes);
  const nearestBelow = (piv.lows  || []).map((p) => p.price).filter((v) => v <= price).sort((x, y) => y - x)[0];
  const nearestAbove = (piv.highs || []).map((p) => p.price).filter((v) => v >= price).sort((x, y) => x - y)[0];
  const dSup = isNum(nearestBelow) ? (price - nearestBelow) / a : Infinity; // bars of ATR to support
  const dRes = isNum(nearestAbove) ? (nearestAbove - price) / a : Infinity; // ... to resistance
  // close to support -> bullish bounce; close to resistance -> bearish rejection
  const near = (d) => clamp01(1 - d / 2);            // within ~2 ATR counts
  return clamp(near(dSup) - near(dRes), -1, 1);
}

// ---------------------------------------------------------------------------
// aggregation -> verdict
// ---------------------------------------------------------------------------
function aggregate(votes, regime) {
  const mult = REGIME_WEIGHTS[regime.trend];
  let num = 0, den = 0;
  const factors = [];
  for (const name of Object.keys(BASE_WEIGHTS)) {
    const w = BASE_WEIGHTS[name] * mult[name];
    const v = votes[name] ?? 0;
    num += v * w; den += w;
    factors.push({ name, vote: round3(v), weight: round3(w) });
  }
  const netScore = den > 0 ? clamp(num / den, -1, 1) : 0;
  const dir = Math.sign(netScore);
  const agreeing = factors.filter((f) => Math.sign(f.vote) === dir && Math.abs(f.vote) > 0.1).map((f) => f.name);
  return { netScore: round3(netScore), factors, confluence: { count: agreeing.length, agreeing } };
}

// Risk geometry: entry/stop/target in price, R:R as a number.
function riskGeometry(series, a, dir, patternRef, o) {
  const entry = last(series.closes);
  if (a <= 0 || dir === 0) return { entry: round3(entry), stop: null, target: null, riskReward: 0, direction: "flat" };
  const long = dir > 0;

  // stop: pattern invalidation on the correct side, else nearest structural level, else ATR multiple
  const piv = safe(() => findPivots(series, {}), null) || { highs: [], lows: [] };
  const below = (piv.lows  || []).map((p) => p.price).filter((v) => v < entry).sort((x, y) => y - x)[0];
  const above = (piv.highs || []).map((p) => p.price).filter((v) => v > entry).sort((x, y) => x - y)[0];

  let stop;
  if (patternRef && isNum(patternRef.invalidationLevel) &&
      ((long && patternRef.invalidationLevel < entry) || (!long && patternRef.invalidationLevel > entry))) {
    stop = patternRef.invalidationLevel;
  } else if (long && isNum(below))  stop = below;
  else if (!long && isNum(above))   stop = above;
  else stop = long ? entry - o.stopAtr * a : entry + o.stopAtr * a;

  // target: nearest opposing structure, else a minRR floor off the risk
  const risk = Math.abs(entry - stop);
  let target = long ? above : below;
  if (!isNum(target) || (long ? target <= entry : target >= entry)) {
    target = long ? entry + o.minRR * risk : entry - o.minRR * risk;
  }
  const riskReward = risk > 0 ? Math.abs(target - entry) / risk : 0;
  return { entry: round3(entry), stop: round3(stop), target: round3(target),
           riskReward: round3(riskReward), direction: long ? "long" : "short" };
}

function mapVerdict(net, conf, rr, regime, o) {
  const mag = Math.abs(net), dir = Math.sign(net);
  const gatesMet = conf.count >= o.minAgree && rr >= o.minRR;
  if (mag < o.weakScore) return "NEUTRAL";
  if (!gatesMet) return "WATCH";                                   // forming but a gate fails
  const aligned = (dir > 0 && regime.trend === "bull") || (dir < 0 && regime.trend === "bear");
  const canStrong = mag >= o.strongScore && (aligned || conf.count >= o.minAgree + 1);
  if (dir > 0) return canStrong ? "STRONG_BUY" : "BUY";
  return canStrong ? "STRONG_SELL" : "SELL";
}

function severityFor(verdict) {
  if (verdict === "STRONG_BUY" || verdict === "STRONG_SELL") return SEVERITY.HIGH;
  if (verdict === "BUY" || verdict === "SELL")               return SEVERITY.MEDIUM;
  if (verdict === "WATCH")                                   return SEVERITY.LOW;
  return SEVERITY.NONE;
}

function confidenceFor(net, conf, rr, volUp, o) {
  const scoreC = clamp01(Math.abs(net));
  const conflC = clamp01(conf.count / Object.keys(BASE_WEIGHTS).length);
  const rrC    = clamp01((rr - 1) / 2);                            // rr 1->0, rr 3->1
  let c = 0.45 * scoreC + 0.35 * conflC + 0.20 * rrC;
  if (volUp) c = clamp01(c + 0.05);                                // volume confirmation nudge
  return round3(c);
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------
export function evaluateSignal(series, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const coin = opts.coin ?? null;
  const asOf = series && series.times ? last(series.times) : null;

  if (!series || !Array.isArray(series.closes) || series.closes.length < o.minBars) {
    return buildVerdict({ coin, asOf, reason: "insufficient-data" });
  }
  const a = safe(() => atr(series, o.atrPeriod), NaN);
  if (!isNum(a) || a <= 0) return buildVerdict({ coin, asOf, reason: "no-atr" });

  const regime = detectRegime(series.closes, a, o);
  const { votes, patternRef } = factorVotes(series, a, regime, o);
  const agg = aggregate(votes, regime);
  const dir = Math.sign(agg.netScore);
  const risk = riskGeometry(series, a, dir, patternRef, o);
  const verdict = mapVerdict(agg.netScore, agg.confluence, risk.riskReward, regime, o);
  // volumeTrend() returns an object { ratio, rising, ... } (or null), NOT a number —
  // read the .rising flag; comparing the object to 0 (the original draft) was always false.
  const vt = safe(() => volumeTrend(series.volumes), null);
  const volUp = !!(vt && vt.rising);
  const reason = verdict !== "NEUTRAL" ? "ok"
    : agg.confluence.count < o.minAgree ? "low-confluence"
    : risk.riskReward < o.minRR ? "poor-rr" : "no-edge";

  return buildVerdict({
    coin, asOf, verdict,
    confidence: confidenceFor(agg.netScore, agg.confluence, risk.riskReward, volUp, o),
    netScore: agg.netScore,
    regime: { trend: regime.trend, strength: regime.strength, volState: regime.volState },
    confluence: agg.confluence,
    risk: { ...risk, volumeConfirms: volUp },
    factors: agg.factors,
    reason,
  });
}

// the one place the output schema is defined — every field, always present
function buildVerdict(p) {
  return {
    coin:       p.coin ?? null,
    asOf:       p.asOf ?? null,
    verdict:    p.verdict ?? "NEUTRAL",
    severity:   severityFor(p.verdict ?? "NEUTRAL"),
    confidence: p.confidence ?? 0,
    netScore:   p.netScore ?? 0,
    regime:     p.regime ?? { trend: "range", strength: 0, volState: "normal" },
    confluence: p.confluence ?? { count: 0, agreeing: [] },
    risk:       p.risk ?? { entry: null, stop: null, target: null, riskReward: 0, direction: "flat", volumeConfirms: false },
    factors:    p.factors ?? [],
    reason:     p.reason ?? "no-edge",
  };
}

// fails-closed wrapper: any throw from a reused primitive degrades to a fallback
function safe(fn, fallback) { try { const r = fn(); return r == null ? fallback : r; } catch { return fallback; } }

export default { evaluateSignal, VERDICTS, SEVERITY, DEFAULTS };
