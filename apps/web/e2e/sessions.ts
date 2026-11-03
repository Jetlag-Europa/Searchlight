import {
    type APIRequestContext,
    devices,
    type Page,
} from "@playwright/test";

import {
    API_BASE,
    expect,
    test,
    TEST_SESSION_ID,
    TEST_USER_ID,
} from "./fixtures";

/**
 * Throwaway sessions for e2e tests, and the session picker. Each is created
 * through the API by the test user (so it needs to be allowed to start the
 * seeded session's game, e.g. as an admin). The seeded e2e-session is only
 * read, for its game.
 */

export const OTHER_USER_ID = "e2e-other";

// defaultBrowserType can't be set in a describe group (it forces a new
// worker), and the project picks the browser anyway.
const { defaultBrowserType: _phoneBrowser, ...pixel } = devices["Pixel 7"];
const { defaultBrowserType: _desktopBrowser, ...chrome } =
    devices["Desktop Chrome"];
export const phone = pixel;
export const desktop = chrome;

export interface Throwaway {
    id: string;
    name: string;
    serverId: string;
}

// Sessions to delete after each test, whatever happened to them.
let created: string[] = [];

/** Logs `request` in as the test user, and deletes what each test made. */
export function useThrowawaySessions(): void {
    test.beforeEach(async ({ request }) => {
        created = [];
        // `request` is the creator's API client, with its own cookie jar.
        const res = await request.post(`${API_BASE}/auth/test-login`, {
            data: { discordId: TEST_USER_ID },
        });
        expect(res.ok(), `test-login failed: ${res.status()}`).toBeTruthy();
    });

    test.afterEach(async ({ request }) => {
        for (const id of created) {
            await request.delete(`${API_BASE}/sessions/${id}`);
        }
    });
}

export async function createSession(
    request: APIRequestContext,
    label: string,
): Promise<Throwaway> {
    const seeded = await request.get(`${API_BASE}/sessions/${TEST_SESSION_ID}`);
    expect(seeded.ok(), `seeded session: ${seeded.status()}`).toBeTruthy();
    const { gameId } = (await seeded.json()) as { gameId: string };
    const name = `${label} ${Date.now().toString(36)}${Math.random()
        .toString(36)
        .slice(2, 6)}`;
    const res = await request.post(`${API_BASE}/sessions`, {
        data: { gameId, name },
    });
    expect(
        res.status(),
        `creating a session failed (${res.status()}); the test user must be able to start the seeded game`,
    ).toBe(201);
    const session = (await res.json()) as Throwaway;
    created.push(session.id);
    return session;
}

/** Makes `page`'s user a member of the session, through a join link. */
export async function join(
    request: APIRequestContext,
    page: Page,
    sessionId: string,
): Promise<void> {
    const link = await request.post(`${API_BASE}/sessions/${sessionId}/links`, {
        data: { linkType: "join" },
    });
    expect(link.status(), "join link").toBe(201);
    const { token } = (await link.json()) as { token: string };
    const redeem = await page.request.post(`${API_BASE}/links/${token}/redeem`);
    expect(redeem.ok(), `redeem: ${redeem.status()}`).toBeTruthy();
}

export async function sessionStatus(
    request: APIRequestContext,
    sessionId: string,
): Promise<number> {
    return (await request.get(`${API_BASE}/sessions/${sessionId}`)).status();
}

/** Loads the board with `sessionId` open, as /join leaves it. */
export async function openBoard(page: Page, session: Throwaway): Promise<void> {
    await page.addInitScript((id) => {
        localStorage.setItem("taibled-pending-link-session", id);
    }, session.id);
    // Trailing slash: the static build canonicalises /map → /map/.
    await page.goto("/map/");
    await expect(page.getByText(session.name, { exact: true })).toBeVisible({
        timeout: 30_000,
    });
}

export function picker(page: Page) {
    return page.getByRole("dialog", { name: "Select a Session" });
}

/** Waits for the picker's servers, and shows the session's one. */
export async function showServer(page: Page, serverId: string): Promise<void> {
    await expect(picker(page)).toBeVisible({ timeout: 30_000 });
    await expect(picker(page).getByText("Loading servers…")).toBeHidden();
    const select = picker(page).locator("select");
    if ((await select.count()) > 0) await select.first().selectOption(serverId);
}
