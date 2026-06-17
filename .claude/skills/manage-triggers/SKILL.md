---
name: manage-triggers
description: Pause, restore, or tune Criptis alert triggers in config.json. Use when asked to enable/disable/pause/resume a trigger, change a threshold, make alerts noisier/quieter, or turn pattern alerts on/off. Covers the three price triggers and the pattern-alert path.
---

# Manage alert triggers

All trigger behaviour lives in [config.json](../../../config.json) (committed, no
secrets). The watcher reads each value defensively: a price trigger is **active
only when its value is a finite number**, and **`null` (or a missing key) pauses
it**. There are two independent alert paths.

## The three price triggers

| key | fires when… | restore default | pause |
|---|---|---|---|
| `changeThresholdPct` | move since last check (~1–2h) exceeds this % | `1.5` | `null` |
| `driftThresholdPct` | price has drifted this % from ~24h ago (slow bleed) | `4` | `null` |
| `streakLength` | this many checks in a row move the same direction | `5` | `null` |

- Lower number = **noisier**, higher = **quieter**.
- `streakLength` needs **≥ 2** to mean anything — `0`, `1`, and `null` all read as
  paused.
- `driftThresholdPct` is edge-triggered (fires once per sustained move, re-arms on
  reversal); `streakLength` re-fires every N checks while the run continues.
- **Current state:** all three are `null` (paused) — only **pattern alerts** raise
  emails right now.

To **pause** a trigger, set it to `null`. To **restore**, set the numeric value:
```json
"changeThresholdPct": 1.5,
"driftThresholdPct": 4,
"streakLength": 5,
```

## The pattern-alert path

```json
"patternAlerts": { "enabled": true, "minConfidence": 0.75, "cooldownHours": 12 }
```

- `enabled` — `true` only when literally `true`; anything else is off. This path is
  independent and never weakens the price triggers.
- `minConfidence` — `[0,1]`; only patterns at/above this raise an educational
  Georgian email. Lower = more pattern alerts.
- `cooldownHours` — the same coin+pattern stays muted this long after alerting.

## Steps

1. Edit the relevant key(s) in [config.json](../../../config.json). Keep it valid
   JSON (use `null`, not `"null"` or `0`, to pause a price trigger).
2. Verify with a dry run — it prints which coins would trigger and the per-coin
   pattern-alert evaluation, without sending or writing state:
   ```powershell
   node watcher.js --dry-run
   ```
3. To actually see a resulting email rendered, use
   [/preview-alert](../preview-alert/SKILL.md).

## Notes

- `config.json` is committed and drives CI — the change takes effect on the next
  hourly run.
- **Do not commit or push.** The repo owner commits `config.json` themselves;
  state plainly which values you changed (from → to) and let them review.
