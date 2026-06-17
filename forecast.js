#!/usr/bin/env node
// forecast.js — hourly "storm warning" runner (the honest weather app).
//
// Direction is a random walk (proven by the backtest), so this does NOT predict
// up/down. It forecasts VOLATILITY — "big swings likely in the next ~12–24h" — which
// IS forecastable (~60%), and hands over the LEVEL MAP so the move's direction
// reveals itself against lines you were warned about. Emails a Georgian storm warning
// to all recipients when a storm is likely and the coin isn't in cooldown.
//
// Advises (set a stop, trim size) — never executes. Run `node forecast.js --dry-run`
// to print + write forecast-preview.html without sending or touching state.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fetchSeries } from "./datasource.js";
import { forecastVolatility, levelMap } from "./volatility.js";
import { resolveRecipients, RISK_NOTE } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "forecast-state.json");
const HOUR = 3_600_000;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = config.coins ?? ["bitcoin"];
const fc = {
  stormProb: Number.isFinite(config.forecast?.stormProb) ? config.forecast.stormProb : 0.6,
  cooldownHours: Number.isFinite(config.forecast?.cooldownHours) ? config.forecast.cooldownHours : 12,
  horizon: Number.isFinite(config.forecast?.horizon) ? config.forecast.horizon : 24,
  candles: Number.isFinite(config.forecast?.candles) ? config.forecast.candles : 300,
};

function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); if (s && typeof s.coins === "object") return s; } catch {}
  return { coins: {} };
}

