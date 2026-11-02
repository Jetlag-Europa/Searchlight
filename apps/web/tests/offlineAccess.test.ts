import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const local = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    get length() {
        return local.size;
    },
    key: (i: number) => Array.from(local.keys())[i] ?? null,
});
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);
vi.stubGlobal("window", new EventTarget());
const deleted: string[] = [];
vi.stubGlobal("caches", {
    keys: async () => ["searchlight-game-revisions-v1", "other-cache"],
    delete: async (name: string) => {
        deleted.push(name);
        return true;
    },
});

import { offlineUserId, verifiedUserId } from "@/lib/activeSession";
import { offlinePlayer, watchAuth } from "@/lib/authCheck";
import { enqueueEvent, getPendingEvents } from "@/lib/eventQueue";
import {
    endOfflineAccess,
    forgetAccount,
    lastUser,
    LOGIN_STARTED_KEY,
    OFFLINE_ACCESS_MS,
    offlineAccount,
    playOfflineWhileUnreachable,
    rememberUser,
} from "@/lib/offlineAccess";

const STORED = "taibled-authed-user";
const VERIFIED_AT = "taibled-authed-user-verified";
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 1);

beforeEach(() => {
    local.clear();
    deleted.length = 0;
    offlineUserId.set(null);
    verifiedUserId.set(null);
});

describe("offline access", () => {
    test("is for the account /me last verified", () => {
        rememberUser("u1");
        expect(offlinePlayer(local.get(STORED) ?? null, null)).toBe("u1");
        expect(lastUser()).toBe("u1");
    });

    test("ends with a 401, kept games and all, but the account is still told apart", async () => {
        rememberUser("u1");
        offlineUserId.set("u1");
        await endOfflineAccess();

        expect(local.get(STORED)).toBeUndefined();
        expect(offlinePlayer(local.get(STORED) ?? null, null)).toBeNull();
        expect(offlineUserId.get()).toBeNull();
        expect(deleted).toEqual(["searchlight-game-revisions-v1"]);
        // The next login is compared with u1, to clear u1's session for another.
        expect(lastUser()).toBe("u1");
    });

    test("comes back when the account logs in again", async () => {
        rememberUser("u1");
        await endOfflineAccess();
        rememberUser("u1");
        expect(local.get(STORED)).toBe("u1");
        expect(local.has("taibled-previous-user")).toBe(false);
    });

    test("is gone after logging out, with nothing left to compare", async () => {
        rememberUser("u1");
        verifiedUserId.set("u1");
        await endOfflineAccess();
        rememberUser("u1");
        await forgetAccount();
        expect(lastUser()).toBeNull();
        expect(verifiedUserId.get()).toBeNull();
        expect(deleted).toContain("searchlight-game-revisions-v1");
    });

    test("lasts a week after /me last verified the account", () => {
        rememberUser("u1", T0);
        expect(OFFLINE_ACCESS_MS).toBe(7 * DAY);
        expect(offlineAccount(T0 + 6 * DAY)).toBe("u1");
        // Each verification starts the week again.
        rememberUser("u1", T0 + 6 * DAY);
        expect(offlineAccount(T0 + 12 * DAY)).toBe("u1");
    });

    test("ends after a week, kept games and all, as with a 401", async () => {
        rememberUser("u1", T0);
        offlineUserId.set("u1");
        expect(offlineAccount(T0 + 7 * DAY + 1)).toBeNull();
        await vi.waitFor(() =>
            expect(deleted).toEqual(["searchlight-game-revisions-v1"]),
        );

        expect(local.get(STORED)).toBeUndefined();
        expect(local.get(VERIFIED_AT)).toBeUndefined();
        expect(offlineUserId.get()).toBeNull();
        // Still told apart from the next account.
        expect(lastUser()).toBe("u1");
        // And it stays ended, even back within the week.
        expect(offlineAccount(T0)).toBeNull();
        // Until the account is verified again.
        rememberUser("u1", T0 + 8 * DAY);
        expect(offlineAccount(T0 + 8 * DAY)).toBe("u1");
    });

    test("an account stored by an older build gets a week from now", () => {
        local.set(STORED, "u1");
        expect(offlineAccount(T0)).toBe("u1");
        expect(local.get(VERIFIED_AT)).toBe(String(T0));
        // The clock started then, rather than at every check.
        expect(offlineAccount(T0 + 6 * DAY)).toBe("u1");
        expect(offlineAccount(T0 + 7 * DAY)).toBeNull();
    });

    test("a clock set wrong doesn't keep it open for good", () => {
        rememberUser("u1", T0 + 365 * DAY);
        expect(offlineAccount(T0)).toBeNull();
        local.set(STORED, "u1");
        local.set(VERIFIED_AT, "garbage");
        expect(offlineAccount(T0)).toBeNull();
    });

    test("leaves no time behind after logging out", async () => {
        rememberUser("u1", T0);
        await forgetAccount();
        expect(local.has(VERIFIED_AT)).toBe(false);
        expect(offlineAccount(T0)).toBeNull();
    });
});

