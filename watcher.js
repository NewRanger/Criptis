#!/usr/bin/env node
// Criptis — crypto price watcher. Runs on GitHub Actions every 1h, alerts via Resend email.
// Deterministic triggers decide WHEN to alert; the LLM only writes the analysis paragraph.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fetchSeries } from "./datasource.js";
import { fetchNews } from "./news.js";
import { readout, breakoutPrefilter } from "./indicators.js";
import { detectPatterns } from "./patterns/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const DATA_PATH = path.join(__dirname, "public", "data.json");
const PROMPT_PATH = path.join(__dirname, "prompts", "analysis.md");

const HISTORY_LIMIT = 48; // price points kept per coin (~48h at a 1h cadence)
const HOUR = 3_600_000;
const DRIFT_MIN_AGE_HOURS = 18; // youngest point allowed as the "~24h ago" reference
const DRIFT_REARM = 0.8; // drift-latch hysteresis: re-arm once |drift| eases below threshold*this (1.0 = none)

// --- CLI flags ---------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const mockIdx = args.indexOf("--mock-price");
const mockPrice = mockIdx === -1 ? null : Number(args[mockIdx + 1]);
if (mockIdx !== -1 && !Number.isFinite(mockPrice)) {
  console.error("--mock-price requires a number, e.g. --mock-price 65000");
  process.exit(1);
}

// --- Config & state ----------------------------------------------------------

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = config.coins ?? ["bitcoin"];
// Each price/drift/streak trigger is active ONLY when its config value is a finite
// number; set it to null (or remove the key) to PAUSE that trigger. With all three
// paused, only the opt-in pattern alerts below can raise an email. (streakLength
// additionally needs >= 2 to mean anything, so 0/1/null all read as paused.)
const changeThresholdPct = Number.isFinite(config.changeThresholdPct) ? config.changeThresholdPct : null;
const driftThresholdPct = Number.isFinite(config.driftThresholdPct) ? config.driftThresholdPct : null;
const streakLength = Number.isFinite(config.streakLength) ? config.streakLength : null; // consecutive same-direction checks that flag a trend; null/<2 = paused

// Optional pattern-alert path — DISABLED by default. A detected chart pattern can
// raise an educational "worth checking" email only when explicitly enabled and the
// match clears minConfidence; the same coin+pattern is then muted for cooldownHours.
// `enabled` is true ONLY when literally set to true, so a missing/garbled value
// stays off. This path never gates or weakens the price/drift/streak triggers.
const patternAlertsCfg = {
  enabled: config.patternAlerts?.enabled === true,
  minConfidence: Number.isFinite(config.patternAlerts?.minConfidence) ? config.patternAlerts.minConfidence : 0.75,
  cooldownHours: Number.isFinite(config.patternAlerts?.cooldownHours) ? config.patternAlerts.cooldownHours : 12,
};

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    if (state && typeof state.coins === "object") return state;
  } catch {
    // first run, missing or corrupt file — start fresh
  }
  return { coins: {} };
}

// --- Formatting --------------------------------------------------------------

