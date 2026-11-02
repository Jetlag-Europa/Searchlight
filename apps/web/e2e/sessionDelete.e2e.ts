import {
    devices,
    type APIRequestContext,
    type Locator,
    type Page,
} from "@playwright/test";

import { DOUBLE_TAP_MS } from "../src/lib/doubleTap";
import {
    API_BASE,
    expect,
    test,
    TEST_SESSION_ID,
    TEST_USER_ID,
    testLogin,
} from "./fixtures";

/**
 * Deleting and leaving sessions in the session picker: Delete asks first,
 * Delete and Leave can be seen and tapped on a phone, and a teammate who has
 * the session open is told it was deleted.
 *
 * Every session here is a throwaway created through the API by the test
 * user (so it needs to be allowed to start the seeded session's game, e.g. as
 * an admin). The seeded e2e-session is only read, for its game.
 */

const OTHER_USER_ID = "e2e-other";

// defaultBrowserType can't be set in a describe group (it forces a new
// worker), and the project picks the browser anyway.
const { defaultBrowserType: _phoneBrowser, ...phone } = devices["Pixel 7"];
const { defaultBrowserType: _desktopBrowser, ...desktop } =
    devices["Desktop Chrome"];

interface Throwaway {
    id: string;
    name: string;
    serverId: string;
}

// Sessions to delete after each test, whatever happened to them.
let created: string[] = [];

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

