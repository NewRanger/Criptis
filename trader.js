#!/usr/bin/env node
// trader.js — daily trade-signal runner (the advisory job).
//
// A SEPARATE job from the hourly watcher.js: once a day (just after the 00:00 UTC
// daily close) it pulls DAILY candles per coin, runs the deterministic, regime-aware
// signals.js verdict, and emails the actionable ones as ADVICE — recommendation +
// entry / stop-loss / target / R:R, in beginner-friendly Georgian, with a risk note.
//
// It ADVISES, it does NOT execute: no orders are ever placed. The human decides.
// Every verdict is logged; only verdicts that are actionable AND clear the confidence
// bar are emailed. Run `node trader.js --dry-run` to print + write trader-preview.html
// without sending.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { fetchSeries } from "./datasource.js";
import { evaluateSignal } from "./signals.js";
import { resolveRecipients, RISK_NOTE } from "./watcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "config.json");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = config.coins ?? ["bitcoin"];
// Optional `traderSignals` config block (no secrets). Sensible defaults if absent.
const traderCfg = {
  minConfidence: Number.isFinite(config.traderSignals?.minConfidence) ? config.traderSignals.minConfidence : 0.5,
  granularity: Number.isFinite(config.traderSignals?.granularity) ? config.traderSignals.granularity : 86400, // 1d
  candles: Number.isFinite(config.traderSignals?.candles) ? config.traderSignals.candles : 300, // Coinbase max/call
  includeWatch: config.traderSignals?.includeWatch === true,
};

// --- formatting --------------------------------------------------------------
const fmtPrice = (n) =>
  !Number.isFinite(n) ? "—" : n >= 1
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    : `$${n.toPrecision(4)}`;

// --- Georgian copy (advisory; standard trading terms; formal თქვენ) ----------
const VERDICT_COPY = {
  STRONG_BUY:  { ka: "ძლიერი ყიდვის სიგნალი",   action: "ყიდვა",   accent: "#0ecb81" },
  BUY:         { ka: "ყიდვის სიგნალი",           action: "ყიდვა",   accent: "#0ecb81" },
  WATCH:       { ka: "მეთვალყურეობა",            action: "მოცდა",   accent: "#f0b90b" },
  NEUTRAL:     { ka: "ნეიტრალური",               action: "მოცდა",   accent: "#2b3139" },
  SELL:        { ka: "გაყიდვის სიგნალი",         action: "გაყიდვა", accent: "#f6465d" },
  STRONG_SELL: { ka: "ძლიერი გაყიდვის სიგნალი",  action: "გაყიდვა", accent: "#f6465d" },
};
const REGIME_KA = { bull: "აღმავალი ტენდენცია", bear: "დაღმავალი ტენდენცია", range: "გვერდითი მოძრაობა (დიაპაზონი)" };

const ACTIONABLE = new Set(["BUY", "STRONG_BUY", "SELL", "STRONG_SELL"]);
const isActionable = (v) => ACTIONABLE.has(v.verdict) || (traderCfg.includeWatch && v.verdict === "WATCH");
const emailable = (v) => isActionable(v) && Number.isFinite(v.confidence) && v.confidence >= traderCfg.minConfidence;

// Level lines, only when the number is real (a WATCH verdict has no entry/stop).
function levelLines(v) {
  const r = v.risk ?? {};
  const lines = [];
  if (Number.isFinite(r.entry))  lines.push(["შესვლა", fmtPrice(r.entry)]);
  if (Number.isFinite(r.stop))   lines.push(["სტოპ-ლოსი (stop-loss)", fmtPrice(r.stop)]);
  if (Number.isFinite(r.target)) lines.push(["მიზანი", fmtPrice(r.target)]);
  if (Number.isFinite(r.riskReward) && r.riskReward > 0) lines.push(["მოგება/რისკი (R:R)", `${r.riskReward}`]);
  return lines;
}

// --- plain-text email --------------------------------------------------------
function cardText(v) {
  const c = VERDICT_COPY[v.verdict] ?? VERDICT_COPY.NEUTRAL;
  const head = [
    `${v.coin.toUpperCase()} — ${c.ka}`,
    `👉 რეკომენდაცია: ${c.action}`,
    `ტენდენცია: ${REGIME_KA[v.regime?.trend] ?? "—"} · სანდოობა: ${Math.round((v.confidence ?? 0) * 100)}% · თანხვედრა: ${v.confluence?.count ?? 0} ფაქტორი`,
  ];
  const levels = levelLines(v).map(([k, val]) => `${k}: ${val}`);
  return [...head, ...levels].join("\n");
}

function buildBodyText(verdicts) {
  return `${verdicts.map(cardText).join("\n\n")}\n\n${RISK_NOTE}\n— Criptis (დღიური სიგნალები)`;
}

