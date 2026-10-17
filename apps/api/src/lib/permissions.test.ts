import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the Discord REST client so we can detect exactly when a live fetch happens.
vi.mock("./discord-client.js", () => ({
    discord: { getGuildMember: vi.fn() },
}));

import prisma from "./prisma.js";
import { discord } from "./discord-client.js";
import {
    assertServerMembership,
    getUserPermissions,
    getUserRoleIds,
    hasPermissionOnSomeServer,
    userPassesDiscordRoleGate,
} from "./permissions.js";

const USER_ID = "test-perm-ttl-user";
const SERVER_ID = "test-perm-ttl-server";

const mockGetMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;

async function setCache(roles: string[], ageMs: number) {
    const cachedAt = new Date(Date.now() - ageMs);
    await prisma.serverMembershipCache.upsert({
        where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
        update: { isMember: true, roles, cachedAt },
        create: { userId: USER_ID, serverId: SERVER_ID, isMember: true, roles, cachedAt },
    });
}

describe("getUserRoleIds — cache TTL (1 hour default, 1 minute when privileged)", () => {
    beforeAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.authSession.deleteMany({ where: { userId: USER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });

        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "perm-ttl",
                displayName: "Perm TTL",
                avatarUrl: "https://example.com/a.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
    });

    afterAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    });

    beforeEach(() => {
        mockGetMember.mockReset();
        mockGetMember.mockResolvedValue({ roles: ["fresh-role"], nick: null });
    });

    test("default read serves a 30-minute-old cache without calling Discord", async () => {
        await setCache(["cached-role"], 30 * 60 * 1000);
        const roles = await getUserRoleIds(USER_ID, SERVER_ID, false);
        expect(roles).toEqual(["cached-role"]);
        expect(mockGetMember).not.toHaveBeenCalled();
    });

    test("privileged read refetches a 30-minute-old cache (older than 1 min)", async () => {
        await setCache(["cached-role"], 30 * 60 * 1000);
        const roles = await getUserRoleIds(USER_ID, SERVER_ID, true);
        expect(mockGetMember).toHaveBeenCalledOnce();
        expect(roles).toEqual(["fresh-role"]);
    });

    test("privileged read still serves a 10-second-old cache (within 1 min)", async () => {
        await setCache(["cached-role"], 10 * 1000);
        const roles = await getUserRoleIds(USER_ID, SERVER_ID, true);
        expect(roles).toEqual(["cached-role"]);
        expect(mockGetMember).not.toHaveBeenCalled();
    });
    test("denies a gated game when Discord role verification fails", async () => {
        await setCache(["stale-role"], 2 * 60 * 1000);
        mockGetMember.mockRejectedValue(new Error("Discord unavailable"));
        expect(await userPassesDiscordRoleGate(USER_ID, SERVER_ID, "stale-role")).toBe(false);
    });
});

describe("assertServerMembership — cached membership", () => {
    beforeAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });

        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "perm-ttl",
                displayName: "Perm TTL",
                avatarUrl: "https://example.com/a.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
    });

    afterAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    });

    beforeEach(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        mockGetMember.mockReset();
    });

    test("rejects a non-member whose role lookup was cached", async () => {
        // GET /servers resolves permissions for every server, caching non-members too.
        mockGetMember.mockResolvedValue(null);
        expect([...(await getUserPermissions(USER_ID, SERVER_ID))]).toEqual([]);

        await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
            statusCode: 403,
        });
    });

    test("accepts a cached member without calling Discord", async () => {
        await setCache([], 30 * 60 * 1000);
        await assertServerMembership(USER_ID, SERVER_ID);
        expect(mockGetMember).not.toHaveBeenCalled();
    });

    test("re-checks a membership cached longer than an hour ago", async () => {
        await setCache([], 2 * 60 * 60 * 1000);
        mockGetMember.mockResolvedValue(null);
        await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(mockGetMember).toHaveBeenCalledOnce();
    });

    test("re-checks a cached non-member after a minute, so joining takes effect", async () => {
        mockGetMember.mockResolvedValue(null);
        await expect(assertServerMembership(USER_ID, SERVER_ID)).rejects.toMatchObject({
            statusCode: 403,
        });
        await prisma.serverMembershipCache.update({
            where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
            data: { cachedAt: new Date(Date.now() - 2 * 60 * 1000) },
        });

        mockGetMember.mockResolvedValue({ roles: [], nick: null });
        await assertServerMembership(USER_ID, SERVER_ID);
        expect(mockGetMember).toHaveBeenCalledTimes(2);
    });
});

describe("hasPermissionOnSomeServer", () => {
    const ROLE_ID = "test-perm-ttl-importer";

    beforeAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });

        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "perm-ttl",
                displayName: "Perm TTL",
                avatarUrl: "https://example.com/a.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.server.create({ data: { id: SERVER_ID, name: "Perm TTL Server" } });
        await prisma.rolePermission.create({
            data: { serverId: SERVER_ID, discordRoleId: ROLE_ID, permission: "games.create" },
        });
    });

    afterAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.rolePermission.deleteMany({ where: { serverId: SERVER_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    });

    beforeEach(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        mockGetMember.mockReset();
    });

    test("finds a permission held through a cached member's role", async () => {
        await setCache([ROLE_ID], 10 * 1000);
        expect(await hasPermissionOnSomeServer(USER_ID, ["games.create"])).toBe(true);
        expect(await hasPermissionOnSomeServer(USER_ID, ["server.admin"])).toBe(false);
        expect(mockGetMember).not.toHaveBeenCalled();
    });

    test("re-checks the roles of a membership cached over a minute ago", async () => {
        await setCache([ROLE_ID], 2 * 60 * 1000);
        mockGetMember.mockResolvedValue({ roles: [], nick: null });
        expect(await hasPermissionOnSomeServer(USER_ID, ["games.create"])).toBe(false);
        expect(mockGetMember).toHaveBeenCalledOnce();
    });

    test("doesn't look up servers the user isn't cached as a member of", async () => {
        expect(await hasPermissionOnSomeServer(USER_ID, ["games.create"])).toBe(false);
        expect(mockGetMember).not.toHaveBeenCalled();
    });
});
