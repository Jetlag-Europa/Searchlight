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
    rememberUser,
} from "@/lib/offlineAccess";

const STORED = "taibled-authed-user";

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
});
