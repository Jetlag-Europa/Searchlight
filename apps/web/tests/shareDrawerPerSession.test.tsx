// The "Share a copy" drawer keeps its links per session: switching to another
// session starts it afresh, so the previous session's links never show, or
// get copied or revoked, under the new one (even when the new list can't load).
import type { GameSessionSummary } from "@searchlight/shared";
import type { ReactElement } from "react";
import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@nanostores/react", () => ({ useStore: () => mocks.session }));

import { ShareDrawer } from "@/components/ShareDrawer";

function session(id: string, role: GameSessionSummary["role"]) {
    return { id, name: id, role } as GameSessionSummary;
}

// ShareDrawer's only hook is mocked, so it renders as a plain function.
function render(s: GameSessionSummary | null) {
    mocks.session = s;
    return ShareDrawer({}) as ReactElement | null;
}

describe("ShareDrawer", () => {
    test("is keyed by the session, so a switch starts it afresh", () => {
        const a = render(session("a", "creator"));
        const b = render(session("b", "creator"));
        expect(a?.key).toBe("a");
        expect(b?.key).toBe("b");
        expect(a?.type).toBe(b?.type);
    });

    test("shows nothing to anyone but the creator", () => {
        expect(render(session("a", "member"))).toBeNull();
        expect(render(null)).toBeNull();
    });
});
