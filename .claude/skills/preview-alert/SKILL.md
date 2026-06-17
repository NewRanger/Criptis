---
name: preview-alert
description: Preview a Criptis alert email locally without sending it and without dirtying state.json. Use when asked to preview/test the alert email, see the rendered card, check the AI analysis paragraph, or verify email rendering after changing watcher.js, prompts/analysis.md, or pattern copy. Handles the env vars and the state.json cleanup.
---

# Preview an alert email

`node watcher.js --dry-run` renders the alert **without sending** and **without
writing `state.json`**. It writes the full HTML email to `email-preview.html`
(gitignored) and prints the plain-text body + the per-coin pattern-alert
evaluation. Open `email-preview.html` in a browser to see the card exactly as it
sends.

```powershell
node watcher.js --dry-run
```

- **No Resend key needed** for `--dry-run` (nothing is sent).
- **The Anthropic call still fires** in dry-run **if `ANTHROPIC_API_KEY` is set** —
  so a real-price dry-run during an actual breakout previews the real AI paragraph.
  To preview the AI paragraph, set the key first (PowerShell):
  ```powershell
  $env:ANTHROPIC_API_KEY = "<sk-ant-...>"; node watcher.js --dry-run
  ```
- User-facing output (email + AI paragraph) must be **Georgian**, beginner-friendly
  — that's what you're checking.

## The catch: there may be nothing to preview

A plain `--dry-run` only renders a card for a coin that **actually triggers right
now**. Currently all three price triggers (`changeThresholdPct`,
`driftThresholdPct`, `streakLength`) are **paused (`null`)** in
[config.json](../../../config.json), so the only live path is **pattern alerts**,
which fire only when a coin's real candles form a high-confidence active pattern.
The dry-run output's `pattern-alert evaluation` section tells you per coin whether
it would fire (`=> pattern alert: YES`). If everything says `no`, use a recipe
below to force a card. **`--mock-price` does NOT trigger anything while the price
triggers are null** (and it synthesises flat candles → no patterns either).

## Recipes to force a card

Pick by which part of the email you want to see. Each ends with a cleanup step —
temporary edits to `config.json` / `state.json` must be reverted (the repo owner
commits these files; a stray local edit must not leak in).

### A. Preview a price-trigger card (raw-numbers "structural" alert)

`--mock-price` synthesises a flat candle series, so it fails the Bollinger
breakout pre-filter → you get the structural (raw-numbers) card + the Georgian
`STRUCTURAL_NOTE`, not the AI paragraph. The change trigger needs history to
compare against and an un-paused threshold:

```powershell
# 1. temporarily un-pause a price trigger: set "changeThresholdPct": 1.5 in config.json
# 2. seed one real data point (writes state.json):
node watcher.js
# 3. force a big "move" vs that seed and preview (no send, no state write):
node watcher.js --dry-run --mock-price 1
# 4. cleanup — discard the seeded state AND the config edit:
git restore state.json config.json
```

### B. Preview the AI-analysis paragraph

The AI paragraph needs **real candles** clearing the Bollinger + volume pre-filter
(mock prices can't), so this is opportunistic — run it when a real breakout is live:

```powershell
$env:ANTHROPIC_API_KEY = "<sk-ant-...>"; node watcher.js --dry-run
```

To make a live breakout actually reach the LLM while the price triggers are paused,
temporarily un-pause a trigger (recipe A, step 1) so the breakout coin triggers,
then `git restore config.json` after. The dry-run logs `pre-filter PASS … calling
analyze()` for any coin that reaches the model.

### C. Preview a pattern-alert card

This is the currently-active path. If `--dry-run`'s evaluation shows no coin at
`YES`, temporarily lower the bar in `config.json` →
`"patternAlerts": { "minConfidence": 0.1 }`, run `node watcher.js --dry-run`, then
`git restore config.json`. The card renders from `PATTERN_COPY` in
[watcher.js](../../../watcher.js) (Georgian, beginner copy).

## After previewing

- Open `email-preview.html` in a browser (HTML card + QuickChart sparkline); the
  printed plain-text body is the fallback clients see when HTML is blocked.
- Confirm `git status` is clean — `state.json` and `config.json` must be unchanged
  (run the `git restore` cleanup if not). `email-preview.html` is gitignored.
- **Do not commit or push.** Report what you previewed; the repo owner commits.
