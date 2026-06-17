#!/usr/bin/env node
// backtest/run.mjs — calibrate the forecast against measured forward outcomes.
//
//   node backtest/run.mjs --fetch                 # fetch history, then calibrate
//   node backtest/run.mjs                          # reuse cached history
//   node backtest/run.mjs --coins=bitcoin,ethereum --granularity=3600 --candles=8760 \
//                          --horizon=24 --katr=1.5 --window=300 --split=0.7
//
// Walks each coin's history bar-by-bar (NO look-ahead), runs the signals.js
// directional call, labels the real forward outcome (triple-barrier), then learns
// the empirical probability behind each confidence level. Writes backtest/
// calibration.json — the file forecast mode will read so "65% chance" means ~65%
// of past calls at that confidence actually worked. Train/test split keeps it honest.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchHistory, saveCache, loadCache } from "./history.js";
import { replay, signalsPredictor } from "./replay.js";
import { calibrate, evaluateOnTest, calibratedProbability } from "./calibrate.js";
import { evaluateSignal } from "../signals.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, "..", "config.json");
const OUT_PATH = path.join(__dirname, "calibration.json");

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : def;
};
const num = (name, def) => { const v = Number(opt(name, def)); return Number.isFinite(v) ? v : def; };

const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
const coins = (opt("coins", "") ? opt("coins", "").split(",").map((s) => s.trim()).filter(Boolean) : config.coins) ?? ["bitcoin"];
const params = {
  granularity: num("granularity", 3600), // 1h — matches the hourly forecast horizon
  candles: num("candles", 8760),          // ~1 year of hourly history per coin
  horizon: num("horizon", 24),            // score the next ~6–24h (24 hourly bars)
  kAtr: num("katr", 1.5),                 // target/stop distance in ATR units
  window: num("window", 300),             // rolling lookback handed to the model
  warmup: num("warmup", 60),              // signals.js needs >= 60 bars
  split: num("split", 0.7),               // train fraction (rest is held-out test)
  buckets: num("buckets", 10),
  doFetch: flag("fetch"),
};

const pct = (x) => (x == null ? "  —  " : `${(x * 100).toFixed(1)}%`.padStart(6));

async function main() {
  console.log(`Backtest: ${coins.join(", ")} @ ${params.granularity}s, horizon ${params.horizon} bars, target/stop ${params.kAtr}·ATR\n`);

  const all = [];
  for (const coin of coins) {
    let history = params.doFetch ? null : loadCache(coin, params.granularity);
    if (!history) {
      if (!params.doFetch) {
        console.error(`No cache for ${coin} @ ${params.granularity}s — re-run with --fetch to download history.`);
        continue;
      }
      console.log(`Fetching ${coin} (${params.candles} candles)…`);
      history = await fetchHistory(coin, { granularity: params.granularity, totalCandles: params.candles });
      saveCache(history);
    }
    const records = replay(history, signalsPredictor(evaluateSignal), {
      horizon: params.horizon, kAtr: params.kAtr, sliceWindow: params.window, warmup: params.warmup,
    });
    for (const r of records) r.meta = { ...r.meta, coin };
    const c = calibrate(records);
    console.log(
      `  ${coin.padEnd(10)} ${history.closes.length} bars → ${records.length} calls · ` +
      `hit ${c.overall.hit}/miss ${c.overall.miss}/flat ${c.overall.flat} · decisive ${pct(c.overall.decisiveHitRate)}`,
    );
    all.push(...records);
  }

  if (!all.length) {
    console.error("\nNo records produced. Did you fetch history (--fetch)?");
    process.exit(1);
  }

  // Time-ordered train/test split — honesty: calibrate on the past, check on the future.
  all.sort((a, b) => a.t - b.t);
  const trainN = Math.floor(all.length * params.split);
  const train = all.slice(0, trainN);
  const test = all.slice(trainN);
  const cal = calibrate(train, { buckets: params.buckets });
  const testEval = test.length ? evaluateOnTest(test, cal, { buckets: params.buckets }) : null;

  // --- report ----------------------------------------------------------------
  console.log(`\n=== Calibration (train ${train.length} / test ${test.length}) ===`);
  console.log(`overall: decisive hit-rate ${pct(cal.overall.decisiveHitRate)} (hit ${cal.overall.hit} / miss ${cal.overall.miss} / flat ${cal.overall.flat})`);
  console.log(`\nconfidence bucket   calls   hit%   decisive%   (calibrated probability shown to the user)`);
  for (const b of cal.byConfidence) {
    if (!b.n) continue;
    console.log(`  ${pct(b.lo)}–${pct(b.hi)}   ${String(b.n).padStart(6)}   ${pct(b.hitRate)}   ${pct(b.decisiveHitRate)}`);
  }
  console.log(`\nby regime:`);
  for (const [k, t] of Object.entries(cal.byRegime)) console.log(`  ${k.padEnd(8)} decisive ${pct(t.decisiveHitRate)} (n ${t.n})`);
  console.log(`by verdict:`);
  for (const [k, t] of Object.entries(cal.byVerdict)) console.log(`  ${k.padEnd(12)} decisive ${pct(t.decisiveHitRate)} (n ${t.n})`);
  if (testEval) {
    console.log(`\nout-of-sample test: mean |promised − actual| = ${testEval.meanAbsError ?? "—"} (lower = better calibrated)`);
    console.log(`test overall decisive hit-rate ${pct(testEval.overall.decisiveHitRate)} (n ${testEval.overall.n})`);
  }

  // --- write calibration.json (forecast mode reads this) ---------------------
  const out = {
    generatedAt: new Date().toISOString(),
    params,
    coins,
    samples: { total: all.length, train: train.length, test: test.length },
    train: cal,
    test: testEval,
  };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(path.join(__dirname, ".."), OUT_PATH)} — forecast mode will read this for honest probabilities.`);

  // sanity preview of the lookup forecast mode performs
  const demo = [0.3, 0.5, 0.7, 0.85];
  console.log(`\ncalibrated probability lookup (confidence → P): ` +
    demo.map((c) => `${c}→${pct(calibratedProbability(c, cal.byConfidence, cal.overall))}`).join("  "));
}

main().catch((err) => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
