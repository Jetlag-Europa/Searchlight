// @ts-check
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        tailwind({
            applyBaseStyles: false,
        }),
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
    // The import page took over from /designer; older guides link to it.
    redirects: {
        "/designer": "/games/import",
    },
    site: "https://searchlight.jetlageuropa.org",
    base: "/",
});