const pct = (from, to) => ((to - from) / from) * 100;
const fmtPct = (n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const fmtPrice = (n) =>
  n >= 1
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${n.toPrecision(4)}`;
const fmtTime = (t) => new Date(t).toISOString().slice(0, 16).replace("T", " ") + " UTC";

// One-line summary of an enrichment readout's headline metrics. DESCRIPTIVE only
// (direction / RSI / %B / momentum / volume) — shared by the plain-text email and
// the LLM prompt so both are grounded in the same numbers. Skips fields the
// indicators couldn't compute (short history -> some are null).
function readoutMetrics(r) {
  const parts = [`direction ${r.direction}`];
  if (r.rsi != null) parts.push(`RSI ${r.rsi.toFixed(0)}`);
  if (r.pctB != null) parts.push(`%B ${Math.round(r.pctB * 100)}%`);
  // "/hr" label is accurate because the series is hourly Coinbase candles (granularity=3600).
  if (r.momentumPctPerStep != null) parts.push(`momentum ${fmtPct(r.momentumPctPerStep)}/hr`);
  if (r.volume) parts.push(`volume ${r.volume.rising ? "rising" : "easing"}`);
  return parts.join(" · ");
}

// Count the run of consecutive same-direction moves ending at the current price.
// `len` is the number of moves (so len === 5 means six prices, five steps up/down);
// `dir` is +1 / -1 / 0 (0 = flat or not enough data); `netPct` is the move across
// the whole run. A flat or zig-zag market alternates sign and never builds a run.
function trendStreak(history, price) {
  const seq = [...history.map((p) => p.p), price];
  if (seq.length < 2) return { len: 0, dir: 0, netPct: 0 };
  const dir = Math.sign(seq.at(-1) - seq.at(-2));
  if (dir === 0) return { len: 0, dir: 0, netPct: 0 };
  let len = 1;
  for (let i = seq.length - 2; i > 0; i--) {
    if (Math.sign(seq[i] - seq[i - 1]) !== dir) break;
    len++;
  }
  return { len, dir, netPct: pct(seq[seq.length - 1 - len], price) };
}

// Edge-trigger decision for the drift signal. drift compares vs a ~24h-ago
// reference, so a move that crosses the threshold and HOLDS would otherwise
// re-fire every run for ~24h (unlike rate-based change or fire-once streak).
// `dir` is the over-threshold sign (0 while within threshold); it fires only when
// that sign differs from the latched `prevDir` — so a sustained move alerts once
// and a genuine reversal (sign flip) re-fires. The latch holds through a
// hysteresis band and re-arms (nextDir 0) only once |drift| eases below
// threshold*reArm. Pure — no I/O, no state — so the rule is unit-testable.
export function driftDecision(driftPct, threshold, prevDir, reArm) {
  const dir = Math.abs(driftPct) > threshold ? Math.sign(driftPct) : 0;
  const fire = dir !== 0 && dir !== prevDir;
  let nextDir;
  if (dir !== 0) nextDir = dir;                                  // over threshold — latch this direction
  else if (Math.abs(driftPct) < threshold * reArm) nextDir = 0;  // eased below the re-arm band — re-arm
  else nextDir = prevDir;                                        // inside the hysteresis band — stay latched
  return { fire, nextDir };
}

// --- Market data: OHLCV (Coinbase) + news (CryptoPanic) -----------------------

// Derive the spot price per coin from the gathered OHLCV — the latest close.
// A price counts only if it's a finite, positive number; a coin missing from the
// OHLCV map (a failed/unmapped fetch) or carrying a bad last close lands in
// `skipped` rather than an undefined/0 that would become a fake move downstream
// and poison the rolling history. Pure — mirrors the old parsePrices contract.
export function derivePrices(ohlcv, ids) {
  const prices = {};
  const skipped = [];
  for (const id of ids) {
    const last = ohlcv?.[id]?.last;
    if (Number.isFinite(last) && last > 0) prices[id] = last;
    else skipped.push(id);
  }
  return { prices, skipped };
}

// Gather all market data for the run BEFORE any trigger is evaluated: 48h of true
// hourly OHLCV per coin (Coinbase) and a few recent news headlines (CryptoPanic).
// Returns { ohlcv: { coinId -> series }, news: string[] } held for the run so the
// SAME data feeds the triggers, the (upcoming) pre-filter, the descriptive readout
// and the analyze() LLM payload — each coin's candles are fetched exactly once.
//
// Resilience: OHLCV and news are fetched concurrently. fetchNews never rejects; a
// coin whose OHLCV fetch fails is OMITTED from `ohlcv` (logged, never stored as 0)
// so derivePrices later skips it. Mock mode synthesizes a flat price and skips the
// network entirely so `--dry-run --mock-price` stays fully offline.
async function gatherMarket(coins) {
  if (mockPrice !== null) {
    console.log(`Mock mode: using ${fmtPrice(mockPrice)} for all coins, skipping Coinbase + news`);
    const ohlcv = {};
    for (const coin of coins) {
      ohlcv[coin] = {
        coinId: coin,
        last: mockPrice,
        times: [], opens: [], highs: [], lows: [], closes: [], volumes: [],
      };
    }
    return { ohlcv, news: [] };
  }

  const [news, ...seriesResults] = await Promise.all([
    fetchNews(),
    ...coins.map((coin) =>
      fetchSeries(coin, { hours: HISTORY_LIMIT }).then(
        (series) => ({ coin, series }),
        (err) => {
          console.error(`Coinbase OHLCV for ${coin} failed — skipped: ${err.message}`);
          return { coin, series: null };
        },
      ),
    ),
  ]);

  const ohlcv = {};
  for (const { coin, series } of seriesResults) if (series) ohlcv[coin] = series;
  console.log(`News: ${news.length ? `${news.length} headline(s)` : "none"}`);
  return { ohlcv, news };
}

// --- Analysis (Anthropic; failure must never block the email) -----------------

// Forced-tool schema for the analysis. Claude is REQUIRED to call this tool, so
// the watcher always gets strict, parseable JSON back — never free-form prose to
// scrape. The shape is fixed; see prompts/analysis.md for how each field is filled.
const ANALYSIS_TOOL = {
  name: "report_analysis",
  description: "Report the structured technical analysis for this one coin. Always call this tool.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      patternFound: {
        type: "boolean",
        description: "Whether a recognizable chart/candlestick pattern or clear price-action structure is present.",
      },
      patternName: {
        type: "string",
        description: 'Short plain name of the pattern (e.g. "Bollinger breakout", "bull flag"); empty string "" if none.',
      },
      bias: {
        type: "string",
        enum: ["Bullish", "Bearish", "Neutral"],
        description: "Directional read implied by the evidence.",
      },
      invalidationLevel: {
        type: "number",
        description: "Exact USD price at which this read is proven wrong (the setup fails). Derived from the candles, not invented.",
      },
      georgianSummary: {
        type: "string",
        description:
          "Beginner-friendly Georgian analysis as an HTML string: EXACTLY three <br>•-prefixed bullets with <strong> labels, per the system prompt. Only <br> and <strong> tags.",
      },
    },
    required: ["patternFound", "patternName", "bias", "invalidationLevel", "georgianSummary"],
  },
};

// Analyze ONE coin that cleared the breakout pre-filter. Receives the coin's alert
// data (with its full 48h OHLC candle array) and the shared news headlines, forces
// Claude through ANALYSIS_TOOL, and returns the validated object
// { patternFound, patternName, bias, invalidationLevel, georgianSummary } — or null
// if the key is unset or the call fails (the email still goes out with raw numbers).
async function analyze(coinData, news = []) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — sending raw numbers only");
    return null;
  }
  const system = fs.readFileSync(PROMPT_PATH, "utf8");
  const a = coinData;
  // Recent news headlines, passed forward as context when present. Empty (no key
  // / fetch failed) => omitted entirely, so the payload is unchanged in that case.
  const newsBlock = news.length
    ? "# Recent crypto news headlines (last 24h)\n" + news.map((h) => `- ${h}`).join("\n") + "\n\n"
    : "";
  const drift = a.driftPct === null ? "" : `, ${fmtPct(a.driftPct)} vs ~24h ago`;
  // Descriptive technical readout from the dense hourly series (null if the
  // enrichment failed). Ground the paragraph in these numbers; the system prompt
  // still forbids predictions / buy-sell advice.
  const indicators = a.readout
    ? [
        `indicators (descriptive, from a dense hourly series): ${a.readout.summary}`,
        `  ${readoutMetrics(a.readout)}${a.readout.r2 != null ? ` · R² ${a.readout.r2.toFixed(2)} (${a.readout.cleanliness})` : ""}`,
      ].join("\n")
    : "indicators: unavailable for this coin";
  // Why this coin earned an analysis: the mathematical breakout the pre-filter
  // confirmed. Surfaced as data the paragraph can lean on (volume credibility,
  // how stretched the move is) — facts, not an instruction to predict.
  const pf = a.prefilter;
  const breakoutLine =
    pf && pf.pass
      ? `breakout pre-filter: confirmed ${pf.breakout} breakout — latest close ${fmtPrice(pf.close)} ` +
        `${pf.breakout === "up" ? "above the upper" : "below the lower"} Bollinger band (20-period, 2σ; ` +
        `band ${fmtPrice(pf.lower)}–${fmtPrice(pf.upper)}) on ${pf.volumeRatio.toFixed(2)}x the 24h average volume`
      : null;
  // Full hourly OHLC candle array (oldest first) — the 48h Coinbase series.
  const times = a.series?.times ?? [];
  const candles = times
    .map(
      (t, i) =>
        `${fmtTime(t)}  O ${fmtPrice(a.series.opens[i])}  H ${fmtPrice(a.series.highs[i])}  ` +
        `L ${fmtPrice(a.series.lows[i])}  C ${fmtPrice(a.series.closes[i])}`,
    )
    .join("\n");
  const userMsg =
    newsBlock +
    [
      `## ${a.coin}`,
      `current: ${fmtPrice(a.price)} (${fmtPct(a.changePct)} since last check${drift})`,
      `triggered by: ${a.reasons.join("; ")}`,
      ...(breakoutLine ? [breakoutLine] : []),
      indicators,
      `hourly OHLC candles, oldest first (~1h apart):`,
      candles,
    ].join("\n");

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system,
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "tool", name: ANALYSIS_TOOL.name },
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    // Forced tool use -> the analysis is the input of the tool_use block, already
    // structured. Validate the one field the UI can't do without (georgianSummary)
    // and normalize the rest, so a malformed reply falls back to raw numbers.
    const out = (data.content ?? []).find((b) => b.type === "tool_use" && b.name === ANALYSIS_TOOL.name)?.input;
    if (!out || typeof out.georgianSummary !== "string" || !out.georgianSummary.trim()) {
      throw new Error("forced tool call returned no usable analysis");
    }
    return {
      patternFound: Boolean(out.patternFound),
      patternName: typeof out.patternName === "string" ? out.patternName : "",
      bias: ["Bullish", "Bearish", "Neutral"].includes(out.bias) ? out.bias : "Neutral",
      invalidationLevel: Number.isFinite(out.invalidationLevel) ? out.invalidationLevel : null,
      georgianSummary: out.georgianSummary.trim(),
    };
  } catch (err) {
    console.error(`Anthropic call failed — sending raw numbers only: ${err.message}`);
    return null;
  }
}

