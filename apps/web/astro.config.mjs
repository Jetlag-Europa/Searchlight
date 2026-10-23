// @ts-check
import { fileURLToPath } from "node:url";

import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";
import AstroPWA from "@vite-pwa/astro";
import { defineConfig } from "astro/config";

import { precacheUrl } from "./src/lib/pageCache.ts";

// https://astro.build/config
export default defineConfig({
    integrations: [
        react(),
        tailwind({
            applyBaseStyles: false,
        }),
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
                    "**/*.{js,css,html,png,svg,ico}",
                    // The in-game alarm
                    "Mountain Audio - Alarm.mp3",
                ],
                // Files for AI agents and tools, not for the app
                globIgnores: ["skills/**", "schemas/**"],
                // ArcGIS's projection engine alone is about 5 MB.
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
                // The map, not the login page: it opens without a
                // connection, and sends visitors who aren't logged in to log
                // in.
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
