#!/usr/bin/env node
// backtest/structure.mjs — does the price series even HAVE exploitable structure?
//
// Before investing in fancy features, measure whether returns carry momentum
// (trends persist → trend-following can work), mean-reversion (extremes snap back →
// fade them), or neither (a random walk → NO directional feature will ever beat 50%,
// and we should pivot to what IS predictable: volatility/risk).
//
//   node backtest/structure.mjs --coins=bitcoin,... --granularity=3600
//
// Metrics (per coin + pooled):
//   • return autocorrelation at lags 1/2/5  — >0 momentum, <0 mean-reversion, ~0 noise
//   • variance ratio VR(k)                  — >1 trending, <1 mean-reverting, ~1 random walk
//   • sign persistence  P(next bar same sign) — >50% momentum, <50% reversal
//   • |return| autocorrelation (lag 1)      — volatility clustering (this IS usually predictable)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCache } from "./history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");

const argv = process.argv.slice(2);
const opt = (name, def) => { const h = argv.find((a) => a.startsWith(`--${name}=`)); return h ? h.split("=").slice(1).join("=") : def; };
const num = (name, def) => { const v = Number(opt(name, def)); return Number.isFinite(v) ? v : def; };

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = (opt("coins", "") ? opt("coins", "").split(",").map((s) => s.trim()).filter(Boolean) : config.coins) ?? ["bitcoin"];
const granularity = num("granularity", 3600);
const ks = (opt("vr", granularity >= 86400 ? "2,3,5" : "6,12,24")).split(",").map(Number);

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const logReturns = (c) => { const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1])); return r; };

function autocorr(x, lag) {
  const m = mean(x), n = x.length;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - m) ** 2;
  for (let i = lag; i < n; i++) num += (x[i] - m) * (x[i - lag] - m);
  return den ? num / den : 0;
}

// Variance ratio: Var(k-period return) / (k · Var(1-period return)). 1 = random walk.
function varianceRatio(r, k) {
  const m = mean(r);
  const var1 = mean(r.map((x) => (x - m) ** 2));
  if (!var1) return 1;
  const kret = [];
  for (let i = 0; i + k <= r.length; i++) { let s = 0; for (let j = 0; j < k; j++) s += r[i + j]; kret.push(s); }
  const mk = mean(kret);
  const vark = mean(kret.map((x) => (x - mk) ** 2));
  return vark / (k * var1);
}

function signPersistence(r) {
  let same = 0, tot = 0;
  for (let i = 1; i < r.length; i++) { if (r[i] === 0 || r[i - 1] === 0) continue; tot++; if (Math.sign(r[i]) === Math.sign(r[i - 1])) same++; }
  return tot ? same / tot : 0.5;
}

const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
const sgn = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`.padStart(7);

console.log(`Market structure @ ${granularity}s — ${coins.join(", ")}\n`);
console.log(`coin        bars   ac(1)   ac(2)   ac(5)   ${ks.map((k) => `VR(${k})`.padStart(7)).join("  ")}   signP   |r|ac(1)`);

const pooled = { ac1: [], ac2: [], ac5: [], vr: ks.map(() => []), sp: [], vac: [], n: 0 };
for (const coin of coins) {
  const h = loadCache(coin, granularity);
  if (!h) { console.log(`  ${coin.padEnd(10)} (no cache — run backtest --fetch first)`); continue; }
  const r = logReturns(h.closes);
  const ac1 = autocorr(r, 1), ac2 = autocorr(r, 2), ac5 = autocorr(r, 5);
  const vr = ks.map((k) => varianceRatio(r, k));
  const sp = signPersistence(r);
  const vac = autocorr(r.map(Math.abs), 1);
  console.log(`  ${coin.padEnd(10)} ${String(r.length).padStart(5)} ${sgn(ac1)} ${sgn(ac2)} ${sgn(ac5)}   ${vr.map((v) => v.toFixed(3).padStart(7)).join("  ")}   ${pct(sp)}  ${sgn(vac)}`);
  pooled.ac1.push(ac1); pooled.ac2.push(ac2); pooled.ac5.push(ac5); vr.forEach((v, i) => pooled.vr[i].push(v)); pooled.sp.push(sp); pooled.vac.push(vac); pooled.n++;
}

if (pooled.n) {
  console.log(`  ${"POOLED".padEnd(10)} ${"".padStart(5)} ${sgn(mean(pooled.ac1))} ${sgn(mean(pooled.ac2))} ${sgn(mean(pooled.ac5))}   ${pooled.vr.map((a) => mean(a).toFixed(3).padStart(7)).join("  ")}   ${pct(mean(pooled.sp))}  ${sgn(mean(pooled.vac))}`);
  console.log(`\nRead it:`);
  console.log(`  • return autocorr & sign-persistence near 0 / 50%  → random walk (no directional edge possible)`);
  console.log(`  • VR(k) > 1 → momentum (trend-follow);  < 1 → mean-reversion (fade);  ≈ 1 → random walk`);
  console.log(`  • |r| autocorr clearly > 0 → volatility IS predictable even when direction is not (build risk/vol alerts)`);
}
