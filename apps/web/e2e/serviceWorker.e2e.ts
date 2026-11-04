import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, resolve } from "node:path";

import type { BrowserContext, Page } from "@playwright/test";

import { expect, test } from "./fixtures";

/**
 * Service worker updates (src/lib/serviceWorker.tsx) with a real build: a
 * page reloads once when a new worker takes over from the one it loaded with,
 * whichever tab accepted the update, and the first install doesn't reload it.
 *
 * Serves a local build (`pnpm --filter @searchlight/web build`, or WEB_DIST)
 * itself, the way nginx does, and changes it as a deploy would: no stack is
 * needed and no request is intercepted (Playwright's routing changes how
 * service workers behave). The pages are `/` and `/join/`, which stay where
 * they are whether the API answers or not.
 */

const DIST = resolve(
    process.env.WEB_DIST ?? join(import.meta.dirname, "../dist"),
);

// What the server is serving: the build as it is, the same build changed
// (its pages, and so its service worker), or a worker that takes over at
// once without waiting for a Reload. (The self-destroying worker of a
// rollback build, DEPLOY.md, also navigates the pages itself, so a tab may
// reload twice then; the page's own part is what this checks.)
type Deployed = "build" | "update" | "takeover";
let deployed: Deployed = "build";

const NEXT_BUILD = '<meta name="x-build" content="next">';
const TAKEOVER_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));`;

const TYPES: Record<string, string> = {
    ".css": "text/css",
    ".html": "text/html",
    ".js": "text/javascript",
    ".mp3": "audio/mpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
};

async function respond(
    path: string,
): Promise<[number, string, Buffer | string]> {
    if (path === "/sw.js" && deployed === "takeover") {
        return [200, TYPES[".js"], TAKEOVER_WORKER];
    }
    const file = join(DIST, path.endsWith("/") ? `${path}index.html` : path);
    if (!file.startsWith(DIST) || !existsSync(file))
        return [404, "text/plain", ""];
    const type = TYPES[extname(file)] ?? "application/octet-stream";
    if (deployed === "build") return [200, type, await readFile(file)];
    if (file.endsWith(".html")) {
        const html = await readFile(file, "utf8");
        return [200, type, html.replace("</head>", `${NEXT_BUILD}</head>`)];
    }
    if (path === "/sw.js") {
        // The changed pages get new precache revisions.
        const worker = await readFile(file, "utf8");
        return [
            200,
            type,
            worker.replace(
                /("revision":")([^"]+)(","url":"\/)/g,
                "$1$2-next$3",
            ),
        ];
    }
    return [200, type, await readFile(file)];
}

let server: Server;
let origin: string;

test.skip(
    !existsSync(join(DIST, "sw.js")),
    `needs a production build in ${DIST}: pnpm --filter @searchlight/web build`,
);
test.use({ serviceWorkers: "allow" });
test.setTimeout(90_000);

test.beforeAll(async () => {
    server = createServer((req, res) => {
        const path = decodeURIComponent(
            new URL(req.url ?? "/", "http://x").pathname,
        );
        respond(path).then(
            ([status, type, body]) => {
                res.writeHead(status, {
                    "Content-Type": type,
                    "Cache-Control": path.startsWith("/_astro/")
                        ? "public, max-age=31536000, immutable"
                        : "no-cache",
                });
                res.end(body);
            },
            (err: unknown) => {
                res.writeHead(500);
                res.end(String(err));
            },
        );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

test.afterAll(() => new Promise<void>((r) => server.close(() => r())));

test.beforeEach(async ({ context }) => {
    deployed = "build";
    // Counts, per tab, the documents loaded and the reloads (or other
    // navigations) started: a second reload started straight after the first
    // only shows in the latter.
    await context.addInitScript(() => {
        if (window !== window.top) return;
        const count = (key: string) =>
            sessionStorage.setItem(
                key,
                String(Number(sessionStorage.getItem(key)) + 1),
            );
        count("e2e-loads");
        addEventListener("beforeunload", () => count("e2e-leaves"));
    });
});

// Mid-reload a page can't be asked anything: ask again.
const history = (page: Page) =>
    page
        .evaluate(() => ({
            loads: Number(sessionStorage.getItem("e2e-loads")),
            reloads: Number(sessionStorage.getItem("e2e-leaves")),
        }))
        .catch(() => null);
const onNextBuild = (page: Page) =>
    page
        .evaluate(() => document.querySelector('meta[name="x-build"]') !== null)
        .catch(() => false);

async function openControlled(
    context: BrowserContext,
    path: string,
): Promise<Page> {
    const page = await context.newPage();
    await page.goto(`${origin}${path}`);
    await page.waitForFunction(
        () => navigator.serviceWorker.controller !== null,
        undefined,
        {
            timeout: 60_000,
        },
    );
    return page;
}

// The browser looks for a new worker on navigations and when the app checks;
// this is the app's check, done now. A worker that takes over at once can
// reload the page before the check returns.
const checkForUpdate = (page: Page) =>
    page
        .evaluate(async () => {
            await (await navigator.serviceWorker.getRegistration())?.update();
        })
        .catch(() => {});

/** Both tabs are on the next build, after exactly one reload each. */
async function expectReloadedOnceIntoNextBuild(pages: Page[]) {
    for (const page of pages) {
        await expect
            .poll(() => onNextBuild(page), { timeout: 30_000 })
            .toBe(true);
    }
    // Time for a second reload to happen, if one were coming.
    await pages[0].waitForTimeout(3_000);
    expect(await Promise.all(pages.map(history))).toEqual(
        pages.map(() => ({ loads: 2, reloads: 1 })),
    );
    expect(await Promise.all(pages.map(onNextBuild))).toEqual(
        pages.map(() => true),
    );
}

test("the first install takes over an open page without reloading it", async ({
    context,
}) => {
    const page = await openControlled(context, "/");
    await page.waitForTimeout(3_000);
    expect(await history(page)).toEqual({ loads: 1, reloads: 0 });
});

test("accepting an update in one tab reloads each open tab once, into it", async ({
    context,
}) => {
    const pages = [
        await openControlled(context, "/"),
        await openControlled(context, "/join/"),
    ];
    deployed = "update";
    await checkForUpdate(pages[0]);
    for (const page of pages) {
        await expect(
            page.getByText("A new version of Searchlight is available"),
        ).toBeVisible({
            timeout: 30_000,
        });
    }
    // Nothing reloads until the player chooses to.
    expect(await Promise.all(pages.map(history))).toEqual([
        { loads: 1, reloads: 0 },
        { loads: 1, reloads: 0 },
    ]);

    await pages[0].getByRole("button", { name: "Reload" }).click();
    await expectReloadedOnceIntoNextBuild(pages);
});

test("a worker that takes over without waiting reloads each open tab once", async ({
    context,
}) => {
    const pages = [
        await openControlled(context, "/"),
        await openControlled(context, "/join/"),
    ];
    deployed = "takeover";
    await checkForUpdate(pages[0]);
    await expectReloadedOnceIntoNextBuild(pages);
});

test.describe("one session open in two tabs", () => {
    // The map signed in from what this browser kept (no API runs here): it
    // edits the session it last showed, in one tab at a time.
    test.beforeEach(async ({ context }) => {
        await context.addInitScript(() => {
            if (localStorage.getItem("taibled-authed-user")) return;
            localStorage.setItem("taibled-authed-user", "user-1");
            localStorage.setItem(
                "taibled-authed-user-verified",
                String(Date.now()),
            );
            localStorage.setItem("taibled-last-session", "session-1");
        });
    });
    const notice = (page: Page) =>
        page.getByText("This session is open in another tab");
    // B opens the session last: it edits it, and A shows the notice.
    const openTwice = async (context: BrowserContext) => {
        const a = await openControlled(context, "/map/");
        await expect
            .poll(() =>
                a.evaluate(async () =>
                    (await navigator.locks.query()).held?.map((l) => l.name),
                ),
            )
            .toContain("searchlight-session:session-1");
        const b = await openControlled(context, "/map/");
        await expect(notice(a)).toBeVisible({ timeout: 30_000 });
        await expect(notice(b)).toBeHidden();
        return [a, b];
    };
    const offerUpdate = async (page: Page) => {
        deployed = "update";
        await checkForUpdate(page);
        await expect(
            page.getByText("A new version of Searchlight is available"),
        ).toBeVisible({ timeout: 30_000 });
    };

    test("an update accepted in the tab that edits leaves it editing", async ({
        context,
    }) => {
        const [a, b] = await openTwice(context);
        await offerUpdate(b);
        await b.getByRole("button", { name: "Reload" }).click();

        await expect.poll(() => onNextBuild(b), { timeout: 30_000 }).toBe(true);
        await b.waitForTimeout(3_000);
        // A would take the session back if it reloaded: Use here reloads it.
        expect(await Promise.all([a, b].map(history))).toEqual([
            { loads: 1, reloads: 0 },
            { loads: 2, reloads: 1 },
        ]);
        await expect(notice(b)).toBeHidden();
        await expect(notice(a)).toBeVisible();
    });

    test("Reload tapped in the tab the session was taken from reloads it", async ({
        context,
    }) => {
        const [a, b] = await openTwice(context);
        await offerUpdate(a);
        await a.getByRole("button", { name: "Reload" }).click();
        await expectReloadedOnceIntoNextBuild([a, b]);
    });
});
