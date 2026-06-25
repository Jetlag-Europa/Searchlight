import { test as base, expect, type Page } from "@playwright/test";

/**
 * Shared e2e fixtures. `API_BASE` is where the test stack's API lives; the web
 * app and API are both on `localhost` (different ports) so the SameSite=Lax
 * session cookie is sent on cross-port requests — meaning a test-login performed
 * through the browser context authenticates subsequent app calls too.
 */
export const API_BASE = process.env.API_BASE ?? "http://127.0.0.1:3200";

/** The deterministic IDs created by `pnpm --filter api seed:test`. */
export const TEST_USER_ID = process.env.TEST_AUTH_USER_ID ?? "e2e-test-user";
export const TEST_SESSION_ID = "e2e-session";

/**
 * Logs in via POST /auth/test-login using the page's own request context, so the
 * session cookie is stored in the browser context and sent on later app/API
 * calls. Returns once the cookie is set.
 */
export async function testLogin(
    page: Page,
    discordId: string = TEST_USER_ID,
): Promise<void> {
    const res = await page.request.post(`${API_BASE}/auth/test-login`, {
        data: { discordId },
    });
    expect(res.ok(), `test-login failed: ${res.status()}`).toBeTruthy();
}

/** Resolves when `window.__taibled` is installed (the Map component has mounted). */
export async function waitForTestHook(page: Page): Promise<void> {
    await page.waitForFunction(
        () => typeof (window as unknown as { __taibled?: unknown }).__taibled !== "undefined",
        undefined,
        { timeout: 30_000 },
    );
}

export const test = base;
export { expect };
