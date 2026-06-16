// Regenerate the JSON fixture snapshots from the deterministic builders in
// synth.js. Run:  node patterns/fixtures/build-fixtures.mjs
// The JSON files are committed so fixtures are inspectable without running code;
// the builders remain the source of truth.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ascendingTriangle, descendingTriangle, channelUp, channelDown, flatRange,
  invalidatedChannelUp, invalidatedChannelDown,
} from "./synth.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = {
  "ascending-triangle": ascendingTriangle(),
  "descending-triangle": descendingTriangle(),
  "channel-up": channelUp(),
  "channel-down": channelDown(),
  "flat-range": flatRange(),
  "invalidated-channel-up": invalidatedChannelUp(),
  "invalidated-channel-down": invalidatedChannelDown(),
};

for (const [name, series] of Object.entries(out)) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(series, null, 2) + "\n");
  console.log(`wrote ${name}.json (${series.closes.length} candles)`);
}
