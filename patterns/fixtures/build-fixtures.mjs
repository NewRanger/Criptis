// Regenerate the JSON fixture snapshots from the deterministic builders in
// synth.js. Run:  node patterns/fixtures/build-fixtures.mjs
// The JSON files are committed so fixtures are inspectable without running code;
// the builders remain the source of truth.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ascendingTriangle, descendingTriangle, symmetricalTriangle, rectangle,
  risingWedge, fallingWedge, channelUp, channelDown,
  invalidatedChannelUp, invalidatedChannelDown, broadening, noise, twoTouchRisingWedge,
} from "./synth.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = {
  "ascending-triangle": ascendingTriangle(),
  "descending-triangle": descendingTriangle(),
  "symmetrical-triangle": symmetricalTriangle(),
  "rectangle": rectangle(),
  "rising-wedge": risingWedge(),
  "falling-wedge": fallingWedge(),
  "channel-up": channelUp(),
  "channel-down": channelDown(),
  "invalidated-channel-up": invalidatedChannelUp(),
  "invalidated-channel-down": invalidatedChannelDown(),
  "broadening": broadening(),
  "noise": noise(),
  "two-touch-rising-wedge": twoTouchRisingWedge(),
};

for (const [name, series] of Object.entries(out)) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(series, null, 2) + "\n");
  console.log(`wrote ${name}.json (${series.closes.length} candles)`);
}