// --- Pattern detection (SHADOW MODE) ------------------------------------------

// Run the deterministic chart-pattern detector over a coin's OHLCV series and map
// each hit to the public 7-field schema (dropping the internal `details`). This is
// SHADOW MODE: the result is published to public/data.json for the dashboard ONLY.
// It does NOT influence the alert triggers, the email, or the LLM prompt — pattern
// detection never decides whether the user is notified. Always fails safe to []: a
// missing series or any detector error yields [] and never throws, so this can
// never break the run. `detect` is injectable for tests.
export function toPublicPatterns(series, detect = detectPatterns) {
  if (!series) return [];
  try {
    return detect(series).map((p) => ({
      patternName: p.patternName,
      confidence: p.confidence,
      supportLevel: p.supportLevel,
      resistanceLevel: p.resistanceLevel,
      bullishBias: p.bullishBias,
      bearishBias: p.bearishBias,
      invalidationLevel: p.invalidationLevel,
    }));
  } catch (err) {
    console.error(`Pattern detection failed — patterns []: ${err.message}`);
    return [];
  }
}

// --- Pattern alerts (opt-in, educational) -------------------------------------

// Decide whether a coin's detected patterns warrant an educational pattern alert.
// PURE + testable: given the coin's ACTIVE patterns (public shape — detectPatterns
// already drops invalidated ones, so anything here is active), its per-pattern
// cooldown record, the config and `now`, returns the single highest-confidence
// ELIGIBLE pattern, or null. A pattern is eligible only when: alerts are enabled,
// confidence >= minConfidence, all three levels are finite numbers, and the same
// coin+patternName has NOT alerted within cooldownHours. Never throws.
export function evaluatePatternAlert(patterns, cooldowns, cfg, now) {
  if (!cfg || cfg.enabled !== true) return null;
  const minConfidence = Number.isFinite(cfg.minConfidence) ? cfg.minConfidence : 0.75;
  const cooldownMs = (Number.isFinite(cfg.cooldownHours) ? cfg.cooldownHours : 12) * HOUR;
  const ranked = [...(patterns ?? [])].sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0));
  for (const p of ranked) {
    if (!Number.isFinite(p?.confidence) || p.confidence < minConfidence) continue;
    if (![p.supportLevel, p.resistanceLevel, p.invalidationLevel].every(Number.isFinite)) continue;
    const last = cooldowns?.[p.patternName];
    if (Number.isFinite(last) && now - last < cooldownMs) continue; // still cooling down
    return p;
  }
  return null;
}

// PURE diagnostics for --dry-run: a per-coin breakdown of why the top (highest-
// confidence) pattern would or wouldn't raise an educational alert. The condition
// flags describe the top pattern; `decision` is the authoritative call from
// evaluatePatternAlert (reused here), so this can never diverge from real behaviour.
// Read-only — printed in dry-run only, never affects alerts.
export function explainPatternAlert(patterns, cooldowns, cfg, now) {
  const list = [...(patterns ?? [])].sort((a, b) => (b?.confidence ?? 0) - (a?.confidence ?? 0));
  const top = list[0] ?? null;
  const minConfidence = Number.isFinite(cfg?.minConfidence) ? cfg.minConfidence : 0.75;
  const cooldownMs = (Number.isFinite(cfg?.cooldownHours) ? cfg.cooldownHours : 12) * HOUR;
  const last = top ? cooldowns?.[top.patternName] : undefined;
  return {
    count: list.length,
    top: top?.patternName ?? null,
    confidence: Number.isFinite(top?.confidence) ? top.confidence : null,
    enabled: cfg?.enabled === true,
    passedMinConfidence: !!top && Number.isFinite(top.confidence) && top.confidence >= minConfidence,
    levelsValid: !!top && [top.supportLevel, top.resistanceLevel, top.invalidationLevel].every(Number.isFinite),
    cooldownBlocked: !!top && Number.isFinite(last) && now - last < cooldownMs,
    decision: evaluatePatternAlert(patterns, cooldowns, cfg, now) !== null,
  };
}

// --- Notification (Resend) -----------------------------------------------------

export function headline(a) {
  // A pattern-only alert (no price/drift/streak reason, just a chart pattern) gets a
  // CHART-PATTERN subject so it doesn't masquerade as a price move. A coin that ALSO
  // has a price/drift/streak reason keeps the price-style subject below.
  if (!a.reasons?.length && a.patternAlert) {
    return `📊 ${a.coin} ${a.patternAlert.patternName} · ${fmtPrice(a.price)}`;
  }
  // Lead with whichever signal is largest in magnitude: a slow 24h bleed or a
  // multi-check trend can matter more than the latest 1h tick (which may be ~0).
  const candidates = [{ move: a.changePct, window: "1h" }];
  if (a.driftPct !== null) candidates.push({ move: a.driftPct, window: "24h" });
  if (a.streak) candidates.push({ move: a.streak.netPct, window: `${a.streak.len} შემოწმება` });
  const top = candidates.reduce((b, c) => (Math.abs(c.move) > Math.abs(b.move) ? c : b));
  return `${top.move >= 0 ? "\u{1F4C8}" : "\u{1F4C9}"} ${a.coin} ${fmtPrice(a.price)} (${fmtPct(top.move)} ${top.window})`;
}

