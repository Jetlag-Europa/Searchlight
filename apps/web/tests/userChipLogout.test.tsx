// Logging out from the user chip: only once the API has ended the login does
// this browser forget the account. A logout that didn't reach it leaves the
// login cookie working, so the player is told and stays signed in.
import type { User } from "@searchlight/shared";
import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    toastError: vi.fn(),
    forgetAccount: vi.fn(async () => {}),
    clearActiveSession: vi.fn(),
}));
vi.mock("react-toastify", () => ({ toast: { error: mocks.toastError } }));
vi.mock("@nanostores/react", () => ({ useStore: () => false }));
vi.mock("@/lib/offlineAccess", () => ({ forgetAccount: mocks.forgetAccount }));
vi.mock("@/lib/activeSession", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/activeSession")>()),
    clearActiveSession: mocks.clearActiveSession,
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
const location = { href: "/map/" };
vi.stubGlobal("window", { location });
vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
});
vi.spyOn(console, "warn").mockImplementation(() => {});
vi.spyOn(console, "info").mockImplementation(() => {});

import { UserChip } from "@/components/UserChip";

const user = { discordId: "u1", displayName: "Alice", avatarUrl: "" } as User;

// UserChip's only hook is mocked, so it renders as a plain function.
function logOutButton(
    node: ReactNode,
): ReactElement<{ onClick: () => Promise<void> }> {
    if (!node || typeof node !== "object") return undefined as never;
    if (Array.isArray(node)) {
        for (const child of node) {
            const found = logOutButton(child);
            if (found) return found;
        }
        return undefined as never;
    }
    const element = node as ReactElement<Record<string, unknown>>;
    if (element.props["aria-label"] === "Log out") return element as never;
    return logOutButton(element.props.children as ReactNode);
}

async function logOut() {
    await logOutButton(
        UserChip({ user, apiBase: "https://api.test" }),
    ).props.onClick();
}

beforeEach(() => {
    vi.clearAllMocks();
    location.href = "/map/";
});

describe("logging out", () => {
    test("forgets the account here once the API ended the login", async () => {
        mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
        await logOut();
        expect(mockFetch).toHaveBeenCalledWith(
            "https://api.test/auth/logout",
            expect.objectContaining({ method: "POST", credentials: "include" }),
        );
        expect(mocks.forgetAccount).toHaveBeenCalledTimes(1);
        expect(mocks.clearActiveSession).toHaveBeenCalledTimes(1);
        expect(location.href).toBe("/");
        expect(mocks.toastError).not.toHaveBeenCalled();
    });

    test.each([
        [
            "doesn't reach the API",
            () => Promise.reject(new TypeError("Failed to fetch")),
        ],
        [
            "gets a server error",
            () => Promise.resolve(new Response(null, { status: 502 })),
        ],
    ])(
        "that %s says so, and leaves the player signed in",
        async (_, answer) => {
            mockFetch.mockImplementation(answer);
            await logOut();
            expect(mocks.toastError).toHaveBeenCalledTimes(1);
            expect(mocks.forgetAccount).not.toHaveBeenCalled();
            expect(mocks.clearActiveSession).not.toHaveBeenCalled();
            expect(location.href).toBe("/map/");
        },
    );
});
