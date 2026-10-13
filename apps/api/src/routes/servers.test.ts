import { afterAll, beforeAll, describe, expect, test } from "vitest";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { serverRoutes } from "./servers.js";

const USER_ID = "test-servers-virtual-user";
const AUTH_SESSION_ID = "test-servers-virtual-auth";
const HOME_GAMES_ID = "home-games";

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

describe("GET /servers — virtual servers", () => {
    let app: Awaited<ReturnType<typeof buildTestApp>>;

    beforeAll(async () => {
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });

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

        app = await buildTestApp();
    });

    afterAll(async () => {
        await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
        await prisma.user.deleteMany({ where: { discordId: USER_ID } });
        if (app) {
            await app.close();
        }
    });

    test("lists the virtual Home Games server with empty permissions (no Discord call)", async () => {
        const res = await app.inject({
            method: "GET",
            url: "/servers",
            headers: { cookie: signedCookie(app, AUTH_SESSION_ID) },
        });

        expect(res.statusCode).toBe(200);
        const home = res.json().servers.find((s: any) => s.id === HOME_GAMES_ID);
        expect(home, "Home Games should be present for every authed user").toBeDefined();
        expect(home.permissions).toEqual([]);
    });
});