// --- formatting + Georgian copy (formal თქვენ; standard terms; with RISK_NOTE) ----
const fmtPrice = (n) =>
  !Number.isFinite(n) ? "—" : n >= 1
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${n.toPrecision(4)}`;
const fmtMove = (n) => (Number.isFinite(n) ? `±${n.toFixed(1)}%` : "—");
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Why the storm — calm-before-the-storm (squeeze) vs already-turbulent (persistence).
const causeKa = (f) =>
  f.reason === "squeeze-expansion"
    ? "ბაზარი ჩაცხრა და მერყეობა მინიმუმზეა — ხშირად ეს ძლიერი მოძრაობის წინამორბედია."
    : "მერყეობა უკვე აშკარად გაზრდილია და, სავარაუდოდ, უახლოეს საათებში გაგრძელდება.";

function directionLine(lm) {
  const parts = [];
  if (Number.isFinite(lm.resistance)) parts.push(`წინააღმდეგობის (${fmtPrice(lm.resistance)}) ზემოთ დახურვა — ზრდისკენ მცდელობა`);
  if (Number.isFinite(lm.support)) parts.push(`მხარდაჭერის (${fmtPrice(lm.support)}) ქვემოთ — კლებისკენ`);
  if (!parts.length) return "მკაფიო დონეები ამ მონაკვეთზე არ იკვეთება.";
  return `მიმართულებას გარღვევა გამოავლენს: ${parts.join("; ")}. მიმართულების წინასწარი პროგნოზი არ კეთდება.`;
}

function cardText(w) {
  const { coin, f, lm } = w;
  return [
    `🌩️ ${coin.toUpperCase()} — მოსალოდნელია გაზრდილი მერყეობა`,
    `უახლოეს ~${f.horizonHours}სთ-ში ძლიერი რყევის ალბათობა ~${Math.round(f.probability * 100)}%. ${causeKa(f)}`,
    `მოსალოდნელი რყევის მასშტაბი: ~${fmtMove(f.expectedMovePct)} (მიმდინარე ფასი ${fmtPrice(lm.price)}).`,
    `${directionLine(lm)}`,
    `👉 თუ პოზიცია გაქვთ, განიხილეთ რისკის მართვა: სტოპ-ლოსის (stop-loss) დაყენება ან მოცულობის შემცირება.`,
  ].join("\n");
}

function cardHtml(w) {
  const { coin, f, lm } = w;
  return `
      <div style="background:#1e2329;border-left:4px solid #f0b90b;border-radius:12px;padding:18px 20px;margin:0 0 16px;">
        <div style="color:#eaecef;font-size:15px;font-weight:700;letter-spacing:.5px;">🌩️ ${esc(coin.toUpperCase())}</div>
        <div style="color:#fff;font-size:19px;font-weight:700;margin:4px 0 10px;">მოსალოდნელია გაზრდილი მერყეობა</div>
        <div style="display:inline-block;background:#f0b90b;color:#181a20;font-weight:700;font-size:13px;padding:4px 12px;border-radius:6px;margin-bottom:12px;">ალბათობა ~${Math.round(f.probability * 100)}% · ~${f.horizonHours}სთ</div>
        <div style="color:#d6dae0;font-size:13px;line-height:1.6;margin:0 0 8px;">${esc(causeKa(f))}</div>
        <div style="color:#b7bdc6;font-size:13px;line-height:1.6;margin:0 0 8px;">მოსალოდნელი მასშტაბი: <strong style="color:#eaecef;">~${esc(fmtMove(f.expectedMovePct))}</strong> · მიმდინარე ფასი ${esc(fmtPrice(lm.price))}</div>
        <div style="color:#b7bdc6;font-size:13px;line-height:1.6;margin:0 0 8px;">${esc(directionLine(lm))}</div>
        <div style="color:#eaecef;font-size:13px;font-weight:600;background:#0b0e11;border-radius:6px;padding:9px 11px;">👉 თუ პოზიცია გაქვთ, განიხილეთ რისკის მართვა: სტოპ-ლოსის (stop-loss) დაყენება ან მოცულობის შემცირება.</div>
      </div>`;
}

function buildText(ws) {
  return `${ws.map(cardText).join("\n\n")}\n\n${RISK_NOTE}\n— Criptis (მერყეობის გაფრთხილება)`;
}
function buildHtml(ws) {
  return `<!doctype html><html><body style="margin:0;padding:20px;background:#181a20;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;">
      <div style="color:#f0b90b;font-size:18px;font-weight:700;margin-bottom:16px;">🌩️ Criptis — მერყეობის გაფრთხილება</div>
      ${ws.map(cardHtml).join("")}
      <div style="color:#9aa3ad;font-size:11px;margin-top:16px;line-height:1.5;">${esc(RISK_NOTE)}<br>Criptis · კოინ-ტრეიდერ ასისტენტი</div>
    </div>
  </body></html>`;
}
const buildSubject = (ws) => `🌩️ Criptis — მოსალოდნელია ძლიერი მერყეობა: ${ws.map((w) => w.coin.toUpperCase()).join(" · ")}`;

// --- send (Resend; retry to the first recipient alone, like the watcher) -----
async function sendEmail(subject, text, html) {
  const recipients = resolveRecipients();
  if (dryRun) {
    console.log("\n--- DRY RUN: email not sent ---");
    console.log(`To:      ${recipients.join(", ") || "(none — set ALERT_RECIPIENTS)"}`);
    console.log(`Subject: ${subject}\n${text}`);
    fs.writeFileSync(path.join(__dirname, "forecast-preview.html"), html);
    console.log(`\nHTML preview written to forecast-preview.html — open it in a browser`);
    console.log("--- END DRY RUN ---\n");
    return;
  }
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not set");
  if (!recipients.length) throw new Error("no alert recipients — set ALERT_RECIPIENTS or config.email.to");
  const send = async (to) => {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  };
  try { await send(recipients); }
  catch (err) {
    if (recipients.length < 2) throw err;
    console.error(`Send to all failed (${err.message}) — retrying with ${recipients[0]} only`);
    await send([recipients[0]]);
  }
}

// --- main --------------------------------------------------------------------
async function main() {
  const state = loadState();
  const now = Date.now();
  const cooldownMs = fc.cooldownHours * HOUR;
  const warnings = [];

  for (const coin of coins) {
    let series;
    try {
      series = await fetchSeries(coin, { granularity: 3600, limit: fc.candles });
    } catch (err) {
      console.error(`${coin}: fetch failed — skipped: ${err.message}`);
      continue;
    }
    const f = forecastVolatility(series, { horizon: fc.horizon, stormProb: fc.stormProb });
    const lm = levelMap(series);
    console.log(`${coin}: level ${f.level} · storm-prob ${Math.round(f.probability * 100)}% · ~${fmtMove(f.expectedMovePct)} (${f.reason})`);

    if (!f.storm) continue;
    const entry = state.coins[coin] ?? {};
    if (Number.isFinite(entry.lastStormAt) && now - entry.lastStormAt < cooldownMs) {
      console.log(`  ${coin}: storm likely but in cooldown (${Math.round((now - entry.lastStormAt) / HOUR)}h ago) — not re-sending`);
      continue;
    }
    warnings.push({ coin, f, lm });
    state.coins[coin] = { ...entry, lastStormAt: now };
  }

  if (!warnings.length) {
    console.log("No new storm warnings this run.");
  } else {
    await sendEmail(buildSubject(warnings), buildText(warnings), buildHtml(warnings));
    console.log(`${dryRun ? "Printed" : "Emailed"} storm warning for: ${warnings.map((w) => w.coin).join(", ")}`);
  }

  if (dryRun) console.log("Dry run: forecast-state.json not written");
  else fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

main().catch((err) => { console.error(`Fatal: ${err.message}`); process.exit(1); });
