import { afterEach, describe, expect, it, vi } from "vitest";

import { readClipboardText } from "@/components/PasteFallback";

const stubClipboard = (clipboard: unknown) =>
    vi.stubGlobal("navigator", { clipboard });

describe("readClipboardText", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("returns the clipboard's text when the browser allows it", async () => {
        stubClipboard({ readText: async () => '{"id":"radius"}' });
        expect(await readClipboardText()).toBe('{"id":"radius"}');
    });

    it("returns null when reading is blocked", async () => {
        stubClipboard({
            readText: async () => {
                throw new DOMException("Denied", "NotAllowedError");
            },
        });
        expect(await readClipboardText()).toBeNull();
    });

    it("returns null without the Clipboard API", async () => {
        stubClipboard(undefined);
        expect(await readClipboardText()).toBeNull();
    });

    it("returns null for an empty clipboard", async () => {
        stubClipboard({ readText: async () => "" });
        expect(await readClipboardText()).toBeNull();
    });
});
