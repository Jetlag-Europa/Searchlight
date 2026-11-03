import type { Page } from "@playwright/test";

import { DOUBLE_TAP_MS } from "../src/lib/doubleTap";
import { API_BASE, expect, test, testLogin } from "./fixtures";
import {
    createSession,
    join,
    openBoard,
    OTHER_USER_ID,
    phone,
    picker,
    showServer,
    type Throwaway,
    useThrowawaySessions,
} from "./sessions";

/**
 * The session picker and the Invite drawer on a phone with a bad connection:
 * a list that fails can be loaded again, the drawer never shows another
 * session's links, and making someone a spectator asks first. Every session
 * here is a throwaway (see sessions.ts).
 */

useThrowawaySessions();
test.use(phone);

async function openInvite(page: Page) {
    await page.getByRole("button", { name: "Menu" }).tap();
    await page.getByRole("button", { name: "Invite", exact: true }).tap();
    return page.getByRole("dialog");
}

async function switchTo(page: Page, session: Throwaway) {
    await page.getByRole("button", { name: "change", exact: true }).tap();
    await showServer(page, session.serverId);
    await picker(page)
        .getByRole("button", { name: new RegExp(`^${session.name}`) })
        .tap();
    await expect(picker(page)).toBeHidden({ timeout: 30_000 });
    await expect(page.getByText(session.name, { exact: true })).toBeVisible();
}

test("the picker offers Try again when its list can't be loaded", async ({
    page,
    request,
}) => {
    const session = await createSession(request, "Listed");
    await testLogin(page);
    await page.route(`${API_BASE}/servers`, (route) => route.abort());
    await page.goto("/map/");
    await expect(picker(page).getByText(/Failed to load servers/)).toBeVisible({
        timeout: 30_000,
    });

    await page.unroute(`${API_BASE}/servers`);
    await picker(page).getByRole("button", { name: "Try again" }).tap();
    await showServer(page, session.serverId);
    await expect(
        picker(page).getByText(session.name, { exact: true }),
    ).toBeVisible();
});

test("the Invite drawer shows only the open session's links", async ({
    page,
    request,
}) => {
    const first = await createSession(request, "First");
    const second = await createSession(request, "Second");
    const link = await request.post(`${API_BASE}/sessions/${first.id}/links`, {
        data: { linkType: "join" },
    });
    expect(link.status()).toBe(201);

    await testLogin(page);
    await openBoard(page, first);
    let drawer = await openInvite(page);
    await expect(drawer.getByRole("button", { name: "Copy" })).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();

    await switchTo(page, second);
    // Its links can't be loaded now.
    await page.route(`${API_BASE}/sessions/${second.id}/links`, (route) =>
        route.abort(),
    );
    drawer = await openInvite(page);
    await expect(drawer.getByText(`Invite to ${second.name}`)).toBeVisible();
    await page.waitForTimeout(500);
    await expect(drawer.getByRole("button", { name: "Copy" })).toHaveCount(0);
    await expect(drawer.getByRole("button", { name: "Revoke" })).toHaveCount(0);
});

test("Make spectator asks first", async ({ page, request, browser }) => {
    const session = await createSession(request, "Team");
    const teammateContext = await browser.newContext();
    try {
        const teammate = await teammateContext.newPage();
        await testLogin(teammate, OTHER_USER_ID);
        await join(request, teammate, session.id);
    } finally {
        await teammateContext.close();
    }
    const role = async () => {
        const res = await request.get(`${API_BASE}/sessions/${session.id}`);
        const { participants } = (await res.json()) as {
            participants: Array<{ userId: string; role: string }>;
        };
        return participants.find((p) => p.userId === OTHER_USER_ID)?.role;
    };

    await testLogin(page);
    await openBoard(page, session);
    const drawer = await openInvite(page);
    await drawer.getByRole("button", { name: "Make spectator" }).tap();
    await expect(drawer.getByText("Edits they haven’t sent yet are lost")).toBeVisible();
    await page.waitForTimeout(1_000);
    expect(await role()).toBe("member");

    // A quick second tap is the same double tap, not a decision.
    await page.waitForTimeout(DOUBLE_TAP_MS);
    await drawer.getByRole("button", { name: "Confirm?" }).tap();
    await expect.poll(role).toBe("viewer");
    await expect(drawer.getByRole("button", { name: "Let them edit" })).toBeVisible();
});
