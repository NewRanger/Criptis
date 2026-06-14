#!/usr/bin/env node
// Criptis — crypto price watcher. Runs on GitHub Actions every 2h, alerts via Resend email.
// Deterministic triggers decide WHEN to alert; the LLM only writes the analysis paragraph.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "state.json");
const PROMPT_PATH = path.join(__dirname, "prompts", "analysis.md");

const HISTORY_LIMIT = 24; // price points kept per coin (~48h at a 2h cadence)
const HOUR = 3_600_000;
const DRIFT_MIN_AGE_HOURS = 18; // youngest point allowed as the "~24h ago" reference

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
const changeThresholdPct = config.changeThresholdPct ?? 2;
const driftThresholdPct = config.driftThresholdPct ?? 5;
const streakLength = config.streakLength ?? 5; // consecutive same-direction checks that flag a trend

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

// --- Prices (CoinGecko, retry once then exit 1) -------------------------------

async function fetchPrices(ids) {
  if (mockPrice !== null) {
    console.log(`Mock mode: using ${fmtPrice(mockPrice)} for all coins, skipping CoinGecko`);
    return Object.fromEntries(ids.map((id) => [id, mockPrice]));
  }
  const url =
    "https://api.coingecko.com/api/v3/simple/price" +
    `?ids=${encodeURIComponent(ids.join(","))}&vs_currencies=usd`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const prices = {};
      for (const id of ids) {
        const usd = data[id]?.usd;
        if (typeof usd !== "number") throw new Error(`no USD price for "${id}" in response`);
        prices[id] = usd;
      }
      return prices;
    } catch (err) {
      console.error(`CoinGecko attempt ${attempt}/2 failed: ${err.message}`);
      if (attempt === 2) throw new Error(`CoinGecko unreachable after retry: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

// --- Analysis (Anthropic; failure must never block the email) -----------------

async function analyze(alerts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY not set — sending raw numbers only");
    return null;
  }
  const system = fs.readFileSync(PROMPT_PATH, "utf8");
  const userMsg = alerts
    .map((a) => {
      const lines = a.history.map((p) => `${fmtTime(p.t)}  ${fmtPrice(p.p)}`).join("\n");
      const drift = a.driftPct === null ? "" : `, ${fmtPct(a.driftPct)} vs ~24h ago`;
      return [
        `## ${a.coin}`,
        `current: ${fmtPrice(a.price)} (${fmtPct(a.changePct)} since last check${drift})`,
        `triggered by: ${a.reasons.join("; ")}`,
        `price history, oldest first (~2h between points):`,
        lines,
      ].join("\n");
    })
    .join("\n\n");

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
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: userMsg }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = await res.json();
    const text = (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
    return text || null;
  } catch (err) {
    console.error(`Anthropic call failed — sending raw numbers only: ${err.message}`);
    return null;
  }
}

// --- Notification (Resend) -----------------------------------------------------

function headline(a) {
  // Lead with whichever signal is largest in magnitude: a slow 24h bleed or a
  // multi-check trend can matter more than the latest 2h tick (which may be ~0).
  const candidates = [{ move: a.changePct, window: "2h" }];
  if (a.driftPct !== null) candidates.push({ move: a.driftPct, window: "24h" });
  if (a.streak) candidates.push({ move: a.streak.netPct, window: `${a.streak.len}-check trend` });
  const top = candidates.reduce((b, c) => (Math.abs(c.move) > Math.abs(b.move) ? c : b));
  return `${top.move >= 0 ? "\u{1F4C8}" : "\u{1F4C9}"} ${a.coin} ${fmtPrice(a.price)} (${fmtPct(top.move)} ${top.window})`;
}

function buildBody(alerts, analysis) {
  const sections = alerts.map((a) => {
    const hist = a.history
      .slice(-12)
      .map((p) => `  ${fmtTime(p.t)}  ${fmtPrice(p.p)}`)
      .join("\n");
    return [
      `${a.coin.toUpperCase()} — ${fmtPrice(a.price)}`,
      `Triggered: ${a.reasons.join("; ")}`,
      `Recent prices:`,
      hist,
    ].join("\n");
  });
  const tail = analysis
    ? `Analysis:\n${analysis}`
    : "Analysis unavailable (Anthropic call failed or no key) — raw numbers above.";
  return `${sections.join("\n\n")}\n\n${tail}\n\n— Criptis`;
}

async function sendEmail(subject, body) {
  if (dryRun) {
    console.log("\n--- DRY RUN: email not sent ---");
    console.log(`To:      ${config.email.to}`);
    console.log(`Subject: ${subject}`);
    console.log(body);
    console.log("--- END DRY RUN ---\n");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  const recipients = [].concat(config.email.to);

  async function send(to) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from: config.email.from, to, subject, text: body }),
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
  const prices = await fetchPrices(coins);
  const now = Date.now();
  const alerts = [];

  for (const coin of coins) {
    const price = prices[coin];
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
    if (changePct !== null && Math.abs(changePct) > changeThresholdPct) {
      reasons.push(`${fmtPct(changePct)} since last check (threshold ${changeThresholdPct}%)`);
    }
    if (driftPct !== null && Math.abs(driftPct) > driftThresholdPct) {
      reasons.push(`${fmtPct(driftPct)} drift vs ~24h ago (threshold ${driftThresholdPct}%)`);
    }

    // Trend streak: N checks in a row moving the same way. Catches a slow, steady
    // grind where each ~2h step stays under changeThresholdPct yet never reverses.
    // Fires once — the moment the run reaches streakLength — so a long trend isn't
    // re-alerted every check (next check len is N+1, not N, so it stays quiet).
    let streakInfo = null;
    const streak = trendStreak(history, price);
    if (streakLength >= 2 && streak.len === streakLength) {
      const startT = history[history.length - streak.len].t;
      const windowH = Math.round((now - startT) / HOUR);
      const dirWord = streak.dir > 0 ? "up" : "down";
      reasons.push(`${streakLength} checks in a row ${dirWord} (${fmtPct(streak.netPct)} over ~${windowH}h)`);
      streakInfo = streak;
    }

    history.push({ t: now, p: price });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    state.coins[coin] = entry;

    if (reasons.length) {
      alerts.push({ coin, price, changePct: changePct ?? 0, driftPct, streak: streakInfo, reasons, history: [...history] });
    }
    const tag = changePct === null ? " (first data point)" : ` (${fmtPct(changePct)})`;
    console.log(`${coin}: ${fmtPrice(price)}${tag}${reasons.length ? "  >> TRIGGER" : ""}`);
  }

  state.updatedAt = new Date(now).toISOString();
  if (dryRun) {
    console.log("Dry run: state.json not written");
  } else {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  }

  if (alerts.length === 0) {
    console.log("No triggers — state updated, nothing to send.");
    return;
  }

  const analysis = await analyze(alerts);
  const subject = alerts.map(headline).join(" · ");
  await sendEmail(subject, buildBody(alerts, analysis));
  console.log(`Alert ${dryRun ? "printed" : "emailed"} for: ${alerts.map((a) => a.coin).join(", ")}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
