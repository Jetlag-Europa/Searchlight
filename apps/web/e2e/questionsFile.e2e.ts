import { readFile } from "node:fs/promises";

import type { Page } from "@playwright/test";

import { API_BASE, expect, test, testLogin, waitForTestHook } from "./fixtures";
import { createSession, desktop, openBoard, phone, useThrowawaySessions } from "./sessions";

/**
 * Options → Export Questions downloads the session's questions as a file, and
 * Import Questions replaces the board's with such a file's, under new keys,
 * after a confirm that opens over the Options drawer and leaves the map usable.
 */

useThrowawaySessions();

const boardKeys = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __searchlight: { questions: { key: number }[] } }
    ).__searchlight.questions.map((q) => q.key),
  );

// By CSS, not by role: beside a phone's open sheet, dialogs are aria-hidden.
const sidebarButton = (page: Page, name: string) =>
  page.locator('[data-sidebar="sidebar"] button', { hasText: name });

async function openSidebar(page: Page) {
  if (!(await sidebarButton(page, "History").first().isVisible()))
    await page.locator('[data-sidebar="trigger"]').first().click();
}

async function openOptions(page: Page) {
  await page.keyboard.press("Escape"); // a phone's sheet covers the Menu
  await page.getByRole("button", { name: "Menu" }).click();
  await page.getByRole("button", { name: "Options", exact: true }).click();
}

/** Picks `file` for Import Questions, and returns the confirm. */
async function pickFile(page: Page, file: string) {
  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import Questions" }).click();
  await (await chooser).setFiles(file);
  return page.locator('[role="alertdialog"]', { hasText: "Import questions?" });
}

for (const [label, device] of [
  ["desktop", desktop],
  ["phone", phone],
] as const) {
  test.describe(label, () => {
    test.use(device);

    test("exported questions can be imported again", async ({ page, request }, testInfo) => {
      const session = await createSession(request, "Questions File");
      const saved = async () => {
        const res = await request.get(`${API_BASE}/sessions/${session.id}/questions`);
        return ((await res.json()) as { questions: unknown[] }).questions.length;
      };
      await testLogin(page);
      await openBoard(page, session);
      await waitForTestHook(page);
      await openSidebar(page);
      for (const kind of ["Radius", "Thermometer"]) {
        await sidebarButton(page, "Add Question").click();
        await page.locator('[role="dialog"] button', { hasText: `Add ${kind}` }).click();
      }
      await expect.poll(saved).toBe(2);
      const exportedKeys = await boardKeys(page);

      await openOptions(page);
      const options = page.getByRole("heading", { name: "Options" });
      const downloading = page.waitForEvent("download");
      await page.getByRole("button", { name: "Export Questions" }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toMatch(/^questions-file-[a-z0-9]+\.questions\.json$/);
      const file = testInfo.outputPath(download.suggestedFilename());
      await download.saveAs(file);
      const exported = JSON.parse(await readFile(file, "utf8"));
      const { gameId, gameRevisionId } = await (
        await request.get(`${API_BASE}/sessions/${session.id}`)
      ).json();
      expect(exported).toMatchObject({
        searchlightQuestions: 1,
        sessionName: session.name,
        gameId,
        gameRevisionId,
      });
      expect(exported.questions.map((q: { id: string }) => q.id)).toEqual([
        "radius",
        "thermometer",
      ]);

      // Onto an empty board. The confirm takes the focus, and Cancel.
      await page.keyboard.press("Escape");
      await expect(options).toBeHidden();
      await openSidebar(page);
      await sidebarButton(page, "Delete All Questions").click();
      await page.locator('[role="alertdialog"] button', { hasText: "Delete All" }).click();
      await expect.poll(saved).toBe(0);
      await openOptions(page);
      let confirm = await pickFile(page, file);
      await expect(confirm).toContainText(`Add 2 questions from “${session.name}”?`);
      await expect(confirm.locator(":focus")).toHaveText("Cancel");
      await confirm.locator("button", { hasText: "Cancel" }).click();
      await expect(confirm).toBeHidden();
      expect(await boardKeys(page)).toEqual([]);

      confirm = await pickFile(page, file);
      await confirm.locator("button", { hasText: "Import" }).click();
      await expect(confirm).toBeHidden();
      await expect.poll(saved).toBe(2);
      const importedKeys = await boardKeys(page);
      expect(importedKeys).toHaveLength(2);
      expect(importedKeys.filter((k) => exportedKeys.includes(k))).toEqual([]);

      // Onto a board with questions: it says how many it replaces.
      confirm = await pickFile(page, file);
      await expect(confirm).toContainText(
        "Replace the 2 questions in this session with 2 questions from",
      );
      await confirm.locator("button", { hasText: "Import" }).click();
      await expect(confirm).toBeHidden();
      const kept = async () => (await boardKeys(page)).filter((k) => importedKeys.includes(k));
      await expect.poll(kept).toEqual([]);

      // With the drawer closed, the map takes a drag again.
      await page.keyboard.press("Escape");
      await expect(options).toBeHidden();
      expect(await page.evaluate(() => document.body.style.pointerEvents)).not.toBe("none");
      const pane = page.locator(".leaflet-map-pane");
      const panned = () => pane.evaluate((el) => el.style.transform);
      const before = await panned();
      const map = (await page.locator(".leaflet-container").boundingBox())!;
      const [x, y] = [map.x + map.width * 0.3, map.y + map.height * 0.6];
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 100, y - 60, { steps: 10 });
      await page.mouse.up();
      expect(await panned()).not.toBe(before);

      // The import was saved, and both replaced lists can be restored.
      await page.reload();
      await waitForTestHook(page);
      await expect.poll(async () => (await boardKeys(page)).length).toBe(2);
      expect(await saved()).toBe(2);
      await openSidebar(page);
      await sidebarButton(page, "History").click();
      await expect(page.getByRole("button", { name: "Restore", exact: true })).toHaveCount(4);
    });
  });
}
