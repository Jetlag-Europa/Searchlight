import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameRoutes } from "./games.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-games-gate-user";
const AUTH_SESSION_ID = "test-games-gate-auth";

const HOME_GAMES_ID = "home-games";
const EU_NONGATED_KEY = "__test-eu-nongated__";
const EU_SERVER_ID = "1190673594649415730";
const GATE_ROLE_ID = "1514353477231312966";
async function buildTestApp() {
    const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
    await app.register(fastifyCookie, {
        secret: process.env["SESSION_COOKIE_SECRET"]!,
    });
    await app.register(gameRoutes, { prefix: "/games" });
    await app.ready();
    return app;
}

function signedCookie(app: Awaited<ReturnType<typeof buildTestApp>>, value: string) {
    return `session=${app.signCookie(value)}`;
}

/** Cache the user as an EU guild member with these roles (fresh, so no Discord call). */
async function setEuRoles(roles: string[]) {
    await prisma.serverMembershipCache.upsert({
        where: { userId_serverId: { userId: USER_ID, serverId: EU_SERVER_ID } },
        update: { isMember: true, roles, cachedAt: new Date() },
        create: { userId: USER_ID, serverId: EU_SERVER_ID, isMember: true, roles, cachedAt: new Date() },
    });
}

describe("GET /games — Home Games per-game visibility gate", () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;

    beforeAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.game.deleteMany({ where: { gameKey: EU_NONGATED_KEY } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });

        await prisma.user.create({
            data: {
                discordId: USER_ID,
                username: "testuser-games",
                displayName: "Test Games User",
                avatarUrl: "https://example.com/avatar.png",
                discordAccessToken: "tok",
                discordRefreshToken: "ref",
                discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
            },
        });
        await prisma.authSession.create({
            data: {
                id: AUTH_SESSION_ID,
                userId: USER_ID,
                expiresAt: new Date(Date.now() + 86_400_000),
            },
        });

        // Servers + games (race-safe via skipDuplicates for concurrent test suites).
        await prisma.server.createMany({
            data: [
                { id: HOME_GAMES_ID, name: "Home Games" },
                { id: EU_SERVER_ID, name: "JetLag EU" },
            ],
            skipDuplicates: true,
        });
        const rotterdam = await prisma.game.upsert({
            where: { gameKey: "exter-rotterdam-2026" },
            update: { serverId: HOME_GAMES_ID },
            create: {
                serverId: HOME_GAMES_ID,
                name: "Exter Rotterdam 26",
                gameKey: "exter-rotterdam-2026",
                size: "medium",
            },
        });
        const rev = await prisma.gameRevision.upsert({
            where: { gameId_revision: { gameId: rotterdam.id, revision: 1 } },
            update: {
                definition: {
                    id: "exter-rotterdam-2026",
                    name: "Exter Rotterdam 26",
                    serverId: HOME_GAMES_ID,
                    visibility: {
                        kind: "discord-role",
                        guildId: EU_SERVER_ID,
                        roleId: GATE_ROLE_ID,
                    },
                },
            },
            create: {
                gameId: rotterdam.id,
                revision: 1,
                checksum: "test-rev-checksum",
                definition: {
                    id: "exter-rotterdam-2026",
                    name: "Exter Rotterdam 26",
                    serverId: HOME_GAMES_ID,
                    visibility: {
                        kind: "discord-role",
                        guildId: EU_SERVER_ID,
                        roleId: GATE_ROLE_ID,
                    },
                },
            },
        });
        await prisma.game.update({
            where: { id: rotterdam.id },
            data: { currentRevisionId: rev.id },
        });

        // A non-gated game on the EU server to prove normal listing is unaffected.
        const nonGatedGame = await prisma.game.create({
            data: {
                serverId: EU_SERVER_ID,
                name: "Test EU Non-Gated",
                gameKey: EU_NONGATED_KEY,
                size: "medium",
            },
        });
        const nonGatedRev = await prisma.gameRevision.create({
            data: {
                gameId: nonGatedGame.id,
                revision: 1,
                checksum: "test-eu-nongated-checksum",
                definition: {
                    id: EU_NONGATED_KEY,
                    name: "Test EU Non-Gated",
                    serverId: EU_SERVER_ID,
                },
            },
        });
        await prisma.game.update({
            where: { id: nonGatedGame.id },
            data: { currentRevisionId: nonGatedRev.id },
        });

        app = await buildTestApp();
    });

    afterAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.gameRevision.deleteMany({ where: { game: { gameKey: EU_NONGATED_KEY } } });
        await prisma.game.deleteMany({ where: { gameKey: EU_NONGATED_KEY } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        if (app) {
            await app.close();
        }
    });

    test("returns 401 without a session cookie", async () => {
        const res = await app.inject({ method: "GET", url: "/games?serverId=home-games" });
        expect(res.statusCode).toBe(401);
    });

    test("EU member WITH the gate role sees the Rotterdam game", async () => {
        await setEuRoles([GATE_ROLE_ID]);

        const res = await app.inject({
            method: "GET",
            url: `/games?serverId=${HOME_GAMES_ID}`,
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });

        expect(res.statusCode).toBe(200);
        const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
        expect(gameKeys).toContain("exter-rotterdam-2026");
    });

    test("user WITHOUT the gate role can see Home Games but not the Rotterdam game", async () => {
        await setEuRoles([]); // member of EU but lacks the role

        const res = await app.inject({
            method: "GET",
            url: `/games?serverId=${HOME_GAMES_ID}`,
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });

        // Server is still reachable (virtual server skips membership) — 200, not 403…
        expect(res.statusCode).toBe(200);
        // …but the gated game is filtered out.
        const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
        expect(gameKeys).not.toContain("exter-rotterdam-2026");
    });

    test("non-gated games on a real server are unaffected by the gate", async () => {
        await setEuRoles([]); // an EU member without any roles

        const res = await app.inject({
            method: "GET",
            url: `/games?serverId=${EU_SERVER_ID}`,
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });

        expect(res.statusCode).toBe(200);
        const gameKeys = res.json().games.map((g: any) => g.gameKey ?? g.id);
        expect(gameKeys).toContain(EU_NONGATED_KEY);
    });
});
