// CARTO requires an API key on raster basemap tiles; unkeyed requests are served
// with an "API KEY REQUIRED" watermark. Free key from
// https://carto.com/basemaps/apikey/. Plain constant on purpose: this is a
// client bundle, so the key ships to the browser wherever it is declared.
export const CARTO_API_KEY = "cb1_2e23_1_bd24b1a55d41442abf180516";
