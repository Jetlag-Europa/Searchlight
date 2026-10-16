// @ts-check
import { fileURLToPath } from "node:url";

import partytown from "@astrojs/partytown";
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
        partytown({
            config: {
                forward: ["dataLayer.push"],
            },
        }),
        AstroPWA({
            workbox: {
                // Activate new builds on first reload instead of waiting two reloads.
                skipWaiting: true,
                clientsClaim: true,
                maximumFileSizeToCacheInBytes: 15 * 1024 * 1024,
            },
            manifest: {
                name: "Jet Lag Hide and Seek Map Generator",
                short_name: "Map Generator",
                description:
                    "Automatically generate maps for Jet Lag The Game: Hide and Seek with ease! Simply name the questions and watch the map eliminate hundreds of possibilities in seconds.",
                icons: [
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/JLIcon.png",
                        sizes: "1080x1080",
                        type: "image/png",
                    },
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/android-chrome-192x192.png",
                        sizes: "192x192",
                        type: "image/png",
                    },
                    {
                        src: "https://taibeled.github.io/JetLagHideAndSeek/android-chrome-512x512.png",
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
        worker: { format: "es" },
    },
    devToolbar: {
        enabled: false,
    },
    site: "https://searchlight.jetlageuropa.org",
    base: "/",
});
