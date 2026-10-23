// @ts-check
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

import { precacheUrl } from "./src/lib/pageCache.ts";

// ArcGIS's projection engine, a WASM file the geometry worker loads for
// geodesic questions, is served with the app instead of from js.arcgis.com:
// the service worker precaches it, so questions work without a connection,
// and it is the very build of the installed @arcgis/core. Its path names
// that version, so it can be cached as immutable like the rest of /_astro/.
const arcgisDir = dirname(
    createRequire(import.meta.url).resolve("@arcgis/core/package.json"),
);
const arcgisVersion = JSON.parse(
    readFileSync(join(arcgisDir, "package.json"), "utf8"),
).version;
const ARCGIS_ASSETS_PATH = `/_astro/arcgis-${arcgisVersion}`;
const PE_WASM = "esri/geometry/support/pe-wasm.wasm";

/** @returns {import("astro").AstroIntegration} */
function arcgisAssets() {
    const source = join(arcgisDir, "assets", PE_WASM);
    return {
        name: "searchlight:arcgis-assets",
        hooks: {
            "astro:server:setup": ({ server }) => {
                server.middlewares.use(
                    `${ARCGIS_ASSETS_PATH}/${PE_WASM}`,
                    (_req, res) => {
                        res.setHeader("Content-Type", "application/wasm");
                        createReadStream(source).pipe(res);
                    },
                );
            },
            // Before the service worker's precache list is made
            "astro:build:done": async ({ dir }) => {
                const target = fileURLToPath(
                    new URL(`.${ARCGIS_ASSETS_PATH}/${PE_WASM}`, dir),
                );
                await mkdir(dirname(target), { recursive: true });
                await copyFile(source, target);
            },
        },
    };
}

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        tailwind({
            applyBaseStyles: false,
        }),
        // Before AstroPWA, whose build:done precaches what it copies
        arcgisAssets(),
        AstroPWA({
            // src/sw.ts, built with the precache list injected.
            strategies: "injectManifest",
            srcDir: "src",
            filename: "sw.ts",
            // src/lib/serviceWorker.tsx registers it and offers new builds.
            registerType: "prompt",
            injectRegister: false,
            injectManifest: {
                rollupFormat: "iife",
                // The plugin adds the manifest itself.
                globPatterns: [
                    "**/*.{js,css,html,png,svg,ico,wasm}",
                    // The in-game alarm
                    "Mountain Audio - Alarm.mp3",
                ],
                // Files for AI agents and tools, not for the app
                globIgnores: ["skills/**", "schemas/**"],
                // Above Workbox's 2 MB default: ArcGIS's projection engine
                // WASM is 2.8 MB (its geometry chunks are about 1.5 MB).
                maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
                // Pages by the URL the server shows them at (src/sw.ts finds
                // them by it).
                manifestTransforms: [
                    async (entries) => ({
                        manifest: entries.map((entry) => ({
                            ...entry,
                            url: precacheUrl(entry.url),
                        })),
                        warnings: [],
                    }),
                ],
            },
            manifest: {
                id: "/",
                name: "Searchlight",
                short_name: "Searchlight",
                description:
                    "A map planner for Jet Lag: The Game's Hide and Seek",
                // The map, not the login page, which sends players on to
                // the map only once the server answers. The map sends
                // visitors who aren't logged in to log in; without a
                // connection it opens empty and loads once /me answers.
                start_url: "/map",
                scope: "/",
                display: "standalone",
                // The pages' dark background (globals.css, .dark)
                background_color: "#020817",
                theme_color: "#020817",
                categories: ["games", "navigation", "travel"],
                icons: [
                    {
                        src: "/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "any",
                    },
                    {
                        src: "/maskable-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                        purpose: "maskable",
                    },
                    {
                        src: "/maskable-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                        purpose: "maskable",
                    },
                ],
                shortcuts: [
                    {
                        name: "Games",
                        description: "Manage your servers' games",
                        url: "/games",
                        icons: [
                            {
                                src: "/android-chrome-192x192.png",
                                sizes: "192x192",
                                type: "image/png",
                            },
                        ],
                    },
                ],
            },
        }),
    ],
    vite: {
        define: {
            // src/maps/geo-utils/geometry.worker.ts
            __ARCGIS_ASSETS_PATH__: JSON.stringify(ARCGIS_ASSETS_PATH),
        },
        // Read PUBLIC_* settings from the repo-root .env shared with the API.
        envDir: fileURLToPath(new URL("../..", import.meta.url)),
        worker: {
            format: "es",
            // One file: Safari evaluates a module worker's entry a second
            // time when a split chunk imports it, so ArcGIS's lazily loaded
            // operators would run against a copy whose projection engine
            // was never loaded.
            rollupOptions: { output: { inlineDynamicImports: true } },
        },
    },
    devToolbar: {
        enabled: false,
    },
    site: "https://searchlight.jetlageuropa.org",
    base: "/",
});
