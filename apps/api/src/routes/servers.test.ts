import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

// Discord answers membership lookups: the user is in MEMBER_SERVER_ID only.
vi.mock("../lib/discord-client.js", () => ({
    discord: {
        getGuildMember: vi.fn(async (serverId: string) =>
            serverId === "test-servers-member" ? { roles: [], nick: null } : null,
        ),
    },
}));

// GET /servers checks every server, including other suites' (created and
// deleted while this runs): caching this user's memberships there would block
// their cleanup. Outside this suite's servers, the user is in none.
vi.mock("../lib/permissions.js", async (importOriginal) => {
    const original = await importOriginal<typeof import("../lib/permissions.js")>();
    return {
        ...original,
        isServerMember: async (...args: Parameters<typeof original.isServerMember>) =>
            args[1].startsWith("test-servers-") ? original.isServerMember(...args) : false,
    };
});

import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { discord } from "../lib/discord-client.js";
import { serverRoutes } from "./servers.js";

const mockGetMember = discord.getGuildMember as unknown as ReturnType<typeof vi.fn>;

const USER_ID = "test-servers-virtual-user";
const AUTH_SESSION_ID = "test-servers-virtual-auth";
const HOME_GAMES_ID = "home-games";
const MEMBER_SERVER_ID = "test-servers-member";
const OTHER_SERVER_ID = "test-servers-other";
const SESSION_SERVER_ID = "test-servers-session";
const TEST_SERVER_IDS = [MEMBER_SERVER_ID, OTHER_SERVER_ID, SESSION_SERVER_ID];
const GAME_ID = "test-servers-game";
const SESSION_ID = "test-servers-session-1";

async function buildTestApp() {
    const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(fastifyCookie, { secret: process.env["SESSION_COOKIE_SECRET"]! });
    await app.register(serverRoutes, { prefix: "/servers" });
    await app.ready();
    return app;
}

function signedCookie(app: Awaited<ReturnType<typeof buildTestApp>>, value: string) {
    return `session=${app.signCookie(value)}`;
}

async function cleanup() {
    await prisma.gameSession.deleteMany({ where: { id: SESSION_ID } });
    await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
    await prisma.game.deleteMany({ where: { id: GAME_ID } });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: { in: TEST_SERVER_IDS } } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
}

describe("GET /servers", () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;

    beforeAll(async () => {
        await cleanup();

        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "servers-virtual",
                displayName: "Servers Virtual",
                avatarUrl: "https://example.com/a.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.authSession.create({
            data: { id: AUTH_SESSION_ID, userId: USER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        });
        await prisma.server.createMany({
            data: [{ id: HOME_GAMES_ID, name: "Home Games" }],
            skipDuplicates: true,
        });
        await prisma.server.createMany({
            data: [
                { id: MEMBER_SERVER_ID, name: "Member Server" },
                { id: OTHER_SERVER_ID, name: "Other Server" },
                { id: SESSION_SERVER_ID, name: "Session Server" },
            ],
        });

        // A session on a server the user isn't in, as started from a game link.
        await prisma.game.create({
            data: { id: GAME_ID, serverId: SESSION_SERVER_ID, name: "Linked Game", gameKey: GAME_ID, size: "medium" },
        });
        const rev = await prisma.gameRevision.create({
            data: { gameId: GAME_ID, revision: 1, checksum: "test-servers-rev", definition: {} },
        });
        await prisma.gameSession.create({
            data: {
                id: SESSION_ID,
                gameId: GAME_ID,
                serverId: SESSION_SERVER_ID,
                creatorId: USER_ID,
                name: "Linked Session",
                visibility: "private",
                gameRevisionId: rev.id,
            },
        });

        app = await buildTestApp();
    });

    afterAll(async () => {
        await cleanup();
        if (app) {
            await app.close();
        }
    });

    async function listServers() {
        const res = await app.inject({
            method: "GET",
            url: "/servers",
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });
        expect(res.statusCode).toBe(200);
        return res.json().servers as { id: string; permissions: string[]; isMember: boolean }[];
    }

    test("lists the virtual Home Games server with empty permissions (no Discord call)", async () => {
        const home = (await listServers()).find((s) => s.id === HOME_GAMES_ID);
        expect(home, "Home Games should be present for every authed user").toBeDefined();
        expect(home!.permissions).toEqual([]);
        expect(home!.isMember).toBe(true);
        expect(mockGetMember).not.toHaveBeenCalledWith(HOME_GAMES_ID, expect.anything(), expect.anything());
    });

    test("lists servers the user is in and leaves out the ones they aren't", async () => {
        const ids = (await listServers()).map((s) => s.id);
        expect(ids).toContain(MEMBER_SERVER_ID);
        expect(ids).not.toContain(OTHER_SERVER_ID);
    });

    test("lists a server the user isn't in when they have a session there, as a non-member", async () => {
        const servers = await listServers();
        expect(servers.find((s) => s.id === MEMBER_SERVER_ID)!.isMember).toBe(true);
        const sessionServer = servers.find((s) => s.id === SESSION_SERVER_ID);
        expect(sessionServer).toMatchObject({ isMember: false, permissions: [] });
    });

    test("keeps a server with the user's sessions listed when Discord can't be reached", async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        const answerMembership = mockGetMember.getMockImplementation();
        mockGetMember.mockRejectedValue(new Error("Discord unavailable"));
        try {
            const ids = (await listServers()).map((s) => s.id);
            expect(ids).toContain(SESSION_SERVER_ID);
            expect(ids).not.toContain(MEMBER_SERVER_ID);
            expect(ids).not.toContain(OTHER_SERVER_ID);
        } finally {
            mockGetMember.mockImplementation(answerMembership!);
        }
    });
});
