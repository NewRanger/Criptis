#!/usr/bin/env node
// backtest/volforecast.mjs — is VOLATILITY (the "storm") predictable at 60–70%?
//
// Direction is a random walk (see structure.mjs). This tests the thing that ISN'T:
// will the next `horizon` bars be turbulent? Predict "high vol ahead" when current
// realized vol is above its own trailing median (volatility clustering), then check
// what actually happened. NO look-ahead: prediction at i uses returns up to i; the
// threshold is the median known at i; the outcome uses returns strictly after i.
//
//   node backtest/volforecast.mjs --coins=bitcoin,... --granularity=3600 --horizon=24

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadCache } from "./history.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const argv = process.argv.slice(2);
const opt = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.split("=").slice(1).join("=") : d; };
const num = (n, d) => { const v = Number(opt(n, d)); return Number.isFinite(v) ? v : d; };

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = (opt("coins", "") ? opt("coins", "").split(",").map((s) => s.trim()).filter(Boolean) : config.coins) ?? ["bitcoin"];
const granularity = num("granularity", 3600);
const W = num("win", 24);       // vol estimation window (bars)
const H = num("horizon", 24);   // forecast horizon (bars)
const M = num("median", 240);   // trailing window for the "normal vol" threshold

const mean = (a) => a.reduce((s, x) => s + x, 0) / (a.length || 1);
const std = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const logReturns = (c) => { const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1])); return r; };
const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);

console.log(`Volatility forecast @ ${granularity}s — vol window ${W}, horizon ${H}, threshold = trailing median(${M})\n`);
console.log(`coin         preds   baseRate   accuracy   precision(storm)   recall`);

const pool = { tp: 0, fp: 0, tn: 0, fn: 0, n: 0 };
for (const coin of coins) {
  const h = loadCache(coin, granularity);
  if (!h) { console.log(`  ${coin.padEnd(10)} (no cache — run backtest --fetch first)`); continue; }
  const r = logReturns(h.closes);
  // realized vol at each bar from the trailing W returns (index aligned to r)
  const rv = [];
  for (let i = 0; i < r.length; i++) rv.push(i + 1 >= W ? std(r.slice(i - W + 1, i + 1)) : NaN);

  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (let i = W - 1; i + H < r.length; i++) {
    const trail = rv.slice(Math.max(0, i - M + 1), i + 1).filter(Number.isFinite);
    if (trail.length < Math.min(M, 30)) continue;
    const thr = median(trail);                 // "normal" vol level KNOWN at bar i
    if (!(thr > 0) || !Number.isFinite(rv[i])) continue;
    const predHigh = rv[i] > thr;              // prediction: turbulence persists
    const futureVol = std(r.slice(i + 1, i + 1 + H)); // outcome: strictly future bars
    const actualHigh = futureVol > thr;
    if (predHigh && actualHigh) tp++;
    else if (predHigh && !actualHigh) fp++;
    else if (!predHigh && !actualHigh) tn++;
    else fn++;
  }
  const n = tp + fp + tn + fn;
  const acc = n ? (tp + tn) / n : 0;
  const base = n ? (tp + fn) / n : 0;            // how often it's actually high (class balance)
  const prec = tp + fp ? tp / (tp + fp) : 0;     // when we warn "storm", how often right
  const rec = tp + fn ? tp / (tp + fn) : 0;
  console.log(`  ${coin.padEnd(10)} ${String(n).padStart(6)}   ${pct(base)}   ${pct(acc)}   ${pct(prec).padStart(10)}        ${pct(rec)}`);
  pool.tp += tp; pool.fp += fp; pool.tn += tn; pool.fn += fn; pool.n += n;
}

if (pool.n) {
  const acc = (pool.tp + pool.tn) / pool.n;
  const base = (pool.tp + pool.fn) / pool.n;
  const prec = pool.tp + pool.fp ? pool.tp / (pool.tp + pool.fp) : 0;
  const rec = pool.tp + pool.fn ? pool.tp / (pool.tp + pool.fn) : 0;
  console.log(`  ${"POOLED".padEnd(10)} ${String(pool.n).padStart(6)}   ${pct(base)}   ${pct(acc)}   ${pct(prec).padStart(10)}        ${pct(rec)}`);
  console.log(`\n  accuracy = overall correct;  precision(storm) = when it warns of a big move, how often one comes.`);
}
