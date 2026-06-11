import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { gameRoutes } from "./games.js";
import { GAME_VISIBILITY_GATES } from "../lib/game-gates.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const USER_ID = "test-games-gate-user";
const AUTH_SESSION_ID = "test-games-gate-auth";

const ROTTERDAM_SENTINEL = "__bundled-exter-rotterdam-2026__";
const HOME_GAMES_ID = "home-games";
const EU_NONGATED_SENTINEL = "__test-eu-nongated__";

const gate = GAME_VISIBILITY_GATES.find(
    (g) => g.sentinelValue === ROTTERDAM_SENTINEL,
)!;
const EU_SERVER_ID = gate.requireGuildId;
const GATE_ROLE_ID = gate.requireRoleId;

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

/** Set the user's cached Discord roles in the EU guild (fresh, so no Discord call). */
async function setEuRoles(roles: string[]) {
    await prisma.serverMembershipCache.upsert({
        where: { userId_serverId: { userId: USER_ID, serverId: EU_SERVER_ID } },
        update: { roles, cachedAt: new Date() },
        create: { userId: USER_ID, serverId: EU_SERVER_ID, roles, cachedAt: new Date() },
    });
}

describe("GET /games — Home Games per-game visibility gate", () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;

    beforeAll(async () => {
        // Sanity: the gate must be configured for Rotterdam.
        expect(gate).toBeDefined();

        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.game.deleteMany({ where: { sentinelValue: EU_NONGATED_SENTINEL } });
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

        // Servers + games (idempotent — these usually exist from the seed).
        await prisma.server.upsert({
            where: { id: HOME_GAMES_ID },
            update: {},
            create: { id: HOME_GAMES_ID, name: "Home Games" },
        });
        await prisma.server.upsert({
            where: { id: EU_SERVER_ID },
            update: {},
            create: { id: EU_SERVER_ID, name: "JetLag EU" },
        });
        await prisma.game.upsert({
            where: { sentinelValue: ROTTERDAM_SENTINEL },
            update: { serverId: HOME_GAMES_ID },
            create: {
                serverId: HOME_GAMES_ID,
                name: "Exter Rotterdam 26",
                sentinelValue: ROTTERDAM_SENTINEL,
                kmlPath: "exter-rotterdam-poi.kml",
                mapLocationJson: { type: "Feature" },
                hidingRadius: 250,
                hidingRadiusUnits: "meters",
            },
        });
        // A non-gated game on the EU server to prove normal listing is unaffected.
        await prisma.game.create({
            data: {
                serverId: EU_SERVER_ID,
                name: "Test EU Non-Gated",
                sentinelValue: EU_NONGATED_SENTINEL,
                kmlPath: "x.kml",
                mapLocationJson: { type: "Feature" },
                hidingRadius: 1,
                hidingRadiusUnits: "kilometers",
            },
        });

        app = await buildTestApp();
    });

    afterAll(async () => {
        await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.game.deleteMany({ where: { sentinelValue: EU_NONGATED_SENTINEL } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        await app.close();
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
        const sentinels = res.json().games.map((g: any) => g.sentinelValue);
        expect(sentinels).toContain(ROTTERDAM_SENTINEL);
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
        const sentinels = res.json().games.map((g: any) => g.sentinelValue);
        expect(sentinels).not.toContain(ROTTERDAM_SENTINEL);
    });

    test("non-gated games on a real server are unaffected by the gate", async () => {
        await setEuRoles([]); // any cache row counts as EU membership

        const res = await app.inject({
            method: "GET",
            url: `/games?serverId=${EU_SERVER_ID}`,
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });

        expect(res.statusCode).toBe(200);
        const sentinels = res.json().games.map((g: any) => g.sentinelValue);
        expect(sentinels).toContain(EU_NONGATED_SENTINEL);
    });
});
