// backtest/calibrate.js — turn replay records into HONEST probabilities.
//
// The model emits a raw `confidence` in [0,1] — a prior, not a measured truth.
// This bins predictions by that confidence and computes the EMPIRICAL hit-rate in
// each bin, so the forecast can say "65% chance" only when ~65% of past calls at
// that confidence actually worked. Also breaks results down by regime and verdict.
//
// The headline number is `decisiveHitRate` = hits / (hits + misses) — P(target
// before stop | a call at this confidence), ignoring timeouts. Pure, deterministic.

const round3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : x);

function tally(records) {
  const t = { n: 0, hit: 0, miss: 0, flat: 0 };
  for (const r of records) { t.n++; if (r.label === "hit") t.hit++; else if (r.label === "miss") t.miss++; else t.flat++; }
  const decisive = t.hit + t.miss;
  return {
    ...t,
    hitRate: t.n ? round3(t.hit / t.n) : null,           // hits over ALL calls (timeouts count against)
    decisiveHitRate: decisive ? round3(t.hit / decisive) : null, // hits over hit+miss (the honest P)
  };
}

// Bin by confidence into `buckets` equal-width bins over [0,1].
export function bucketize(records, buckets = 10) {
  const bins = Array.from({ length: buckets }, (_, b) => ({ lo: round3(b / buckets), hi: round3((b + 1) / buckets), records: [] }));
  for (const r of records) {
    if (!Number.isFinite(r.confidence)) continue;
    const b = Math.min(buckets - 1, Math.max(0, Math.floor(r.confidence * buckets)));
    bins[b].records.push(r);
  }
  return bins.map(({ lo, hi, records }) => ({ lo, hi, ...tally(records) }));
}

// Group records by a meta key (e.g. "regime" or "verdict") -> tally per value.
export function groupBy(records, key) {
  const groups = {};
  for (const r of records) {
    const v = r.meta?.[key] ?? "unknown";
    (groups[v] ??= []).push(r);
  }
  const out = {};
  for (const [k, recs] of Object.entries(groups)) out[k] = tally(recs);
  return out;
}

// Full calibration object for a record set (typically the TRAIN split).
export function calibrate(records, { buckets = 10 } = {}) {
  return {
    overall: tally(records),
    byConfidence: bucketize(records, buckets),
    byRegime: groupBy(records, "regime"),
    byVerdict: groupBy(records, "verdict"),
  };
}

// Look up the calibrated probability for a raw confidence against a byConfidence
// table — what forecast mode will call at runtime. Falls back to the nearest
// populated bucket, then to overall, so a sparse bucket never returns null silently.
export function calibratedProbability(confidence, byConfidence, overall) {
  if (!Number.isFinite(confidence) || !byConfidence?.length) return overall?.decisiveHitRate ?? null;
  const idx = Math.min(byConfidence.length - 1, Math.max(0, Math.floor(confidence * byConfidence.length)));
  const here = byConfidence[idx];
  if (here && here.decisiveHitRate != null && (here.hit + here.miss) >= 20) return here.decisiveHitRate;
  // too few samples in this bucket — widen to the nearest populated neighbour
  for (let d = 1; d < byConfidence.length; d++) {
    for (const j of [idx - d, idx + d]) {
      const b = byConfidence[j];
      if (b && b.decisiveHitRate != null && (b.hit + b.miss) >= 20) return b.decisiveHitRate;
    }
  }
  return overall?.decisiveHitRate ?? null;
}

// Honesty check: apply a TRAIN-fit calibration to a held-out TEST set and measure
// how well the promised probability matched reality (mean |predicted − actual| over
// populated buckets — a small number means the calibration generalises).
export function evaluateOnTest(testRecords, trainCalibration, { buckets = 10 } = {}) {
  const testBuckets = bucketize(testRecords, buckets);
  let errSum = 0, weighted = 0, n = 0;
  const rows = testBuckets.map((tb, idx) => {
    const promised = trainCalibration.byConfidence[idx]?.decisiveHitRate ?? null;
    const actual = tb.decisiveHitRate;
    const decisive = tb.hit + tb.miss;
    if (promised != null && actual != null && decisive > 0) {
      const err = Math.abs(promised - actual);
      errSum += err; weighted += err * decisive; n++;
    }
    return { lo: tb.lo, hi: tb.hi, promised, actual, n: tb.n, decisive };
  });
  return {
    rows,
    meanAbsError: n ? round3(errSum / n) : null,
    weightedAbsError: weighted && testRecords.length ? round3(weighted / testRecords.filter((r) => r.label !== "flat").length) : null,
    overall: tally(testRecords),
  };
}
