import { type Locator, type Page } from "@playwright/test";

import { DOUBLE_TAP_MS } from "../src/lib/doubleTap";
import { API_BASE, expect, test, testLogin } from "./fixtures";
import {
    createSession,
    desktop,
    join,
    openBoard,
    OTHER_USER_ID,
    phone,
    picker,
    sessionStatus,
    showServer,
    type Throwaway,
    useThrowawaySessions,
} from "./sessions";

/**
 * Deleting and leaving sessions in the session picker: Delete asks first,
 * Delete and Leave can be seen and tapped on a phone, and a teammate who has
 * the session open, or opens it from a list made before, is told it was
 * deleted. Every session here is a throwaway (see sessions.ts).
 */

useThrowawaySessions();

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

    test("a teammate with the question sheet open can pick another session", async ({
        request,
        browser,
    }) => {
        test.slow();
        const shared = await createSession(request, "Sheet");
        const other = await createSession(request, "Other");
        const teammateContext = await browser.newContext(phone);
        // The Delete All confirm sounds the alarm with this on.
        await teammateContext.addInitScript(() =>
            localStorage.setItem("warningAlarm2", "true"),
        );
        try {
            const teammate = await teammateContext.newPage();
            await testLogin(teammate, OTHER_USER_ID);
            await join(request, teammate, shared.id);
            await join(request, teammate, other.id);
            await openBoard(teammate, shared);
            // The question sidebar: a modal sheet over the whole screen, here
            // with a confirm open in it.
            await teammate.locator('[data-sidebar="trigger"]').first().tap();
            const sheet = '[data-mobile="true"][data-sidebar="sidebar"]';
            await expect(teammate.locator(sheet)).toBeVisible();
            await teammate
                .getByRole("button", { name: "Delete All Questions" })
                .tap();
            const confirm = teammate.locator('[role="alertdialog"]');
            const alarm = teammate.locator(".warning-flash");
            await expect(confirm).toBeVisible();
            await expect(alarm).toHaveCount(1);

            const deleted = await request.delete(
                `${API_BASE}/sessions/${shared.id}`,
            );
            expect(deleted.ok()).toBe(true);
            // The sheet closes: open, it would hide the picker from screen
            // readers, keep focus and scrolling, and take the taps. Its
            // confirm goes with it, and the alarm stops.
            await expect(picker(teammate)).toBeVisible({ timeout: 60_000 });
            await expect(teammate.locator(sheet)).toBeHidden();
            await expect(confirm).toBeHidden();
            await expect(alarm).toHaveCount(0);
            await expectBodyTappable(teammate);
            await picker(teammate)
                .getByRole("button", { name: new RegExp(`^${other.name}`) })
                .tap();
            await expect(picker(teammate)).toBeHidden();
            await expect(
                teammate.getByText(other.name, { exact: true }),
            ).toBeVisible({ timeout: 30_000 });
            // The confirm doesn't come back with the sheet.
            await teammate.locator('[data-sidebar="trigger"]').first().tap();
            await expect(teammate.locator(sheet)).toBeVisible();
            await expect(confirm).toBeHidden();
            await expect(alarm).toHaveCount(0);
        } finally {
            await teammateContext.close();
        }
    });

    test("a session deleted after the list was shown says so when opened", async ({
        page,
        request,
    }) => {
        const doomed = await createSession(request, "Listed");
        await testLogin(page);
        await page.goto("/map/");
        await showServer(page, doomed.serverId);
        const row = picker(page).getByRole("button", {
            name: new RegExp(`^${doomed.name}`),
        });
        await expect(row).toBeVisible();

        // Deleted from another device while this list is up.
        expect((await request.delete(`${API_BASE}/sessions/${doomed.id}`)).ok()).toBe(true);
        await row.tap();
        await expect(
            page.getByText(
                `The session “${doomed.name}” was deleted from another tab or device.`,
            ),
        ).toBeVisible({ timeout: 30_000 });
        await expect(picker(page)).toBeVisible();
        await expect(
            picker(page).getByText(doomed.name, { exact: true }),
        ).toHaveCount(0);
        await expect(page.getByText(/copy saved on this device|Try again in a moment/)).toHaveCount(0);
        await expectBodyTappable(page);
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

        // An armed Leave gives up after a few seconds.
        await leave.tap();
        await expect(leave).toHaveCount(0);
        await expect(leave).toHaveText("Leave", { timeout: 10_000 });

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

        // A key press can't be half of a double tap: no wait needed.
        await del.focus();
        await page.keyboard.press("Enter");
        await expect(dialog).toBeVisible();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await expect(del).toHaveCount(0);
        await expect.poll(() => sessionStatus(request, doomed.id)).toBe(404);
        await expectBodyTappable(page);
    });

    // Only the API's own 404 for the session means it's gone: not a proxy's
    // plain-text one, nor one for a route the running API doesn't have.
    for (const [kind, answer] of [
        [
            "a proxy's",
            { contentType: "text/plain", body: "404 page not found" },
        ],
        [
            "a missing route's",
            {
                contentType: "application/json",
                body: JSON.stringify({
                    message: "Route DELETE:/sessions/x not found",
                    error: "Not Found",
                    statusCode: 404,
                }),
            },
        ],
    ] as const) {
        test(`${kind} 404 doesn't count as deleted`, async ({
            page,
            request,
        }) => {
            const kept = await createSession(request, "Kept");
            await testLogin(page);
            await page.goto("/map/");
            await showServer(page, kept.serverId);
            await page.route(`${API_BASE}/sessions/${kept.id}`, (route) =>
                route.request().method() === "DELETE"
                    ? route.fulfill({ status: 404, ...answer })
                    : route.fallback(),
            );

            const del = deleteButton(page, kept);
            await del.click();
            await confirmDelete(page, deleteDialog(page, kept), "click");
            await expect(
                picker(page).getByText("Failed to delete session: 404"),
            ).toBeVisible();
            await expect(del).toBeVisible();
            expect(await sessionStatus(request, kept.id)).toBe(200);
        });
    }

    // Its first try's reply was lost, or another tab got there first.
    test("Delete of a session already gone takes it off the list", async ({
        page,
        request,
    }) => {
        const gone = await createSession(request, "Gone");
        await testLogin(page);
        await page.goto("/map/");
        await showServer(page, gone.serverId);
        const del = deleteButton(page, gone);
        await expect(del).toBeAttached();
        expect(
            (await request.delete(`${API_BASE}/sessions/${gone.id}`)).ok(),
        ).toBe(true);

        await del.focus();
        await page.keyboard.press("Enter");
        await confirmDelete(page, deleteDialog(page, gone), "click");
        await expect(del).toHaveCount(0);
        await expect(picker(page).getByText(/Failed to delete/)).toHaveCount(0);
    });

    test("a teammate with the Delete All confirm open can pick another session", async ({
        request,
        browser,
    }) => {
        test.slow();
        const shared = await createSession(request, "Desk");
        const other = await createSession(request, "Next");
        const teammateContext = await browser.newContext(desktop);
        // The Delete All confirm sounds the alarm with this on.
        await teammateContext.addInitScript(() =>
            localStorage.setItem("warningAlarm2", "true"),
        );
        try {
            const teammate = await teammateContext.newPage();
            await testLogin(teammate, OTHER_USER_ID);
            await join(request, teammate, shared.id);
            await join(request, teammate, other.id);
            await openBoard(teammate, shared);
            await teammate
                .getByRole("button", { name: "Delete All Questions" })
                .click();
            const confirm = teammate.getByRole("alertdialog");
            const alarm = teammate.locator(".warning-flash");
            await expect(confirm).toBeVisible();
            await expect(alarm).toHaveCount(1);

            const deleted = await request.delete(
                `${API_BASE}/sessions/${shared.id}`,
            );
            expect(deleted.ok()).toBe(true);
            // The picker opening closes the confirm, and the alarm stops: left
            // open, it would stay over the next session's board and delete
            // that session's questions.
            await expect(picker(teammate)).toBeVisible({ timeout: 60_000 });
            await expect(confirm).toBeHidden();
            await expect(alarm).toHaveCount(0);
            await expectBodyTappable(teammate);
            await picker(teammate)
                .getByRole("button", { name: new RegExp(`^${other.name}`) })
                .click();
            await expect(picker(teammate)).toBeHidden();
            await expect(
                teammate.getByText(other.name, { exact: true }),
            ).toBeVisible({ timeout: 30_000 });
            await expect(confirm).toBeHidden();
            await expect(alarm).toHaveCount(0);
        } finally {
            await teammateContext.close();
        }
    });

    test("the Delete All confirm closes when the window turns phone-sized", async ({
        page,
        request,
    }) => {
        const session = await createSession(request, "Turn");
        // The Delete All confirm sounds the alarm with this on.
        await page.addInitScript(() =>
            localStorage.setItem("warningAlarm2", "true"),
        );
        await testLogin(page, OTHER_USER_ID);
        await join(request, page, session.id);
        await openBoard(page, session);
        await page.getByRole("button", { name: "Delete All Questions" }).click();
        const confirm = page.locator('[role="alertdialog"]');
        const alarm = page.locator(".warning-flash");
        await expect(confirm).toBeVisible();
        await expect(alarm).toHaveCount(1);

        // A tablet or phone turned upright: the sidebar becomes a sheet, and
        // takes the confirm away. The alarm stops, and the confirm doesn't
        // come back when the sheet is opened.
        await page.setViewportSize({ width: 400, height: 800 });
        await expect(confirm).toBeHidden();
        await expect(alarm).toHaveCount(0);
        await page.locator('[data-sidebar="trigger"]').first().click();
        await expect(
            page.locator('[data-mobile="true"][data-sidebar="sidebar"]'),
        ).toBeVisible();
        await expect(confirm).toBeHidden();
        await expect(alarm).toHaveCount(0);
    });
});
