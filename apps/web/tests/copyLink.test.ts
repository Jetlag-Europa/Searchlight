import { describe, expect, it } from "vitest";

import { withCreatedLinks } from "@/components/CopyLink";

const link = (id: string) => ({ id });

describe("withCreatedLinks", () => {
    it("keeps a link created while an older list was loading", () => {
        // The list was read before "new" existed; "new" was added on create.
        const current = [link("new"), link("a")];
        const loaded = [link("a"), link("b")];
        expect(withCreatedLinks(loaded, current, new Set(["new"]))).toEqual([
            link("new"),
            link("a"),
            link("b"),
        ]);
    });

    it("doesn't list a created link twice once the server has it", () => {
        const current = [link("new")];
        const loaded = [link("new"), link("a")];
        expect(withCreatedLinks(loaded, current, new Set(["new"]))).toEqual(
            loaded,
        );
    });

    it("uses the loaded list for everything not created during the load", () => {
        // "gone" was revoked elsewhere; "x" was created, then revoked here.
        const current = [link("gone"), link("a")];
        const loaded = [link("a")];
        expect(withCreatedLinks(loaded, current, new Set(["x"]))).toEqual(
            loaded,
        );
    });
});
