import { expect, test, testLogin } from "./fixtures";
import { createSession, openBoard, useThrowawaySessions } from "./sessions";

/**
 * The zone list keeps its place when a zone is struck out while another is
 * viewed. It used to zoom back to the viewed zone, scroll its row into view
 * and highlight it after every tap.
 */

useThrowawaySessions();
test.skip(({ isMobile }) => isMobile, "the zone sidebar is a sheet on phones");

test("striking out a zone while viewing another keeps the list where it is", async ({
    page,
    request,
}) => {
    await testLogin(page);
    const session = await createSession(request, "Zones");
    await openBoard(page, session);
    await expect(page.getByText(/of \d+ hiding zones left/)).toBeVisible({
        timeout: 60_000,
    });
    // The zone sidebar, on the right.
    await page.locator('[data-sidebar="trigger"]').nth(1).click();
    const rows = page.locator("[data-station-id]");
    await rows.first().getByRole("button", { name: "View" }).click();
    // The viewed zone's row is highlighted for 5 s.
    const highlighted = page.locator(".selected-card-background-temporary");
    await expect(highlighted).toHaveCount(1);
    await expect(highlighted).toHaveCount(0, { timeout: 10_000 });

    const list = page
        .locator('[data-sidebar="content"]')
        .filter({ has: rows.first() });
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    const scrolled = await list.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
    // On its name: the row's View button would view it instead.
    const last = rows.last();
    await last.click({ position: { x: 12, y: 10 } });
    await expect(last).toHaveClass(/line-through/);
    await page.waitForTimeout(1_000);
    expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThanOrEqual(
        scrolled,
    );
    await expect(highlighted).toHaveCount(0);
    await expect(page.getByText(/^Current:/)).toBeVisible();
});