// Georgian, beginner-friendly note for a coin that triggered but did NOT clear
// the breakout pre-filter — so it gets raw numbers with no AI paragraph.
const STRUCTURAL_NOTE =
  "ℹ️ სტრუქტურული შეტყობინება: ფასმა ზღვარი გადააჭარბა, მაგრამ ძლიერი „გარღვევა“ " +
  "(ფასი Bollinger-ის ზოლის გარეთ + მკვეთრად გაზრდილი მოცულობა) არ დადასტურდა, " +
  "ამიტომ დეტალური AI ანალიზი არ მომზადებულა — იხ. ციფრები ზემოთ.";

// bias -> pill colour + Georgian label. Green for up, red for down, grey neutral.
const BIAS = {
  Bullish: { label: "ზრდადი", bg: "#0ecb81", fg: "#fff" },
  Bearish: { label: "კლებადი", bg: "#f6465d", fg: "#fff" },
  Neutral: { label: "ნეიტრალური", bg: "#2b3139", fg: "#d6dae0" },
};
const biasStyle = (bias) => BIAS[bias] ?? BIAS.Neutral;

// georgianSummary comes back as an HTML string (only <br> and <strong>). For the
// plain-text body, turn <br> into newlines and drop the <strong> tags.
export const summaryToText = (s) =>
  String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?strong>/gi, "")
    .replace(/^\n+/, "")
    .trim();

// The per-coin analysis tail (plain text): the AI analysis if the coin passed the
// pre-filter and the call succeeded; the structural note if it didn't qualify;
// otherwise (passed but the AI call failed/unset) the temporary-unavailable line.
function bodyAnalysis(a) {
  if (a.analysis) {
    return `ანალიზი — ტენდენცია: ${biasStyle(a.analysis.bias).label}\n${summaryToText(a.analysis.georgianSummary)}`;
  }
  if (a.prefilter && !a.prefilter.pass) return STRUCTURAL_NOTE;
  return "ანალიზი დროებით მიუწვდომელია (AI-ს გამოძახება ვერ შესრულდა) — იხ. ციფრები ზემოთ.";
}

// Pattern-observed reason line for a coin whose ONLY trigger is a chart pattern.
const PATTERN_REASON = "📊 გრაფიკული ფიგურა შენიშნულია (chart pattern observed)";

// Beginner-friendly Georgian copy per pattern: a Georgian name and a one-sentence
// "what this trend means". `dir` (bull/bear/neutral) selects the zone + invalidation
// guidance below, so each pattern reads in plain language, not dry labels.
const PATTERN_COPY = {
  "Ascending Triangle":   { ka: "აღმავალი სამკუთხედი", dir: "bull",
    trend: "ფასი ქვედა ხაზიდან თანდათან მაღლა იწევს, ზედა ზღვარს კი ერთსა და იმავე დონეზე აწყდება — ხშირად ზრდისთვის მზადების ნიშანია." },
  "Descending Triangle":  { ka: "დაღმავალი სამკუთხედი", dir: "bear",
    trend: "ფასი ზედა ხაზიდან თანდათან ქვემოთ ეშვება, ქვედა ზღვარს კი ერთსა და იმავე დონეზე ეყრდნობა — ხშირად კლებისთვის მზადების ნიშანია." },
  "Symmetrical Triangle": { ka: "სიმეტრიული სამკუთხედი", dir: "neutral",
    trend: "ფასის რყევები თანდათან მცირდება და ორ ხაზს შორის იკუმშება — მიმართულება ჯერ გაურკვეველია და გარღვევას ელოდება." },
  "Rising Wedge":         { ka: "აღმავალი სოლი", dir: "bear",
    trend: "ფასი მაღლა იწევს, მაგრამ რყევები ვიწროვდება და იმპულსი სუსტდება — ხშირად აღმასვლის დაღლის ნიშანია." },
  "Falling Wedge":        { ka: "დაღმავალი სოლი", dir: "bull",
    trend: "ფასი ქვემოთ ეშვება, მაგრამ ვარდნა თანდათან სუსტდება და ვიწროვდება — ხშირად კლების ამოწურვის ნიშანია." },
  "Channel Up":           { ka: "აღმავალი არხი", dir: "bull",
    trend: "ფასი ორ პარალელურ ხაზს შორის, საფეხურებად მაღლა მიიწევს — მიმდინარე მიმართულება ზრდისკენაა." },
  "Channel Down":         { ka: "დაღმავალი არხი", dir: "bear",
    trend: "ფასი ორ პარალელურ ხაზს შორის, საფეხურებად ქვემოთ ეშვება — მიმდინარე მიმართულება კლებისკენაა." },
  "Rectangle":            { ka: "მართკუთხედი", dir: "neutral",
    trend: "ფასი გარკვეულ დიაპაზონში, ორ ჰორიზონტალურ ხაზს შორის მოძრაობს — ბაზარი ისვენებს და მკაფიო მიმართულება არ აქვს." },
};
const PATTERN_FALLBACK = { ka: "გრაფიკული ფიგურა", dir: "neutral", trend: "ფასი მნიშვნელოვან გრაფიკულ ფიგურას ქმნის." };

// What to watch near each zone + what voids the pattern — by direction, so the
// guidance is correct for bullish, bearish and range patterns alike.
const ZONE_COPY = {
  bull: {
    lower: "თუ ფასი აქ შეჩერდა და ისევ აიწია, აღმავალი ტრენდი ძალაში რჩება; ქვემოთ მკაფიო გარღვევა კი სისუსტის ნიშანია.",
    upper: "აქ ფასს ხშირად უჭირს გაგრძელება; ძლიერი გარღვევა ზრდის გაგრძელებას მიანიშნებს.",
    invalidation: "თუ ფასი ამ დონის ქვემოთ დაიხურა, ფიგურა ძალას კარგავს.",
  },
  bear: {
    lower: "ეს დონე ფასს ქვემოდან იჭერს; მკაფიო გარღვევა კლების გაღრმავებას მიანიშნებს.",
    upper: "აქ ფასს აწევა გაუჭირდება; ზემოთ დამაგრება კი კლების სცენარს ასუსტებს.",
    invalidation: "თუ ფასი ამ დონის ზემოთ დაიხურა, ფიგურა ძალას კარგავს.",
  },
  neutral: {
    lower: "თუ ფასი აქ შეჩერდა, დიაპაზონი გრძელდება; ქვემოთ გარღვევა კლებისკენ მცდელობას აჩვენებს.",
    upper: "თუ ფასი აქ შეფერხდა, დიაპაზონი გრძელდება; ზემოთ გარღვევა ზრდისკენ მცდელობას აჩვენებს.",
    invalidation: "თუ ფასი დიაპაზონს რომელიმე მხარეს მკაფიოდ გასცდა, ფიგურა ძალას კარგავს.",
  },
};

