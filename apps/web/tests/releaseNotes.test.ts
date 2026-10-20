import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanTestStorage, useTestStorageEngine } from "@nanostores/persistent";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { parseInline, parseNotes } from "@/lib/markdownNotes";
import {
    isNewerRelease,
    notesVersion,
    releaseNotesToShow,
} from "@/lib/releaseNotes";

const RELEASES_DIR = resolve(__dirname, "../../../docs/releases");

describe("release versions", () => {
    it("takes a patch release's notes from its minor release", () => {
        expect(notesVersion("2.1.0")).toBe("2.1.0");
        expect(notesVersion("2.1.3")).toBe("2.1.0");
        expect(notesVersion("2.1")).toBeNull();
    });

    it("counts only major and minor releases as new", () => {
        expect(isNewerRelease("2.1.0", "2.0.0")).toBe(true);
        expect(isNewerRelease("3.0.0", "2.9.4")).toBe(true);
        expect(isNewerRelease("2.10.0", "2.9.0")).toBe(true);
        expect(isNewerRelease("2.0.1", "2.0.0")).toBe(false);
        expect(isNewerRelease("2.0.0", "2.0.0")).toBe(false);
        expect(isNewerRelease("2.0.0", "2.1.0")).toBe(false);
        expect(isNewerRelease("2.0.0", "")).toBe(true);
    });
});

describe("releaseNotesToShow", () => {
    const available = ["1.0.0", "2.0.0", "2.1.0"];

    it("shows a new minor release's notes once", () => {
        expect(releaseNotesToShow("2.1.0", "2.0.0", true, available)).toBe(
            "2.1.0",
        );
        expect(releaseNotesToShow("2.1.2", "2.0.0", true, available)).toBe(
            "2.1.0",
        );
        expect(
            releaseNotesToShow("2.1.2", "2.1.0", true, available),
        ).toBeNull();
    });

    it("shows nothing for a patch release", () => {
        expect(
            releaseNotesToShow("2.0.1", "2.0.0", true, available),
        ).toBeNull();
    });

    it("shows nothing for a release without notes", () => {
        expect(
            releaseNotesToShow("2.2.0", "2.1.0", true, available),
        ).toBeNull();
    });

    it("shows a player who used the app before tracking began the current notes", () => {
        expect(releaseNotesToShow("2.0.0", "", true, available)).toBe("2.0.0");
    });

    it("shows a brand-new player nothing", () => {
        expect(releaseNotesToShow("2.0.0", "", false, available)).toBeNull();
    });
});

describe("checkReleaseNotes", () => {
    beforeAll(() => useTestStorageEngine());

    afterEach(() => {
        cleanTestStorage();
        vi.unstubAllGlobals();
        vi.resetModules();
    });

    // What earlier versions of Searchlight left in localStorage.
    async function load(stored: Record<string, string>) {
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => stored[key] ?? null,
        });
        vi.resetModules();
        return import("@/lib/releaseNotes");
    }

    it("marks a brand-new player as having seen the current release", async () => {
        const notes = await load({});
        expect(notes.checkReleaseNotes()).toBe(false);
        expect(notes.lastSeenRelease.get()).toBe(notes.APP_VERSION);
    });

    it("shows a returning player the current notes until they're seen", async () => {
        const notes = await load({ "taibled-authed-user": "123" });
        expect(notes.checkReleaseNotes()).toBe(true);
        notes.markReleaseNotesSeen();
        expect(notes.checkReleaseNotes()).toBe(false);
    });

    it("loads the notes of every release in docs/releases", async () => {
        const notes = await load({});
        for (const file of readdirSync(RELEASES_DIR)) {
            const version = /^(\d+\.\d+\.\d+)\.md$/.exec(file)?.[1];
            if (!version) continue;
            expect(await notes.loadReleaseNotes(version)).toBe(
                readFileSync(resolve(RELEASES_DIR, file), "utf8"),
            );
        }
    });

    it("works without storage access", async () => {
        Object.defineProperty(globalThis, "localStorage", {
            configurable: true,
            get() {
                throw new DOMException(
                    "The operation is insecure.",
                    "SecurityError",
                );
            },
        });
        vi.resetModules();
        const notes = await import("@/lib/releaseNotes");
        expect(notes.checkReleaseNotes()).toBe(false);
        delete (globalThis as { localStorage?: Storage }).localStorage;
    });
});

describe("parseNotes", () => {
    it("reads headings, paragraphs and lists", () => {
        expect(
            parseNotes(
                "Intro that\nwraps.\n\n## For players\n\n- **Curses** that\n  grow zones.\n- Open `/games/import`.\n",
            ),
        ).toEqual([
            {
                type: "paragraph",
                content: [{ type: "text", text: "Intro that wraps." }],
            },
            {
                type: "heading",
                content: [{ type: "text", text: "For players" }],
            },
            {
                type: "list",
                items: [
                    [
                        { type: "strong", text: "Curses" },
                        { type: "text", text: " that grow zones." },
                    ],
                    [
                        { type: "text", text: "Open " },
                        { type: "code", text: "/games/import" },
                        { type: "text", text: "." },
                    ],
                ],
            },
        ]);
    });

    it("links only to web addresses and keeps HTML as text", () => {
        expect(
            parseInline(
                "[GitHub](https://github.com/x) [bad](javascript:alert(1)) <img src=x>",
            ),
        ).toEqual([
            { type: "link", text: "GitHub", href: "https://github.com/x" },
            { type: "text", text: " " },
            { type: "text", text: "[bad](javascript:alert(1)" },
            { type: "text", text: ") <img src=x>" },
        ]);
    });

    it("understands every release's notes", () => {
        for (const file of readdirSync(RELEASES_DIR)) {
            if (!/^\d+\.\d+\.\d+\.md$/.test(file)) continue;
            const blocks = parseNotes(
                readFileSync(resolve(RELEASES_DIR, file), "utf8"),
            );
            const inlines = blocks.flatMap((block) =>
                block.type === "list" ? block.items.flat() : block.content,
            );
            expect(blocks.some((block) => block.type === "list")).toBe(true);
            // Nothing the renderer doesn't know is left as markdown.
            for (const inline of inlines) {
                expect(inline.text, file).not.toMatch(/\*\*|`|\]\(/);
            }
        }
    });
});