describe("starting a login", () => {
    test("ends offline play for the stored account until /me verifies one", async () => {
        rememberUser("u1", T0);
        local.set(LOGIN_STARTED_KEY, "1");
        // The new player's first /me fails: u1's board isn't theirs to see.
        expect(offlinePlayer(offlineAccount(T0), null)).toBeNull();
        await vi.waitFor(() =>
            expect(deleted).toEqual(["searchlight-game-revisions-v1"]),
        );
        expect(local.get(STORED)).toBeUndefined();
        // u1 is still told apart, so /me for someone else clears u1's session.
        expect(lastUser()).toBe("u1");

        // /me verifies the new account: it may play offline from then on.
        rememberUser("u2", T0);
        expect(local.has(LOGIN_STARTED_KEY)).toBe(false);
        expect(offlineAccount(T0)).toBe("u2");
    });

    test("verified before the connection drops, the account plays on", () => {
        rememberUser("u1", T0);
        local.set(LOGIN_STARTED_KEY, "1");
        rememberUser("u1", T0 + 1);
        expect(offlineAccount(T0 + 2)).toBe("u1");
    });

    test("logging out forgets it too", async () => {
        local.set(LOGIN_STARTED_KEY, "1");
        await forgetAccount();
        expect(local.has(LOGIN_STARTED_KEY)).toBe(false);
    });

    // The pages' scripts are inline, without imports, so they spell the key
    // out: every login link there must set it.
    test("is marked by every login link in the app", () => {
        const sources = (dir: string): [string, string][] =>
            readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
                const path = resolve(dir, entry.name);
                if (entry.isDirectory()) return sources(path);
                return /\.(astro|tsx?)$/.test(entry.name)
                    ? [[entry.name, readFileSync(path, "utf8")]]
                    : [];
            });
        const marked = new Map<string, [number, number]>();
        for (const [name, source] of sources(resolve(__dirname, "../src"))) {
            const logins = source.split("/auth/discord/login").length - 1;
            if (logins === 0) continue;
            const marks =
                source.split(
                    `localStorage.setItem("${LOGIN_STARTED_KEY}", "1")`,
                ).length - 1;
            marked.set(name, [logins, marks]);
        }
        expect(Object.fromEntries(marked)).toEqual({
            "index.astro": [1, 1],
            "join.astro": [1, 1],
            "play.astro": [1, 1],
        });
    });
});

describe("a bad connection that outlasts the week", () => {
    let stop = () => {};

    beforeEach(() => {
        vi.useFakeTimers();
        vi.spyOn(console, "warn").mockImplementation(() => {});
        mockFetch.mockReset();
        mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));
    });

    afterEach(() => {
        stop();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    // AuthGuard's handlers, as it wires them up.
    function watch() {
        const signedOut = vi.fn(() => void endOfflineAccess());
        stop = watchAuth("/me", {
            signedIn: vi.fn(),
            signedOut,
            unreachable: () => void playOfflineWhileUnreachable(),
        });
        return signedOut;
    }

    function edit(n: number) {
        enqueueEvent({
            sessionId: "s1",
            type: "stroke.create",
            payloadJson: { n },
            clientUuid: `c${n}`,
            clientCreatedAt: n,
        });
    }

    test("doesn't end the offline play already going on this page", async () => {
        rememberUser("u1", T0);
        vi.setSystemTime(T0 + 7 * DAY - 60_000);
        watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(offlineUserId.get()).toBe("u1");
        edit(1);

        // /me keeps failing, past the week…
        vi.setSystemTime(T0 + 7 * DAY + 60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        // …and with a login started in another tab.
        local.set(LOGIN_STARTED_KEY, "1");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mockFetch.mock.calls.length).toBeGreaterThan(4);

        expect(offlineUserId.get()).toBe("u1");
        edit(2);
        expect(getPendingEvents("s1").map((e) => e.payloadJson)).toEqual([
            { n: 1 },
            { n: 2 },
        ]);
        expect(local.has("taibled-pending-s1~u1")).toBe(true);
        expect(local.get(STORED)).toBe("u1");
        expect(deleted).toEqual([]);
    });

    test("a page that hasn't started it yet doesn't, past the week", async () => {
        rememberUser("u1", T0);
        vi.setSystemTime(T0 + 7 * DAY + 1);
        watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(offlineUserId.get()).toBeNull();
        await vi.waitFor(() =>
            expect(deleted).toEqual(["searchlight-game-revisions-v1"]),
        );
    });

    test("a 401 still ends it", async () => {
        rememberUser("u1", T0);
        vi.setSystemTime(T0 + DAY);
        mockFetch.mockReset();
        mockFetch
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockResolvedValueOnce(new Response(null, { status: 401 }));
        const signedOut = watch();
        await vi.advanceTimersByTimeAsync(0);
        expect(offlineUserId.get()).toBe("u1");
        await vi.advanceTimersByTimeAsync(2_000);
        expect(signedOut).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => expect(offlineUserId.get()).toBeNull());
    });
});
