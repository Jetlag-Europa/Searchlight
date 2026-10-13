import {
    API_BASE,
    expect,
    test,
    testLogin,
    waitForTestHook,
} from "./fixtures";

/**
 * Phase 3 smoke test — proves the e2e plumbing end to end:
 *   1. POST /auth/test-login mints a session (ENABLE_TEST_AUTH path).
 *   2. The cookie authenticates the app (the auth-gated /map page loads).
 *   3. The Map component mounts and installs window.__searchlight
 *      (PUBLIC_ENABLE_TEST_HOOK path), exposing the live nanostore values.
 *
 * Asserting on the actual computed GeoJSON per question is Phase 4.
 */
test.describe("e2e harness smoke", () => {
    test("test-login responds and sets a session cookie", async ({ page }) => {
        const res = await page.request.post(`${API_BASE}/auth/test-login`);
        expect(res.ok()).toBeTruthy();
        const body = await res.json();
        expect(body.user.discordId).toBeTruthy();
    });

    test("logged-in user loads /map and window.__searchlight is installed", async ({
        page,
    }) => {
        await testLogin(page);
        // Trailing slash: the static build canonicalises /map → /map/.
        await page.goto("/map/");

        // Auth-gated page should NOT bounce back to the landing page.
        await expect(page).toHaveURL(/\/map/);

        await waitForTestHook(page);

        // The hook exposes the five stores; questions must be an array.
        const shape = await page.evaluate(() => {
            const t = (window as unknown as { __searchlight: Record<string, unknown> })
                .__searchlight;
            return {
                keys: Object.keys(t).sort(),
                questionsIsArray: Array.isArray(t.questions),
                hiderModeDefined: typeof t.hiderMode !== "undefined",
            };
        });

        expect(shape.keys).toEqual([
            "eliminationGeoJSON",
            "hiderMode",
            "mapGeoJSON",
            "polyGeoJSON",
            "questions",
        ]);
        expect(shape.questionsIsArray).toBe(true);
        expect(shape.hiderModeDefined).toBe(true);
    });
});
