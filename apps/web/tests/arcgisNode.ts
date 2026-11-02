import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

import esriConfig from "@arcgis/core/config.js";

// ArcGIS's projection engine is WASM built for browsers. Node runs it given
// CommonJS's globals and the package's own copy of the WASM. Import this
// before loading any geodetic operator.
const require = createRequire(import.meta.url);
const arcgisDir = dirname(require.resolve("@arcgis/core/package.json"));
Object.assign(globalThis, { require, __dirname: arcgisDir });
esriConfig.assetsPath = resolve(arcgisDir, "assets");
