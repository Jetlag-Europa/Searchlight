import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

// Mock the Discord REST client so we can detect exactly when a live fetch happens.
vi.mock("./discord-client.js", () => ({
    discord: { getGuildMember: vi.fn() },
}));

import prisma from "./prisma.js";
import { discord } from "./discord-client.js";
import { getUserRoleIds } from "./permissions.js";

const USER_ID = "test-perm-ttl-user";
const SERVER_ID = "test-perm-ttl-server";

const mockGetMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;

async function setCache(roles: string[], ageMs: number) {
    const cachedAt = new Date(Date.now() - ageMs);
    await prisma.serverMembershipCache.upsert({
        where: { userId_serverId: { userId: USER_ID, serverId: SERVER_ID } },
        update: { roles, cachedAt },
        create: { userId: USER_ID, serverId: SERVER_ID, roles, cachedAt },
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
});
