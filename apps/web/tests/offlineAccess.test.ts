import { beforeEach, describe, expect, test, vi } from "vitest";

const local = new Map<string, string>();
vi.stubGlobal("localStorage", {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
});
const deleted: string[] = [];
vi.stubGlobal("caches", {
    keys: async () => ["searchlight-game-revisions-v1", "other-cache"],
    delete: async (name: string) => {
        deleted.push(name);
        return true;
    },
});

import { offlineUserId, verifiedUserId } from "@/lib/activeSession";
import { offlinePlayer } from "@/lib/authCheck";
import {
    endOfflineAccess,
    forgetAccount,
    lastUser,
    OFFLINE_ACCESS_MS,
    offlineAccount,
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
