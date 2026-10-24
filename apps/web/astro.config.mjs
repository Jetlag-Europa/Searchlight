// @ts-check
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";
import autoprefixer from "autoprefixer";
import tailwindcss from "tailwindcss";

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

// https://astro.build/config
export default defineConfig({
    // Astro 7 strips whitespace between inline elements JSX-style by default;
    // keep the HTML collapsing the pages were written for.
    compressHTML: true,
    integrations: [
        react(),
        AstroPWA({
            workbox: {
                // Activate new builds on first reload instead of waiting two reloads.
                skipWaiting: true,
                clientsClaim: true,
                maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
            },
            manifest: {
                name: "Searchlight",
                short_name: "Searchlight",
                description:
                    "A map planner for Jet Lag: The Game's Hide and Seek",
                icons: [
                    {
                        src: "/JLIcon.png",
                        sizes: "1080x1080",
                        type: "image/png",
                    },
                    {
                        src: "/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "/android-chrome-512x512.png",
                        sizes: "512x512",
                        type: "image/png",
                    },
                ],
                theme_color: "#1F2F3F",
            },
        }),
    ],
    vite: {
        plugins: [leafletDrawSideEffectImport],
        // The dev server pre-bundles react-leaflet-draw, outside Vite's plugins.
        optimizeDeps: {
            rolldownOptions: { plugins: [leafletDrawSideEffectImport] },
        },
        // Vite 6's default browsers. Vite 8 moved to Baseline (Safari/iOS
        // 16.4, Chrome 111), whose range media queries older phones ignore.
        // Vite 6 also listed "es2020", but Astro adds "esnext" to the client
        // build's list and Rolldown rejects two ES versions.
        build: {
            target: ["edge88", "firefox78", "chrome87", "safari14"],
            cssTarget: ["edge88", "firefox78", "chrome87", "safari14"],
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
    site: "https://searchlight.jetlageuropa.org",
    base: "/",
});