// Is the pattern clear or weak — without promising anything.
function confidenceNote(c) {
  if (c >= 0.85) return "ძალიან ნათელი სურათია.";
  if (c >= 0.75) return "სურათი მკაფიოა, თუმცა გარანტია არ არსებობს.";
  return "ფიგურა ჯერ სუსტია — სიფრთხილე ჯობს.";
}

// Shared copy pieces for one pattern, used by both the text and HTML renderings.
function patternCopy(pa) {
  const m = PATTERN_COPY[pa.patternName] ?? PATTERN_FALLBACK;
  const z = ZONE_COPY[m.dir];
  return {
    head: `${m.ka} (${pa.patternName}) — ${m.trend}`,
    lower: z.lower,
    upper: z.upper,
    invalidation: z.invalidation,
    confidence: confidenceNote(pa.confidence),
  };
}

// Educational chart-pattern block (plain text): beginner-friendly Georgian, with
// each level explained in plain language (ქვედა/ზედა ზონა, not dry support/
// resistance labels). Describes the structure only — no buy/sell language.
function patternBlockText(pa) {
  const c = patternCopy(pa);
  return [
    `📊 ${c.head}`,
    `ქვედა ზონა: ${fmtPrice(pa.supportLevel)} — ${c.lower}`,
    `ზედა ზონა: ${fmtPrice(pa.resistanceLevel)} — ${c.upper}`,
    `გაუქმება: ${fmtPrice(pa.invalidationLevel)} — ${c.invalidation}`,
    `ფიგურის სანდოობა: ${Math.round(pa.confidence * 100)}% — ${c.confidence}`,
  ].join("\n");
}

export function buildBody(alerts) {
  const sections = alerts.map((a) => {
    const hist = a.history
      .slice(-12)
      .map((p) => `  ${fmtTime(p.t)}  ${fmtPrice(p.p)}`)
      .join("\n");
    const indicators = a.readout
      ? [`ინდიკატორები: ${a.readout.summary}`, `  ${readoutMetrics(a.readout)}`]
      : [];
    // A coin can be here for a price/drift/streak trigger, a pattern, or both —
    // either way it is ONE card. The AI/structural note only applies to the
    // price-trigger path; a pattern-only card skips it and shows the pattern block.
    const tail = [];
    if (a.reasons.length) tail.push(bodyAnalysis(a));
    if (a.patternAlert) tail.push(patternBlockText(a.patternAlert));
    return [
      `${a.coin.toUpperCase()} — ${fmtPrice(a.price)}`,
      `მიზეზი: ${a.reasons.length ? a.reasons.join("; ") : PATTERN_REASON}`,
      ...indicators,
      `ბოლო ფასები:`,
      hist,
      ``,
      tail.join("\n\n"),
    ].join("\n");
  });
  return `${sections.join("\n\n")}\n\n— Criptis`;
}

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// The georgianSummary arrives as an HTML string using only <br> and <strong>.
// Escape it fully, then restore just those two tags — so an unexpected tag from
// the model can't inject markup or break the card layout, while the intended
// bold labels and line breaks render.
export const summaryHtml = (s) =>
  esc(String(s))
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/&lt;strong&gt;/gi, "<strong>")
    .replace(/&lt;\/strong&gt;/gi, "</strong>");

