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
  // Lead with whichever move actually matters: a slow 24h bleed can trigger
  // while the 2h change is near zero.
  const useDrift = a.driftPct !== null && Math.abs(a.driftPct) > Math.abs(a.changePct);
  const move = useDrift ? a.driftPct : a.changePct;
  const window = useDrift ? "24h" : "2h";
  return `${move >= 0 ? "\u{1F4C8}" : "\u{1F4C9}"} ${a.coin} ${fmtPrice(a.price)} (${fmtPct(move)} ${window})`;
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
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: config.email.from,
      to: [].concat(config.email.to),
      subject,
      text: body,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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

    history.push({ t: now, p: price });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    state.coins[coin] = entry;

    if (reasons.length) {
      alerts.push({ coin, price, changePct: changePct ?? 0, driftPct, reasons, history: [...history] });
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
