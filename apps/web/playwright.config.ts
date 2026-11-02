import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the headless integration layer (Phase 3+).
 *
 * Runs against the isolated `searchlight-test` Docker stack (bring it up first with
 * `infra/deploy-test.sh`): web on :8280, api on :3200. Override with WEB_BASE /
 * API_BASE env vars if you point it elsewhere. Specs are named `*.e2e.ts` so
 * Vitest (which claims `*.test.ts`/`*.spec.ts`) never tries to run them.
 */
// 127.0.0.1, not localhost: the stack binds IPv4 only and Chromium resolves
// localhost to IPv6 (::1) → ERR_CONNECTION_REFUSED.
const WEB_BASE = process.env.WEB_BASE ?? "http://127.0.0.1:8280";
const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3200";

export default defineConfig({
    testDir: "./e2e",
    testMatch: "**/*.e2e.ts",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: "list",
    use: {
        baseURL: WEB_BASE,
        trace: "on-first-retry",
        // The PWA service worker serves pages and scripts from its precache,
        // so a test could run the build it cached instead of the deployed
        // one. It's only caching — irrelevant to the assertions — so block it.
        serviceWorkers: "block",
    },
    metadata: { apiBase: API_BASE },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
});