// --- HTML email (dark cards, mirrors the watcher style) ----------------------
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

function cardHtml(v) {
  const c = VERDICT_COPY[v.verdict] ?? VERDICT_COPY.NEUTRAL;
  const rows = levelLines(v)
    .map(([k, val]) => `<tr><td style="color:#848e9c;padding:2px 12px 2px 0;">${esc(k)}</td><td style="color:#eaecef;font-weight:600;">${esc(val)}</td></tr>`)
    .join("");
  return `
      <div style="background:#1e2329;border-left:4px solid ${c.accent};border-radius:12px;padding:18px 20px;margin:0 0 16px;">
        <div style="color:#eaecef;font-size:15px;font-weight:700;letter-spacing:.5px;">${esc(v.coin.toUpperCase())}</div>
        <div style="color:#fff;font-size:20px;font-weight:700;margin:4px 0 10px;">${esc(c.ka)}</div>
        <div style="display:inline-block;background:${c.accent};color:#fff;font-weight:700;font-size:13px;padding:4px 12px;border-radius:6px;margin-bottom:12px;">რეკომენდაცია: ${esc(c.action)}</div>
        <div style="color:#b7bdc6;font-size:13px;line-height:1.6;margin:0 0 10px;">ტენდენცია: ${esc(REGIME_KA[v.regime?.trend] ?? "—")} · სანდოობა: ${Math.round((v.confidence ?? 0) * 100)}% · თანხვედრა: ${v.confluence?.count ?? 0} ფაქტორი</div>
        <table style="font-size:13px;border-collapse:collapse;">${rows}</table>
      </div>`;
}

function buildBodyHtml(verdicts) {
  return `<!doctype html><html><body style="margin:0;padding:20px;background:#181a20;font-family:Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;">
      <div style="color:#f0b90b;font-size:18px;font-weight:700;margin-bottom:16px;">📊 Criptis — დღიური სავაჭრო სიგნალები</div>
      ${verdicts.map(cardHtml).join("")}
      <div style="color:#9aa3ad;font-size:11px;margin-top:16px;line-height:1.5;">${esc(RISK_NOTE)}<br>Criptis · კოინ-ტრეიდერ ასისტენტი</div>
    </div>
  </body></html>`;
}

function buildSubject(verdicts) {
  const parts = verdicts.map((v) => `${v.coin.toUpperCase()} ${(VERDICT_COPY[v.verdict] ?? VERDICT_COPY.NEUTRAL).action}`);
  return `📊 Criptis დღიური სიგნალები — ${parts.join(" · ")}`;
}

// --- send (Resend; retry to the first recipient alone, like the watcher) -----
async function sendEmail(subject, text, html) {
  const recipients = resolveRecipients();
  if (dryRun) {
    console.log("\n--- DRY RUN: email not sent ---");
    console.log(`To:      ${recipients.join(", ") || "(none — set ALERT_RECIPIENTS)"}`);
    console.log(`Subject: ${subject}`);
    console.log(text);
    const previewPath = path.join(__dirname, "trader-preview.html");
    fs.writeFileSync(previewPath, html);
    console.log(`\nHTML preview written to ${previewPath} — open it in a browser`);
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
      headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: config.email.from, to, subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  try {
    await send(recipients);
  } catch (err) {
    if (recipients.length < 2) throw err;
    console.error(`Send to all recipients failed (${err.message}) — retrying with ${recipients[0]} only`);
    await send([recipients[0]]);
  }
}

// --- main --------------------------------------------------------------------
async function main() {
  const verdicts = [];
  for (const coin of coins) {
    try {
      const series = await fetchSeries(coin, { granularity: traderCfg.granularity, limit: traderCfg.candles });
      const v = evaluateSignal(series, { coin });
      verdicts.push(v);
      const conf = Math.round((v.confidence ?? 0) * 100);
      console.log(`${coin}: ${v.verdict} (conf ${conf}%, regime ${v.regime?.trend}, R:R ${v.risk?.riskReward}) — ${v.reason}`);
    } catch (err) {
      console.error(`${coin}: signal failed — skipped: ${err.message}`);
    }
  }

  const toEmail = verdicts.filter(emailable);
  if (!toEmail.length) {
    console.log(`No actionable signals at >= ${Math.round(traderCfg.minConfidence * 100)}% confidence — nothing to email.`);
    return;
  }
  await sendEmail(buildSubject(toEmail), buildBodyText(toEmail), buildBodyHtml(toEmail));
  console.log(`${dryRun ? "Printed" : "Emailed"} signals for: ${toEmail.map((v) => v.coin).join(", ")}`);
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