async function createSession(
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
async function join(
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

async function sessionStatus(
    request: APIRequestContext,
    sessionId: string,
): Promise<number> {
    return (await request.get(`${API_BASE}/sessions/${sessionId}`)).status();
}

/** Loads the board with `sessionId` open, as /join leaves it. */
async function openBoard(page: Page, session: Throwaway): Promise<void> {
    await page.addInitScript((id) => {
        localStorage.setItem("taibled-pending-link-session", id);
    }, session.id);
    // Trailing slash: the static build canonicalises /map → /map/.
    await page.goto("/map/");
    await expect(page.getByText(session.name, { exact: true })).toBeVisible({
        timeout: 30_000,
    });
}

function picker(page: Page) {
    return page.getByRole("dialog", { name: "Select a Session" });
}

/** Waits for the picker's servers, and shows the session's one. */
async function showServer(page: Page, serverId: string): Promise<void> {
    await expect(picker(page)).toBeVisible({ timeout: 30_000 });
    await expect(picker(page).getByText("Loading servers…")).toBeHidden();
    const select = picker(page).locator("select");
    if ((await select.count()) > 0) await select.first().selectOption(serverId);
}

function deleteButton(page: Page, session: Throwaway) {
    return picker(page).getByRole("button", {
        name: `Delete session “${session.name}”`,
    });
}

function deleteDialog(page: Page, session: Throwaway) {
    return page.getByRole("alertdialog", { name: `Delete “${session.name}”?` });
}

/**
 * Presses the confirm's Delete as someone who read it first: a quicker press
 * counts as the second half of a double tap on the row's Delete.
 */
async function confirmDelete(
    page: Page,
    dialog: Locator,
    press: "tap" | "click",
): Promise<void> {
    await page.waitForTimeout(DOUBLE_TAP_MS);
    await dialog.getByRole("button", { name: "Delete session" })[press]();
}

async function expectBodyTappable(page: Page): Promise<void> {
    await expect
        .poll(() => page.evaluate(() => document.body.style.pointerEvents))
        .not.toBe("none");
}

test.describe("deleting a session on a phone", () => {
    test.use(phone);

    test.beforeEach(async ({ page }) => {
        expect(
            await page.evaluate(
                () => matchMedia("(any-pointer: coarse)").matches,
            ),
            "the phone profile should report a coarse pointer",
        ).toBe(true);
    });

    test("Delete is shown, asks first and only deletes on confirm", async ({
        page,
        request,
    }) => {
        // Two board loads.
        test.slow();
        const doomed = await createSession(request, "Doomed");
        const board = await createSession(request, "Board");
        await testLogin(page);
        await openBoard(page, board);

        await page.getByRole("button", { name: "change", exact: true }).tap();
        await showServer(page, doomed.serverId);
        const del = deleteButton(page, doomed);
        await expect(del).toHaveCSS("opacity", "1");
        const box = await del.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

        // Tapping Delete asks; it doesn't open the session.
        await del.tap();
        const dialog = deleteDialog(page, doomed);
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText("for everyone in it");
        expect(
            await page.evaluate(() =>
                sessionStorage.getItem("taibled-active-session"),
            ),
        ).toBe(board.id);

        // Cancel keeps it, and goes back to its Delete button.
        await dialog.getByRole("button", { name: "Cancel" }).tap();
        await expect(dialog).toBeHidden();
        await expect(del).toBeFocused();
        expect(await sessionStatus(request, doomed.id)).toBe(200);

        // Escape keeps it, and closes only the confirm, not the picker.
        await del.tap();
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(picker(page)).toBeVisible();
        await expect(
            picker(page).getByRole("button", { name: "Back to board" }),
        ).toBeVisible();
        expect(await sessionStatus(request, doomed.id)).toBe(200);

        // A quick double tap on Delete doesn't confirm, even when its second
        // tap lands on the confirm's Delete. A frozen clock makes it quick.
        const deletes: string[] = [];
        page.on("request", (req) => {
            if (req.method() === "DELETE") deletes.push(req.url());
        });
        const firstTap = Date.now();
        await page.clock.setFixedTime(firstTap);
        await del.tap();
        await dialog.getByRole("button", { name: "Delete session" }).tap();
        // A confirm that closed would still show while it animates out.
        await page.waitForTimeout(500);
        await expect(dialog).toHaveAttribute("data-state", "open");
        expect(deletes).toEqual([]);
        expect(await sessionStatus(request, doomed.id)).toBe(200);

        await page.clock.setFixedTime(firstTap + DOUBLE_TAP_MS);
        await dialog.getByRole("button", { name: "Delete session" }).tap();
        await expect(dialog).toBeHidden();
        await expect(del).toHaveCount(0);
        await expect(picker(page)).toBeFocused();
        await expect.poll(() => sessionStatus(request, doomed.id)).toBe(404);

        // The board is still the one that was open, and takes taps.
        await expectBodyTappable(page);
        await picker(page).getByRole("button", { name: "Back to board" }).tap();
        await expect(picker(page)).toBeHidden();
        await page.getByRole("button", { name: "change", exact: true }).tap();
        await expect(picker(page)).toBeVisible();
    });

    test("a teammate with the session open is told it was deleted", async ({
        page,
        request,
        browser,
    }) => {
        // Two board loads, then the streams' retry delays.
        test.slow();
        const shared = await createSession(request, "Team");
        const teammateContext = await browser.newContext();
        try {
            const teammate = await teammateContext.newPage();
            await testLogin(teammate, OTHER_USER_ID);
            await join(request, teammate, shared.id);
            await openBoard(teammate, shared);

            // The creator deletes it from the board it is open on.
            await testLogin(page);
            await openBoard(page, shared);
            await page
                .getByRole("button", { name: "change", exact: true })
                .tap();
            await showServer(page, shared.serverId);
            await deleteButton(page, shared).tap();
            // The creator's own stream finds out too, and must stay quiet.
            const creatorFoundOut = page.waitForResponse(
                (res) =>
                    res
                        .url()
                        .includes(`/sessions/${shared.id}/events/cursor`) &&
                    res.status() === 404,
                { timeout: 60_000 },
            );
            await confirmDelete(page, deleteDialog(page, shared), "tap");
            await expect
                .poll(() => sessionStatus(request, shared.id))
                .toBe(404);
            // Deleting the open session doesn't close the picker.
            await expect(picker(page)).toBeVisible();

            await expect(
                teammate.getByText(
                    `The session “${shared.name}” was deleted by its creator.`,
                ),
            ).toBeVisible({ timeout: 60_000 });
            await expect(picker(teammate)).toBeVisible();
            await expectBodyTappable(teammate);

            await creatorFoundOut;
            // Nothing else happens there to wait for: give a toast a moment.
            await page.waitForTimeout(1_000);
            await expect(page.getByText("was deleted")).toHaveCount(0);
            await expectBodyTappable(page);
        } finally {
            await teammateContext.close();
        }
    });

    test("Leave is shown and still asks twice", async ({ page, request }) => {
        const session = await createSession(request, "Leave");
        await testLogin(page, OTHER_USER_ID);
        await join(request, page, session.id);
        await page.goto("/map/");
        await showServer(page, session.serverId);

        const leave = picker(page).getByRole("button", {
            name: `Leave session “${session.name}”`,
        });
        await expect(leave).toHaveCSS("opacity", "1");
        const box = await leave.boundingBox();
        expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

        await leave.tap();
        const confirm = picker(page).getByRole("button", {
            name: `Confirm leaving session “${session.name}”`,
        });
        await expect(confirm).toHaveText("Confirm?");
        // A quicker second tap is taken as a double tap.
        await page.waitForTimeout(DOUBLE_TAP_MS);
        await confirm.tap();
        await expect(
            picker(page).getByText(session.name, { exact: true }),
        ).toHaveCount(0);
        expect(await sessionStatus(page.request, session.id)).toBe(403);
        expect(await sessionStatus(request, session.id)).toBe(200);
        await expectBodyTappable(page);
    });
});

test.describe("deleting a session with a mouse", () => {
    test.use(desktop);

    test("Delete shows on hover and focus, and asks first", async ({
        page,
        request,
    }) => {
        const doomed = await createSession(request, "Desk");
        await testLogin(page);
        await page.goto("/map/");
        expect(
            await page.evaluate(
                () => matchMedia("(any-pointer: coarse)").matches,
            ),
            "the desktop profile should not report a coarse pointer",
        ).toBe(false);
        await showServer(page, doomed.serverId);

        const del = deleteButton(page, doomed);
        await page.mouse.move(0, 0);
        await expect(del).toHaveCSS("opacity", "0");
        await picker(page).getByText(doomed.name, { exact: true }).hover();
        await expect(del).toHaveCSS("opacity", "1");
        await page.mouse.move(0, 0);
        await expect(del).toHaveCSS("opacity", "0");
        await del.focus();
        await expect(del).toHaveCSS("opacity", "1");

        await page.keyboard.press("Enter");
        const dialog = deleteDialog(page, doomed);
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(del).toBeFocused();
        expect(await sessionStatus(request, doomed.id)).toBe(200);

        await del.click();
        await confirmDelete(page, dialog, "click");
        await expect(del).toHaveCount(0);
        await expect.poll(() => sessionStatus(request, doomed.id)).toBe(404);
        await expectBodyTappable(page);
    });
});