// QuickChart line-chart image of the stored price history. Decorative only — if
// QuickChart is unreachable the <img> just doesn't render and the card's numbers
// still carry the alert. Criptis stores one close per ~1h, so this is a sparkline,
// not candlesticks. Green when the window is net-up, Binance-red when net-down.
function chartUrl(a) {
  const pts = a.history;
  const up = pts.length < 2 || pts.at(-1).p >= pts[0].p;
  const config = {
    type: "line",
    data: {
      labels: pts.map(() => ""),
      datasets: [{
        data: pts.map((p) => p.p),
        borderColor: up ? "#0ecb81" : "#f6465d",
        backgroundColor: up ? "rgba(14,203,129,0.15)" : "rgba(246,70,93,0.15)",
        fill: true,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.35,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { position: "right", grid: { color: "rgba(255,255,255,0.06)" }, ticks: { color: "#848e9c" } },
      },
    },
  };
  return `https://quickchart.io/chart?bkg=%231e2329&w=600&h=240&c=${encodeURIComponent(JSON.stringify(config))}`;
}

function pill(move, label) {
  const bg = move >= 0 ? "#0ecb81" : "#f6465d";
  return `<span style="display:inline-block;background:${bg};color:#fff;font-weight:600;font-size:12px;padding:2px 8px;border-radius:6px;margin:0 6px 4px 0;">${esc(fmtPct(move))} ${esc(label)}</span>`;
}

// Descriptive technical readout block for a card. Neutral grey chips (not the
// green/red move pills) — these characterise the move's shape, they're not gains.
// Direction and momentum are tinted by sign; the rest stay neutral. Renders
// nothing when enrichment was unavailable for the coin.
function readoutHtml(r) {
  if (!r) return "";
  const neutral = "#2b3139";
  const chip = (label, value, bg = neutral, fg = "#d6dae0") =>
    `<span style="display:inline-block;background:${bg};color:${fg};font-size:11px;padding:2px 8px;border-radius:6px;margin:0 6px 4px 0;"><span style="color:#848e9c;">${esc(label)}</span> ${esc(value)}</span>`;
  const dirColor = r.direction === "up" ? "#0ecb81" : r.direction === "down" ? "#f6465d" : neutral;
  const dirFg = r.direction === "flat" ? "#d6dae0" : "#fff";
  const chips = [chip("direction", r.direction, dirColor, dirFg)];
  if (r.rsi != null) chips.push(chip("RSI", r.rsi.toFixed(0)));
  if (r.pctB != null) chips.push(chip("%B", `${Math.round(r.pctB * 100)}%`));
  if (r.momentumPctPerStep != null) {
    const mBg = r.momentumPctPerStep >= 0 ? "#0ecb81" : "#f6465d";
    // "/hr" label is accurate because the series is hourly Coinbase candles (granularity=3600).
    chips.push(chip("momentum", `${fmtPct(r.momentumPctPerStep)}/hr`, mBg, "#fff"));
  }
  if (r.volume) chips.push(chip("volume", r.volume.rising ? "rising" : "easing"));
  return `
        <div style="border-top:1px solid #2b3139;margin:0 0 14px;padding-top:12px;">
          <div style="color:#848e9c;font-size:12px;line-height:1.5;margin-bottom:8px;"><span style="color:#eaecef;font-weight:600;">ინდიკატორები</span> · ${esc(r.summary)}</div>
          <div>${chips.join("")}</div>
        </div>`;
}

// Dynamic bias pill: green for Bullish, red for Bearish, grey for Neutral.
function biasPill(bias) {
  const { label, bg, fg } = biasStyle(bias);
  return `<span style="display:inline-block;background:${bg};color:${fg};font-weight:600;font-size:12px;padding:3px 10px;border-radius:6px;">ტენდენცია: ${esc(label)}</span>`;
}

// Per-card analysis block (HTML): the AI analysis (bias pill + the model's
// georgianSummary, yellow-accented) if the coin passed the pre-filter and the call
// succeeded; a muted structural note if it didn't qualify; otherwise the
// temporary-unavailable line. Mirrors bodyAnalysis.
function htmlAnalysis(a) {
  if (a.analysis) {
    const t = a.analysis;
    return `
        <div style="background:#0b0e11;border-left:3px solid #f0b90b;border-radius:8px;padding:14px 16px;margin:0 0 14px;">
          <div style="margin-bottom:10px;">${biasPill(t.bias)}</div>
          <div style="color:#d6dae0;font-size:14px;line-height:1.7;">${summaryHtml(t.georgianSummary)}</div>
        </div>`;
  }
  const text =
    a.prefilter && !a.prefilter.pass
      ? STRUCTURAL_NOTE
      : "ანალიზი დროებით მიუწვდომელია — იხ. ციფრები ზემოთ.";
  return `<div style="border-left:3px solid #2b3139;border-radius:8px;padding:12px 16px;margin:0 0 14px;color:#848e9c;font-size:13px;line-height:1.6;">${esc(text)}</div>`;
}

// Educational chart-pattern block (HTML). Blue-accented so it reads as a neutral
// observation, distinct from the yellow AI-analysis block. Mirrors patternBlockText
// (same beginner-friendly Georgian copy); every dynamic value is escaped.
function patternHtml(pa) {
  const c = patternCopy(pa);
  const line = (label, value, note) =>
    `<div style="margin-bottom:6px;"><span style="color:#eaecef;font-weight:600;">${esc(label)}: ${esc(value)}</span> <span style="color:#9aa3ad;">— ${esc(note)}</span></div>`;
  return `
        <div style="background:#0b0e11;border-left:3px solid #3b82f6;border-radius:8px;padding:14px 16px;margin:0 0 14px;">
          <div style="color:#d6dae0;font-size:14px;line-height:1.6;margin-bottom:10px;">📊 ${esc(c.head)}</div>
          <div style="color:#b7bdc6;font-size:13px;line-height:1.6;">
            ${line("ქვედა ზონა", fmtPrice(pa.supportLevel), c.lower)}
            ${line("ზედა ზონა", fmtPrice(pa.resistanceLevel), c.upper)}
            ${line("გაუქმება", fmtPrice(pa.invalidationLevel), c.invalidation)}
            ${line("ფიგურის სანდოობა", `${Math.round(pa.confidence * 100)}%`, c.confidence)}
          </div>
        </div>`;
}

// HTML twin of buildBody — a Binance-style dark card per coin with an embedded
// chart and the coin's own analysis (or structural note). Always sent alongside
// the plain-text body, which remains the fallback for clients that block HTML.
export function buildHtml(alerts) {
  const cards = alerts.map((a) => {
    const pills = [pill(a.changePct, "1h")];
    if (a.driftPct !== null) pills.push(pill(a.driftPct, "24h"));
    if (a.streak) pills.push(pill(a.streak.netPct, `${a.streak.len} შემოწმება`));
    const reasonLine = a.reasons.length ? esc(a.reasons.join("; ")) : PATTERN_REASON;
    return `
      <div style="background:#1e2329;border-radius:12px;padding:18px 20px;margin:0 0 16px;">
        <div style="color:#eaecef;font-size:15px;font-weight:700;letter-spacing:.5px;">${esc(a.coin.toUpperCase())}</div>
        <div style="color:#fff;font-size:30px;font-weight:700;margin:4px 0 10px;">${esc(fmtPrice(a.price))}</div>
        <div style="margin-bottom:12px;">${pills.join("")}</div>
        <div style="color:#b7bdc6;font-size:13px;line-height:1.5;margin-bottom:14px;">${reasonLine}</div>
        ${readoutHtml(a.readout)}
        ${a.reasons.length ? htmlAnalysis(a) : ""}
        ${a.patternAlert ? patternHtml(a.patternAlert) : ""}
        <img src="${chartUrl(a)}" alt="${esc(a.coin)} price chart" style="display:block;width:100%;max-width:600px;height:auto;border-radius:8px;" />
      </div>`;
  });
  return `<!doctype html><html><body style="margin:0;padding:20px;background:#181a20;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;">
      <div style="color:#f0b90b;font-size:18px;font-weight:700;margin-bottom:16px;">⚡ Criptis შეტყობინება</div>
      ${cards.join("")}
      <div style="color:#5e6673;font-size:11px;margin-top:16px;">Criptis · ავტომატური ფასის მეთვალყურე · ეს არ არის ფინანსური რჩევა</div>
    </div>
  </body></html>`;
}

// Alert recipients come from the ALERT_RECIPIENTS env var (comma-separated) so
// personal addresses aren't committed to the repo; config.email.to is an optional
// fallback for local/legacy setups. Trimmed and de-duplicated.
export function resolveRecipients() {
  const fromEnv = (process.env.ALERT_RECIPIENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const list = fromEnv.length ? fromEnv : [].concat(config.email?.to ?? []).filter(Boolean);
  return [...new Set(list)];
}

async function sendEmail(subject, text, html) {
  const recipients = resolveRecipients();
  if (dryRun) {
    console.log("\n--- DRY RUN: email not sent ---");
    console.log(`To:      ${recipients.join(", ") || "(none — set ALERT_RECIPIENTS)"}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    if (html) {
      const previewPath = path.join(__dirname, "email-preview.html");
      fs.writeFileSync(previewPath, html);
      console.log(`\nHTML preview written to ${previewPath} — open it in a browser`);
    }
    console.log("--- END DRY RUN ---\n");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  if (!recipients.length) {
    throw new Error("no alert recipients — set the ALERT_RECIPIENTS env var (comma-separated) or config.email.to");
  }

  async function send(to) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: config.email.from, to, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
  }

  try {
    await send(recipients);
  } catch (err) {
    // Resend's test sender (onboarding@resend.dev) rejects the whole request
    // if any recipient isn't the account owner — don't lose the alert entirely.
    if (recipients.length < 2) throw err;
    console.error(`Send to all recipients failed (${err.message}) — retrying with ${recipients[0]} only`);
    await send([recipients[0]]);
  }
}

// --- Main ----------------------------------------------------------------------

async function main() {
  const state = loadState();
  // Gather professional-grade market data (OHLCV + news) up front, then derive the
  // spot price (latest close) per coin. A coin with no valid OHLCV is skipped here,
  // never zeroed. A total failure (no coin priced) fails the run loudly, as the old
  // CoinGecko fetch did, so a data outage never reads as "nothing happened".
  const market = await gatherMarket(coins);
  const { prices, skipped } = derivePrices(market.ohlcv, coins);
  if (skipped.length) {
    console.warn(`No valid price this run, skipping: ${skipped.join(", ")}`);
  }
  if (Object.keys(prices).length === 0) {
    throw new Error(`no valid price for any coin this run (checked ${coins.length})`);
  }
  const now = Date.now();
  const alerts = [];
  // Per-coin signals for EVERY priced coin (not just triggered ones), so a
  // pattern-only alert can build a full card from the same numbers the price
  // triggers used.
  const coinSignals = {};

  for (const coin of coins) {
    const price = prices[coin];
    // BUG-1: a coin with no valid price this run is skipped entirely — no signal
    // math and, crucially, no history append (a missing price must never be stored
    // nor treated as a 0% move). derivePrices already collected which coins were skipped.
    if (price === undefined) {
      console.log(`${coin}: no valid price this run — skipped`);
      continue;
    }
    const entry = state.coins[coin] ?? { history: [] };
    const history = entry.history;

    const last = history.at(-1);
    const changePct = last ? pct(last.p, price) : null;

    // Drift reference: the point closest to 24h old, but at least 18h old so a
    // young history can't fake a day-scale move.
    const candidates = history.filter((p) => now - p.t >= DRIFT_MIN_AGE_HOURS * HOUR);
    const ref = candidates.length
      ? candidates.reduce((best, p) =>
          Math.abs(now - p.t - 24 * HOUR) < Math.abs(now - best.t - 24 * HOUR) ? p : best
        )
      : null;
    const driftPct = ref ? pct(ref.p, price) : null;

    const reasons = [];
    if (changeThresholdPct !== null && changePct !== null && Math.abs(changePct) > changeThresholdPct) {
      reasons.push(`${fmtPct(changePct)} ბოლო შემოწმების შემდეგ (ზღვარი ${changeThresholdPct}%)`);
    }
    // BUG-2: drift is edge-triggered via a per-coin latch so a sustained move
    // alerts once instead of every run for ~24h. Read the latch defensively (older
    // state.json lacks the field) and update it EVERY run for this valid-price coin
    // so it can re-arm when the move eases. A null driftPct (no ~24h reference yet)
    // means no episode → latch stays disarmed at 0.
    const prevDriftDir = entry.lastDriftDir ?? 0;
    let driftDir = 0;
    if (driftPct !== null && driftThresholdPct !== null) {
      const decision = driftDecision(driftPct, driftThresholdPct, prevDriftDir, DRIFT_REARM);
      driftDir = decision.nextDir;
      if (decision.fire) {
        reasons.push(`${fmtPct(driftPct)} ცვლილება ~24სთ წინანდელთან შედარებით (ზღვარი ${driftThresholdPct}%)`);
      }
    }
    entry.lastDriftDir = driftDir;

    // Trend streak: N checks in a row moving the same way. Catches a slow, steady
    // grind where each ~1h step stays under changeThresholdPct yet never reverses.
    // Re-fires every streakLength checks the run keeps going (len 5, 10, 15, …) so a
    // trend that holds its direction keeps alerting, not just on the first crossing.
    // A reversal or a flat tick resets the run, and the next alert waits a fresh N
    // steps. (history caps at HISTORY_LIMIT, so on a very long run len tops out there
    // and the last few multiples can't be reached — a >~45h one-way grind is rare.)
    let streakInfo = null;
    const streak = trendStreak(history, price);
    if (streakLength >= 2 && streak.len > 0 && streak.len % streakLength === 0) {
      const startT = history[history.length - streak.len].t;
      const windowH = Math.round((now - startT) / HOUR);
      const dirWord = streak.dir > 0 ? "ზრდის" : "კლების";
      reasons.push(`ზედიზედ ${streak.len} შემოწმება ${dirWord} მიმართულებით (${fmtPct(streak.netPct)} ~${windowH}სთ-ში)`);
      streakInfo = streak;
    }

    history.push({ t: now, p: price });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    state.coins[coin] = entry;
    coinSignals[coin] = { changePct: changePct ?? 0, driftPct, streak: streakInfo, history: [...history] };

    if (reasons.length) {
      alerts.push({ coin, price, changePct: changePct ?? 0, driftPct, streak: streakInfo, reasons, history: [...history] });
    }
    const tag = changePct === null ? " (first data point)" : ` (${fmtPct(changePct)})`;
    console.log(`${coin}: ${fmtPrice(price)}${tag}${reasons.length ? "  >> TRIGGER" : ""}`);
  }

  // Enrichment layer: fold each coin's already-gathered OHLCV into a descriptive
  // technical readout. The series was fetched ONCE in gatherMarket and is reused
  // here (no second fetch) — the triggers, the email (alerting coins) and
  // public/data.json (all coins) all share the SAME candles and readout. A coin
  // with no series degrades to a null readout, never blocking an alert.
  const enrichment = {};
  for (const coin of coins) {
    if (prices[coin] === undefined) continue; // no spot price this run — not published
    const series = market.ohlcv[coin] ?? null;
    let r = null;
    try {
      r = series ? readout(series) : null;
      if (r) console.log(`${coin}: readout — ${r.summary}`);
    } catch (err) {
      console.error(`Readout for ${coin} failed — null readout: ${err.message}`);
    }
    // SHADOW MODE: deterministic chart-pattern detection, computed independently
    // of the readout so neither can break the other. Published to public/data.json
    // for the dashboard ONLY — it does not gate alerts, the email, or the LLM.
    // toPublicPatterns fails safe to [] on a missing series or any detector error.
    const patterns = toPublicPatterns(series);
    if (patterns.length) {
      console.log(`${coin}: patterns — ${patterns.map((p) => `${p.patternName} ${p.confidence}`).join(", ")}`);
    }
    enrichment[coin] = { readout: r, series, patterns };
  }

  // Dry-run observability: per-coin pattern-alert evaluation breakdown. Printed
  // BEFORE the evaluation below records any cooldown, so cooldownBlocked reflects
  // the pre-run state. Pure logging — changes no alert/email/threshold behaviour.
  if (dryRun) {
    console.log("\n--- DRY RUN: pattern-alert evaluation ---");
    for (const coin of coins) {
      if (prices[coin] === undefined) continue;
      const d = explainPatternAlert(enrichment[coin]?.patterns ?? [], state.coins[coin]?.patternCooldowns, patternAlertsCfg, now);
      const conf = d.confidence === null ? "—" : `${Math.round(d.confidence * 100)}%`;
      console.log(
        `${coin}: patterns=${d.count} top=${d.top ?? "—"} conf=${conf}` +
          ` | enabled=${d.enabled} minConf=${d.passedMinConfidence} levels=${d.levelsValid} cooldownBlocked=${d.cooldownBlocked}` +
          ` => pattern alert: ${d.decision ? "YES" : "no"}`,
      );
    }
    console.log("--- END pattern-alert evaluation ---\n");
  }

  // Pattern-alert path (OPT-IN). For each priced coin, see whether its highest-
  // confidence ACTIVE pattern clears the educational-alert bar (enabled, confidence,
  // valid levels, cooldown). If so, record the per-pattern cooldown in state and
  // attach the pattern to the coin's alert — creating a pattern-only alert when the
  // coin had no price/drift/streak trigger, or MERGING into the existing alert so a
  // coin with both is ONE card. Wrapped defensively so it can never block the state
  // write below or weaken the price/drift/streak triggers.
  if (patternAlertsCfg.enabled) {
    try {
      for (const coin of coins) {
        if (prices[coin] === undefined) continue;
        const entry = state.coins[coin];
        if (!entry) continue;
        const eligible = evaluatePatternAlert(enrichment[coin]?.patterns ?? [], entry.patternCooldowns, patternAlertsCfg, now);
        if (!eligible) continue;
        entry.patternCooldowns = { ...(entry.patternCooldowns ?? {}), [eligible.patternName]: now };
        let a = alerts.find((x) => x.coin === coin);
        if (!a) {
          const sig = coinSignals[coin] ?? { changePct: 0, driftPct: null, streak: null, history: [...(entry.history ?? [])] };
          a = { coin, price: prices[coin], changePct: sig.changePct, driftPct: sig.driftPct, streak: sig.streak, reasons: [], history: sig.history };
          alerts.push(a);
        }
        a.patternAlert = eligible;
        console.log(`${coin}: pattern alert — ${eligible.patternName} (conf ${eligible.confidence})`);
      }
    } catch (err) {
      console.error(`Pattern-alert evaluation failed — skipping pattern alerts: ${err.message}`);
    }
  }

  // State is written HERE (after the cooldown updates above) so per-pattern cooldown
  // timestamps persist alongside the trigger loop's history + drift-latch updates.
  // On --dry-run nothing is written, so cooldowns are not persisted (preview only).
  state.updatedAt = new Date(now).toISOString();
  if (dryRun) {
    console.log("Dry run: state.json not written");
  } else {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  }

  // Publish the dashboard feed every run (even with no alert): the spot price used
  // for the triggers, the shared readout (or null), the shadow-mode `patterns`
  // array (dashboard-only; never gates alerts/email/LLM), and the hourly OHLCV
  // series. Each point carries the full candle { t, o, h, l, c, v } plus p (= close)
  // kept as a backward-compatible alias for the previous close-only feed (v null
  // where the exchange gave no volume; [] when the fetch failed). Written here,
  // before the early return below — Claude and Resend stay gated on a trigger.
  // Unlike state.json this is a stateless projection of the run, always rewritten.
  const data = { updatedAt: state.updatedAt, coins: {} };
  for (const coin of coins) {
    if (prices[coin] === undefined) continue;
    const { readout: r = null, series = null, patterns = [] } = enrichment[coin] ?? {};
    data.coins[coin] = {
      price: prices[coin],
      readout: r,
      patterns,
      series: series
        ? series.times.map((t, i) => ({
            t,
            o: series.opens[i],
            h: series.highs[i],
            l: series.lows[i],
            c: series.closes[i],
            v: series.volumes[i] ?? null,
            p: series.closes[i],
          }))
        : [],
    };
  }
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2) + "\n");
  console.log(`Wrote ${path.relative(__dirname, DATA_PATH)} (${Object.keys(data.coins).length} coin(s))`);

  // Reuse the shared readouts + candles for the alert email + LLM — no second fetch.
  for (const a of alerts) {
    a.readout = enrichment[a.coin]?.readout ?? null;
    a.series = enrichment[a.coin]?.series ?? null;
  }

  if (alerts.length === 0) {
    console.log("No triggers — state + data updated, nothing to send.");
    return;
  }

  // Breakout pre-filter — the LLM boundary. A deterministic trigger got the coin
  // this far; the pre-filter decides whether the move is a real, volume-backed
  // Bollinger breakout worth a written analysis. PASS -> analyze() with the full
  // candle array + news. FAIL -> bypass the LLM and fall back to a structural
  // (raw-metrics) alert. Each coin is judged independently, so one combined email
  // can carry AI paragraphs for the breakouts and raw numbers for the rest.
  for (const a of alerts) {
    // A pattern-only alert (no price/drift/streak reason) is fully deterministic —
    // it never touches the Bollinger pre-filter or the LLM.
    if (!a.reasons.length) {
      a.prefilter = null;
      a.analysis = null;
      continue;
    }
    const pf = breakoutPrefilter(a.series);
    a.prefilter = pf;
    if (!pf.pass) {
      a.analysis = null;
      console.log(`${a.coin}: pre-filter SKIP (${pf.reason}) — structural alert, no LLM call`);
      continue;
    }
    console.log(`${a.coin}: pre-filter PASS (${pf.reason}) — calling analyze()`);
    a.analysis = await analyze(a, market.news);
  }

  const subject = alerts.map(headline).join(" · ");
  await sendEmail(subject, buildBody(alerts), buildHtml(alerts));
  const llm = alerts.filter((a) => a.analysis).map((a) => a.coin);
  console.log(
    `Alert ${dryRun ? "printed" : "emailed"} for: ${alerts.map((a) => a.coin).join(", ")}` +
      ` (LLM analysis: ${llm.length ? llm.join(", ") : "none"})`,
  );
}

// Run only when invoked directly (node watcher.js) so a test file can import the
// pure helpers above without kicking off a real fetch/email run.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}
