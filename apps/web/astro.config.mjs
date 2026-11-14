// @ts-check
import { createReadStream, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

import { precacheUrl } from "./src/lib/pageCache.ts";

// react-leaflet-draw imports a default export from leaflet-draw, a plain
// script that only adds L.Draw to the global Leaflet. Rollup let the missing
// export through with a warning; Rolldown fails the build. The import is only
// there for its side effect, so keep just that.
const leafletDrawSideEffectImport = {
    name: "searchlight:leaflet-draw-side-effect-import",
    transform: {
        filter: {
            id: /react-leaflet-draw[\\/]dist[\\/]esm[\\/]EditControl\.js$/,
        },
        /** @param {string} code */
        handler(code) {
            return code.replace(
                /import Draw from 'leaflet-draw';/,
                "import 'leaflet-draw';",
            );
        },
    },
};

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
                        createReadStream(source)
                            .on("error", () => res.writeHead(404).end())
                            .pipe(res);
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

// Vite 6's default browsers. Vite 8 moved to Baseline (Safari/iOS 16.4,
// Chrome 111), whose range media queries older phones ignore. Vite 6 also
// listed "es2020", but Astro adds "esnext" to the client build's list and
// Rolldown rejects two ES versions.
const BROWSERS = ["edge88", "firefox78", "chrome87", "safari14"];

// https://astro.build/config
export default defineConfig({
    // Astro 7 strips whitespace between inline elements JSX-style by default;
    // keep the HTML collapsing the pages were written for.
    compressHTML: true,
    integrations: [
        react(),
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
                // A classic script: registerSW (virtual:pwa-register)
                // registers it without `type: "module"`.
                rollupFormat: "iife",
                // The plugin takes these from the Vite config it sees, which
                // under Astro 7 is the server build's: unminified, and not
                // the browsers the pages are built for.
                minify: true,
                target: BROWSERS,
                // The plugin adds the manifest itself.
                globPatterns: [
                    "**/*.{js,css,html,png,svg,ico,wasm}",
                    // The in-game alarm
                    "Mountain Audio - Alarm.mp3",
                ],
                globIgnores: [
                    // Files for AI agents and tools, not for the app
                    "skills/**",
                    "schemas/**",
                ],
                // Above Workbox's 2 MB default: ArcGIS's projection engine
                // WASM is 2.8 MB.
                maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
                manifestTransforms: [
                    // Pages by the URL the server shows them at (src/sw.ts
                    // finds them by it).
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
        plugins: [leafletDrawSideEffectImport],
        // The dev server pre-bundles react-leaflet-draw, outside Vite's plugins.
        optimizeDeps: {
            rolldownOptions: { plugins: [leafletDrawSideEffectImport] },
        },
        build: {
            target: BROWSERS,
            cssTarget: BROWSERS,
        },
        // Read PUBLIC_* settings from the repo-root .env shared with the API.
        envDir: fileURLToPath(new URL("../..", import.meta.url)),
        // Tailwind 3 through PostCSS, as @astrojs/tailwind (which doesn't
        // support Astro 6+) set it up. src/styles/globals.css has the
        // @tailwind directives.
        css: {
            postcss: {
                plugins: [
                    tailwindcss(
                        fileURLToPath(
                            new URL("./tailwind.config.mjs", import.meta.url),
                        ),
                    ),
                    autoprefixer(),
                ],
            },
        },
        worker: {
            format: "es",
            // One file: Safari evaluates a module worker's entry a second
            // time when a split chunk imports it, so ArcGIS's lazily loaded
            // operators would run against a copy whose projection engine
            // was never loaded.
            rolldownOptions: { output: { codeSplitting: false } },
        },
    },
    devToolbar: {
        enabled: false,
    },
    // The import page took over from /designer; older guides link to it.
    redirects: {
        "/designer": "/games/import",
    },
    site: "https://searchlight.jetlageuropa.org",
    base: "/",
});
