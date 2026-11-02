import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { eventRoutes } from "./events.js";
import { sessionRoutes } from "./sessions.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const CREATOR_ID = "test-spatch-creator";
const MEMBER_ID = "test-spatch-member";
const SERVER_ID = "test-spatch-server";
const OTHER_SERVER_ID = "test-spatch-server2";
const GAME_ID = "test-spatch-game";
const OTHER_GAME_ID = "test-spatch-game2";
const SESSION_ID = "test-spatch-session";
const CREATOR_AUTH_ID = "test-spatch-auth-creator";
const MEMBER_AUTH_ID = "test-spatch-auth-member";
const OUTSIDER_ID = "test-spatch-outsider";
const OUTSIDER_AUTH_ID = "test-spatch-auth-outsider";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.register(eventRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

async function cleanup() {
  await prisma.event.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.authSession.deleteMany({ where: { id: { in: [CREATOR_AUTH_ID, MEMBER_AUTH_ID, OUTSIDER_AUTH_ID] } } });
  await prisma.gameSession.deleteMany({ where: { id: SESSION_ID } });
  await prisma.gameRevision.deleteMany({ where: { gameId: { in: [GAME_ID, OTHER_GAME_ID] } } });
  await prisma.game.deleteMany({ where: { id: { in: [GAME_ID, OTHER_GAME_ID] } } });
  await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
  await prisma.user.deleteMany({ where: { discordId: { in: [CREATOR_ID, MEMBER_ID, OUTSIDER_ID] } } });
}

describe("PATCH /sessions/:sessionId permissions", () => {
  let app: FastifyInstance;
  let creatorCookie: string;
  let memberCookie: string;
  let outsiderCookie: string;
  let revisionId: string;
  let otherRevisionId: string;

  beforeAll(async () => {
    await cleanup();

    for (const [discordId, username] of [
      [CREATOR_ID, "spatchcreator"],
      [MEMBER_ID, "spatchmember"],
      [OUTSIDER_ID, "spatchoutsider"],
    ] as const) {
      await prisma.user.create({
        data: {
          discordId,
          username,
          displayName: username,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }

    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Patch Server" },
        { id: OTHER_SERVER_ID, name: "Other Server" },
      ],
    });
    await prisma.game.create({
      data: { id: GAME_ID, serverId: SERVER_ID, name: "Patch Game", gameKey: "spatch-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: GAME_ID,
        revision: 1,
        checksum: "spatch-rev-checksum",
        definition: { id: "spatch-game", name: "Patch Game", serverId: SERVER_ID },
      },
    });
    revisionId = rev.id;

    // A real second game and revision, so a write to them would succeed if allowed.
    await prisma.game.create({
      data: { id: OTHER_GAME_ID, serverId: SERVER_ID, name: "Other Game", gameKey: "spatch-game2", size: "medium" },
    });
    const otherRev = await prisma.gameRevision.create({
      data: {
        gameId: OTHER_GAME_ID,
        revision: 1,
        checksum: "spatch-rev2-checksum",
        definition: { id: "spatch-game2", name: "Other Game", serverId: SERVER_ID },
      },
    });
    otherRevisionId = otherRev.id;

    await prisma.gameSession.create({
      data: {
        id: SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: CREATOR_ID,
        name: "Patch Session",
        visibility: "shared",
        gameRevisionId: rev.id,
      },
    });
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: MEMBER_ID, role: "member", acceptedAt: new Date() },
    });

    await prisma.authSession.createMany({
      data: [
        { id: CREATOR_AUTH_ID, userId: CREATOR_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: MEMBER_AUTH_ID, userId: MEMBER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: OUTSIDER_AUTH_ID, userId: OUTSIDER_ID, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });

    app = await buildTestApp();
    creatorCookie = `session=${app.signCookie(CREATOR_AUTH_ID)}`;
    memberCookie = `session=${app.signCookie(MEMBER_AUTH_ID)}`;
    outsiderCookie = `session=${app.signCookie(OUTSIDER_AUTH_ID)}`;
  });

  // Every test starts from the same session row, so one failure can't cascade.
  beforeEach(async () => {
    await prisma.event.deleteMany({ where: { sessionId: SESSION_ID } });
    await prisma.gameSession.update({
      where: { id: SESSION_ID },
      data: {
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: CREATOR_ID,
        name: "Patch Session",
        visibility: "shared",
        hiderLat: null,
        hiderLng: null,
        planningModeEnabled: false,
        disabledZoneIds: [],
        gameRevisionId: revisionId,
        eventSequence: 0,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  function patch(cookie: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}`,
      headers: { cookie },
      payload,
    });
  }

  async function loadSession() {
    return prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
  }

  test("a member cannot take over the session by sending creatorId", async () => {
    const res = await patch(memberCookie, { creatorId: MEMBER_ID, hiderLat: 1, hiderLng: 2 });
    // Unknown fields are dropped, not rejected, so the allowed part still applies.
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.creatorId).toBe(CREATOR_ID);
    expect(s.hiderLat).toBe(1);
    expect(s.hiderLng).toBe(2);
  });

  test("a member cannot move the session to another server", async () => {
    const res = await patch(memberCookie, { serverId: OTHER_SERVER_ID });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).serverId).toBe(SERVER_ID);
  });

  test("a member cannot repoint the session at another game or revision", async () => {
    const res = await patch(memberCookie, { gameId: OTHER_GAME_ID, gameRevisionId: otherRevisionId });
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.gameId).toBe(GAME_ID);
    expect(s.gameRevisionId).toBe(revisionId);
  });

  test("a member cannot rewind the event sequence", async () => {
    await patch(memberCookie, { hiderLat: 10, hiderLng: 20 });
    const before = (await loadSession()).eventSequence;
    expect(before).toBeGreaterThan(0);

    const res = await patch(memberCookie, { eventSequence: 0 });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).eventSequence).toBe(before);
  });

  test("the creator cannot write unlisted fields either", async () => {
    const res = await patch(creatorCookie, { creatorId: MEMBER_ID, serverId: OTHER_SERVER_ID });
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.creatorId).toBe(CREATOR_ID);
    expect(s.serverId).toBe(SERVER_ID);
  });

  test("a member cannot change the name", async () => {
    const res = await patch(memberCookie, { name: "Hijacked" });
    expect(res.statusCode).toBe(403);
    expect((await loadSession()).name).toBe("Patch Session");
  });

  test("a member cannot change the visibility", async () => {
    const res = await patch(memberCookie, { visibility: "private" });
    expect(res.statusCode).toBe(403);
    expect((await loadSession()).visibility).toBe("shared");
  });

  test("a member can still update the hider position and planning mode", async () => {
    const res = await patch(memberCookie, { hiderLat: 47.1, hiderLng: 8.5, planningModeEnabled: true });
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.hiderLat).toBe(47.1);
    expect(s.hiderLng).toBe(8.5);
    expect(s.planningModeEnabled).toBe(true);
  });

  test("clearing the hider position stores null, not 0", async () => {
    await patch(memberCookie, { hiderLat: 47.1, hiderLng: 8.5 });
    const res = await patch(memberCookie, { hiderLat: null, hiderLng: null });
    expect(res.statusCode).toBe(200);
    const s = await loadSession();
    expect(s.hiderLat).toBeNull();
    expect(s.hiderLng).toBeNull();
  });

  test("a hider position on the equator or the prime meridian stays 0", async () => {
    const res = await patch(memberCookie, { hiderLat: 0, hiderLng: -0.1 });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).hiderLat).toBe(0);
    await patch(memberCookie, { hiderLat: 51.5, hiderLng: 0 });
    expect((await loadSession()).hiderLng).toBe(0);
  });

  test("a hider position must be a number or null", async () => {
    const res = await patch(memberCookie, { hiderLat: [5], hiderLng: 1 });
    expect(res.statusCode).toBe(400);
  });

  test("a member can disable zones, stored deduplicated and sorted", async () => {
    const res = await patch(memberCookie, { disableZoneIds: ["zurich-hb", "bern", "zurich-hb"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().disabledZoneIds).toEqual(["bern", "zurich-hb"]);
    expect((await loadSession()).disabledZoneIds).toEqual(["bern", "zurich-hb"]);

    const get = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}`,
      headers: { cookie: creatorCookie },
    });
    expect(get.json().disabledZoneIds).toEqual(["bern", "zurich-hb"]);

    const list = await app.inject({
      method: "GET",
      url: `/sessions?serverId=${SERVER_ID}`,
      headers: { cookie: creatorCookie },
    });
    const listed = list.json().sessions.find((x: { id: string }) => x.id === SESSION_ID);
    expect(listed.disabledZoneIds).toEqual(["bern", "zurich-hb"]);
  });

  test("disabling and enabling are applied to the stored zones", async () => {
    await patch(memberCookie, { disableZoneIds: ["a", "b"] });
    await patch(creatorCookie, { disableZoneIds: ["c"] });
    const res = await patch(memberCookie, { enableZoneIds: ["a"] });
    expect(res.json().disabledZoneIds).toEqual(["b", "c"]);
    expect((await loadSession()).disabledZoneIds).toEqual(["b", "c"]);
  });

  test("each change records a zones.disabled event with the whole list", async () => {
    await patch(memberCookie, { disableZoneIds: ["b", "a"] });
    await patch(creatorCookie, { enableZoneIds: ["a"] });
    const events = await prisma.event.findMany({
      where: { sessionId: SESSION_ID },
      orderBy: { sequence: "asc" },
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "zones.disabled",
      userId: MEMBER_ID,
      sequence: 1,
      payloadJson: { disabledZoneIds: ["a", "b"] },
    });
    expect(events[0].clientUuid).toMatch(/^zones-disabled-/);
    expect(events[1]).toMatchObject({
      type: "zones.disabled",
      userId: CREATOR_ID,
      sequence: 2,
      payloadJson: { disabledZoneIds: ["b"] },
    });
    expect((await loadSession()).eventSequence).toBe(2);
  });

  test("disabling a disabled zone or enabling an enabled one is no change", async () => {
    await patch(memberCookie, { disableZoneIds: ["a"] });
    // A retry after a lost reply sends the same change again.
    const again = await patch(memberCookie, { disableZoneIds: ["a"] });
    expect(again.statusCode).toBe(200);
    expect(again.json().disabledZoneIds).toEqual(["a"]);
    const enableOther = await patch(creatorCookie, { enableZoneIds: ["b"], disableZoneIds: [] });
    expect(enableOther.statusCode).toBe(200);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(1);
    expect((await loadSession()).eventSequence).toBe(1);
  });

  test("players disabling different zones at once keep both", async () => {
    const results = await Promise.all([
      patch(memberCookie, { disableZoneIds: ["a"] }),
      patch(creatorCookie, { disableZoneIds: ["b"] }),
      patch(memberCookie, { disableZoneIds: ["c"] }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect((await loadSession()).disabledZoneIds).toEqual(["a", "b", "c"]);
    const events = await prisma.event.findMany({
      where: { sessionId: SESSION_ID },
      orderBy: { sequence: "asc" },
    });
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(events[2].payloadJson).toEqual({ disabledZoneIds: ["a", "b", "c"] });
  });

  test("one change can disable some zones and enable others", async () => {
    await patch(memberCookie, { disableZoneIds: ["a", "b"] });
    const res = await patch(memberCookie, { disableZoneIds: ["c"], enableZoneIds: ["a"] });
    expect(res.statusCode).toBe(200);
    expect(res.json().disabledZoneIds).toEqual(["b", "c"]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(2);
  });

  test("a zone both disabled and enabled in one change is rejected", async () => {
    await patch(memberCookie, { disableZoneIds: ["a"] });
    const res = await patch(memberCookie, { disableZoneIds: ["b", "c"], enableZoneIds: ["a", "c"] });
    expect(res.statusCode).toBe(400);
    expect((await loadSession()).disabledZoneIds).toEqual(["a"]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(1);
  });

  test("leaving out the zones keeps them", async () => {
    await patch(memberCookie, { disableZoneIds: ["a"] });
    await patch(memberCookie, { planningModeEnabled: true });
    expect((await loadSession()).disabledZoneIds).toEqual(["a"]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID, type: "zones.disabled" } })).toBe(1);
  });

  test("zone IDs up to 1000 characters are accepted", async () => {
    const long = "x".repeat(1000);
    const res = await patch(memberCookie, { disableZoneIds: [long] });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).disabledZoneIds).toEqual([long]);
  });

  test.each([
    ["an empty ID", { disableZoneIds: [""] }],
    ["an over-long ID", { disableZoneIds: ["x".repeat(1001)] }],
    ["an over-long ID to enable", { enableZoneIds: ["x".repeat(1001)] }],
    ["too many IDs", { disableZoneIds: Array.from({ length: 5001 }, (_, i) => `zone-${i}`) }],
    ["an object", { disableZoneIds: [{ id: "a" }] }],
    ["null", { disableZoneIds: null }],
    ["null to enable", { enableZoneIds: null }],
  ])("zones with %s are rejected", async (_label, payload) => {
    const res = await patch(memberCookie, payload);
    expect(res.statusCode).toBe(400);
    expect((await loadSession()).disabledZoneIds).toEqual([]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(0);
  });

  test("the session's disabled zones are capped", async () => {
    const first = Array.from({ length: 5000 }, (_, i) => `zone-${i}`);
    expect((await patch(memberCookie, { disableZoneIds: first })).statusCode).toBe(200);
    const res = await patch(memberCookie, { disableZoneIds: ["one-more"] });
    expect(res.statusCode).toBe(400);
    expect((await loadSession()).disabledZoneIds).toHaveLength(5000);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(1);
  });

  test("someone outside the session can't change its zones", async () => {
    const res = await patch(outsiderCookie, { disableZoneIds: ["a"] });
    expect(res.statusCode).toBe(403);
    expect((await loadSession()).disabledZoneIds).toEqual([]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(0);
  });

  test("a removed member can't change the zones", async () => {
    await prisma.sessionParticipant.update({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: MEMBER_ID } },
      data: { revokedAt: new Date() },
    });
    try {
      const res = await patch(memberCookie, { disableZoneIds: ["a"] });
      expect(res.statusCode).toBe(403);
      expect((await loadSession()).disabledZoneIds).toEqual([]);
      expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(0);
    } finally {
      await prisma.sessionParticipant.update({
        where: { sessionId_userId: { sessionId: SESSION_ID, userId: MEMBER_ID } },
        data: { revokedAt: null },
      });
    }
  });

  test("the events replay returns zones.disabled with the whole list, as broadcast", async () => {
    await patch(memberCookie, { disableZoneIds: ["b", "a"], zonesClientUuid: "zones-disabled-replay" });
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}/events?after=0`,
      headers: { cookie: creatorCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toMatchObject([
      {
        sessionId: SESSION_ID,
        userId: MEMBER_ID,
        sequence: 1,
        type: "zones.disabled",
        payloadJson: { disabledZoneIds: ["a", "b"] },
        clientUuid: "zones-disabled-replay",
      },
    ]);
  });

  test("a change's ID becomes its event's clientUuid", async () => {
    await patch(memberCookie, { disableZoneIds: ["a"], zonesClientUuid: "zones-disabled-1234-abcd" });
    const event = await prisma.event.findFirstOrThrow({ where: { sessionId: SESSION_ID } });
    expect(event.clientUuid).toBe("zones-disabled-1234-abcd");
  });

  test("a resent change is not applied again", async () => {
    const change = { disableZoneIds: ["a"], zonesClientUuid: "zones-disabled-resent" };
    expect((await patch(memberCookie, change)).statusCode).toBe(200);
    // Another player enables it before the resend (e.g. after a lost reply).
    await patch(creatorCookie, { enableZoneIds: ["a"] });
    const resend = await patch(memberCookie, change);
    expect(resend.statusCode).toBe(200);
    expect(resend.json().disabledZoneIds).toEqual([]);
    expect((await loadSession()).disabledZoneIds).toEqual([]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(2);
    expect((await loadSession()).eventSequence).toBe(2);
  });

  test("a change with an ID is recorded once even when it changes nothing", async () => {
    await patch(creatorCookie, { disableZoneIds: ["a"] });
    // Disabled by another player first: still recorded, for the app to see
    // come back and to recognise a resend.
    const change = { disableZoneIds: ["a"], zonesClientUuid: "zones-disabled-late" };
    await patch(memberCookie, change);
    const late = await prisma.event.findUniqueOrThrow({ where: { clientUuid: "zones-disabled-late" } });
    expect(late).toMatchObject({ sequence: 2, payloadJson: { disabledZoneIds: ["a"] } });
    // Enabled again, then the resend after a lost reply: not applied.
    await patch(creatorCookie, { enableZoneIds: ["a"] });
    await patch(memberCookie, change);
    expect((await loadSession()).disabledZoneIds).toEqual([]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(3);
  });

  test("the same change sent twice at once is applied once", async () => {
    const change = { disableZoneIds: ["a"], zonesClientUuid: "zones-disabled-twice" };
    const results = await Promise.all([patch(memberCookie, change), patch(memberCookie, change)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(1);
  });

  test("a change ID another kind of event has is refused", async () => {
    await prisma.event.create({
      data: {
        sessionId: SESSION_ID,
        userId: CREATOR_ID,
        sequence: 99,
        type: "hider.update",
        payloadJson: {},
        clientUuid: "zones-disabled-taken",
        clientCreatedAt: new Date(),
      },
    });
    const res = await patch(memberCookie, { disableZoneIds: ["a"], zonesClientUuid: "zones-disabled-taken" });
    expect(res.statusCode).toBe(409);
    expect((await loadSession()).disabledZoneIds).toEqual([]);
  });

  test.each([
    ["no prefix", "abc"],
    ["another prefix", "questions-replace-abc"],
    ["an over-long ID", `zones-disabled-${"a".repeat(101)}`],
    ["odd characters", "zones-disabled-a/b"],
  ])("a change ID with %s is refused", async (_label, zonesClientUuid) => {
    const res = await patch(memberCookie, { disableZoneIds: ["a"], zonesClientUuid });
    expect(res.statusCode).toBe(400);
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(0);
  });

  test("the disabled zones' total size is capped", async () => {
    const ids = Array.from({ length: 199 }, (_, i) => `${i}`.padEnd(1000, "x"));
    expect((await patch(memberCookie, { disableZoneIds: ids })).statusCode).toBe(200);
    const res = await patch(memberCookie, { disableZoneIds: ["y".repeat(1000), "z".repeat(1000)] });
    expect(res.statusCode).toBe(400);
    expect((await loadSession()).disabledZoneIds).toHaveLength(199);
  });

  test("the creator can still rename the session", async () => {
    const res = await patch(creatorCookie, { name: "Renamed" });
    expect(res.statusCode).toBe(200);
    expect((await loadSession()).name).toBe("Renamed");
  });
});
