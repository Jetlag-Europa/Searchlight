import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { QuestionHistoryResponse } from "@searchlight/shared";
import prisma from "../lib/prisma.js";
import { sessionContentRoutes } from "./session-content.js";
import { pageByteBudget, pageStoredBudget, questionHistoryRoutes } from "./question-history.js";

const BUDGETS = { read: pageByteBudget.bytes, stored: pageStoredBudget.bytes };

// ── IDs scoped to this test suite ───────────────────────────────────────────
const USER1_ID = "test-qhist-user1"; // creator
const USER2_ID = "test-qhist-user2"; // participant, kicked in one test
const USER3_ID = "test-qhist-user3"; // never in the session
const SERVER_ID = "test-qhist-server";
const GAME_ID = "test-qhist-game";
const SESSION_ID = "test-qhist-session";
const AUTH1 = "test-qhist-auth1";
const AUTH2 = "test-qhist-auth2";
const AUTH3 = "test-qhist-auth3";
const USERS = [USER1_ID, USER2_ID, USER3_ID];

// Keys with 17 significant digits, as Math.random gives.
const K1 = 0.12345678901234567;
const K2 = 0.7654321098765432;
const K3 = 0.31415926535897931;

// The next double up: a key read back one ulp off and saved again.
const nextUp = (x: number) => {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + 1n);
  return view.getFloat64(0);
};

const radius = (key: number, data: Record<string, unknown> = {}) => ({
  id: "radius",
  key,
  data: { lat: 52.37, lng: 4.89, radius: 2, unit: "kilometers", within: true, drag: true, collapsed: false, ...data },
});

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionContentRoutes, { prefix: "/sessions" });
  await app.register(questionHistoryRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

async function cleanUp() {
  await prisma.event.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.sessionQuestion.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION_ID } });
  await prisma.authSession.deleteMany({ where: { id: { in: [AUTH1, AUTH2, AUTH3] } } });
  await prisma.gameSession.deleteMany({ where: { id: SESSION_ID } });
  await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
  await prisma.game.deleteMany({ where: { id: GAME_ID } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
}

describe("GET /sessions/:sessionId/questions/history", () => {
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  // Stores a save of the list, as PUT /questions does: one questions.replace
  // event. Written as JSON text so the stored doubles are exactly these (the
  // Prisma write path can store a 17-digit key one ulp off).
  async function save(userId: string, questions: unknown[]) {
    return insertReplace(
      userId,
      JSON.stringify({
        replacementId: randomUUID(),
        questions: questions.map((payloadJson, ordinal) => ({ clientUuid: randomUUID(), ordinal, payloadJson })),
      }),
    );
  }

  // A questions.replace event with this payload text; its sequence.
  async function insertReplace(userId: string, payload: string): Promise<number> {
    const { eventSequence } = await prisma.gameSession.update({
      where: { id: SESSION_ID },
      data: { eventSequence: { increment: 1 } },
      select: { eventSequence: true },
    });
    await prisma.$executeRaw`
      INSERT INTO "Event" ("id", "sessionId", "userId", "sequence", "type", "payloadJson", "clientUuid", "clientCreatedAt")
      VALUES (${randomUUID()}, ${SESSION_ID}, ${userId}, ${eventSequence}, 'questions.replace', ${payload}::jsonb,
              ${`questions-replace-${randomUUID()}`}, NOW())
    `;
    return eventSequence;
  }

  async function history(query = "", userId = USER1_ID) {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION_ID}/questions/history${query}`,
      headers: { cookie: cookies[userId] },
    });
    return res;
  }

  async function entries(query = "") {
    const res = await history(query);
    expect(res.statusCode).toBe(200);
    return res.json<QuestionHistoryResponse>();
  }

  beforeAll(async () => {
    await cleanUp();
    await prisma.user.createMany({
      data: USERS.map((discordId, i) => ({
        discordId,
        username: `qhist${i + 1}`,
        displayName: `History User ${i + 1}`,
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      })),
    });
    await prisma.server.create({ data: { id: SERVER_ID, name: "History Server" } });
    await prisma.game.create({
      data: { id: GAME_ID, serverId: SERVER_ID, name: "History Game", gameKey: "qhist-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: GAME_ID,
        revision: 1,
        checksum: "test-qhist-checksum",
        definition: { id: "qhist-game", name: "History Game", serverId: SERVER_ID },
      },
    });
    await prisma.gameSession.create({
      data: {
        id: SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: USER1_ID,
        name: "History Session",
        gameRevisionId: rev.id,
      },
    });
    await prisma.authSession.createMany({
      data: [
        { id: AUTH1, userId: USER1_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH2, userId: USER2_ID, expiresAt: new Date(Date.now() + 86_400_000) },
        { id: AUTH3, userId: USER3_ID, expiresAt: new Date(Date.now() + 86_400_000) },
      ],
    });
    app = await buildTestApp();
    cookies[USER1_ID] = `session=${app.signCookie(AUTH1)}`;
    cookies[USER2_ID] = `session=${app.signCookie(AUTH2)}`;
    cookies[USER3_ID] = `session=${app.signCookie(AUTH3)}`;
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({ where: { sessionId: SESSION_ID } });
    await prisma.sessionQuestion.deleteMany({ where: { sessionId: SESSION_ID } });
    await prisma.sessionParticipant.deleteMany({ where: { sessionId: SESSION_ID } });
    await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { eventSequence: 0 } });
    pageByteBudget.bytes = BUDGETS.read;
    pageStoredBudget.bytes = BUDGETS.stored;
  });

  afterAll(async () => {
    await app.close();
    await cleanUp();
    await prisma.$disconnect();
  });

  test("401 without a cookie, 404 for an unknown session, 403 for a stranger", async () => {
    const anonymous = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/questions/history` });
    expect(anonymous.statusCode).toBe(401);

    const unknown = await app.inject({
      method: "GET",
      url: `/sessions/no-such-session/questions/history`,
      headers: { cookie: cookies[USER1_ID] },
    });
    expect(unknown.statusCode).toBe(404);

    expect((await history("", USER3_ID)).statusCode).toBe(403);
  });

  test("403 for a player whose invite isn't accepted yet", async () => {
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: USER2_ID, role: "member", acceptedAt: null },
    });
    expect((await history("", USER2_ID)).statusCode).toBe(403);
  });

  test("a spectator can read it too", async () => {
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: USER2_ID, role: "viewer", acceptedAt: new Date() },
    });
    await save(USER1_ID, [radius(K1)]);
    const res = await history("", USER2_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json<QuestionHistoryResponse>().entries).toHaveLength(1);
  });

  test("a deleted question in full for a player, only what it was for a spectator", async () => {
    await prisma.sessionParticipant.createMany({
      data: [
        { sessionId: SESSION_ID, userId: USER2_ID, role: "viewer", acceptedAt: new Date() },
        { sessionId: SESSION_ID, userId: USER3_ID, role: "member", acceptedAt: new Date() },
      ],
    });
    const zone = { id: "matching", key: K2, data: { type: "custom-zone", name: "Park", geo: { type: "Point", coordinates: [4, 52] } } };
    await save(USER1_ID, [radius(K1), zone]);
    await save(USER1_ID, [radius(K1)]);

    const removal = async (userId: string) => {
      const res = await history("", userId);
      expect(res.statusCode).toBe(200);
      return res.json<QuestionHistoryResponse>().entries[0].changes[0];
    };
    expect(await removal(USER3_ID)).toEqual({ kind: "removed", key: K2, id: "matching", index: 1, typeIndex: 1, question: zone });
    expect(await removal(USER2_ID)).toEqual({
      kind: "removed",
      key: K2,
      id: "matching",
      index: 1,
      typeIndex: 1,
      before: { type: "custom-zone", name: "Park", geo: { omitted: true } },
    });
  });

  test("a participant gets the changes newest first, with names and times", async () => {
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: USER2_ID, role: "member", acceptedAt: new Date() },
    });
    await save(USER1_ID, [radius(K1)]);
    await save(USER2_ID, [radius(K1, { within: false })]);

    const res = await history("", USER2_ID);
    expect(res.statusCode).toBe(200);
    const body = res.json<QuestionHistoryResponse>();
    expect(body.nextBefore).toBeNull();
    expect(body.entries).toHaveLength(2);

    const [answered, added] = body.entries;
    expect(answered.sequence).toBeGreaterThan(added.sequence);
    expect(answered).toMatchObject({ userId: USER2_ID, displayName: "History User 2" });
    expect(answered.changes).toEqual([
      expect.objectContaining({ kind: "changed", key: K1, id: "radius", index: 0, typeIndex: 1, fields: ["within"] }),
    ]);
    expect(added).toMatchObject({ userId: USER1_ID, displayName: "History User 1" });
    expect(added.changes).toEqual([expect.objectContaining({ kind: "added", key: K1 })]);
    expect(Number.isNaN(Date.parse(added.at))).toBe(false);
    expect(Math.abs(Date.parse(added.at) - Date.now())).toBeLessThan(60_000);
  });

  test("skips saves that only fold a card", async () => {
    await save(USER1_ID, [radius(K1)]);
    await save(USER1_ID, [radius(K1, { collapsed: true })]);
    await save(USER1_ID, [radius(K1, { collapsed: false })]);
    const body = await entries();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].changes[0].kind).toBe("added");
  });

  test("a removal carries the full question and the order before it", async () => {
    const geo = { type: "FeatureCollection", features: [{ type: "Feature", geometry: null, properties: { n: 1 } }] };
    const zone = { id: "matching", key: K2, data: { type: "custom-zone", geo, same: true, lat: 1, lng: 2 } };
    await save(USER1_ID, [radius(K1), zone, radius(K3)]);
    await save(USER1_ID, [radius(K1), radius(K3)]);

    const [removal, added] = (await entries()).entries;
    expect(removal.changes).toEqual([
      { kind: "removed", key: K2, id: "matching", index: 1, typeIndex: 1, question: zone },
    ]);
    expect(removal.order).toEqual([K1, K2, K3]);
    // The add shows the zone without its geometry.
    const addedZone = added.changes.find((c) => c.key === K2);
    expect(addedZone?.after).toMatchObject({ geo: { omitted: true } });
  });

  test("pages with before, comparing across the page boundary", async () => {
    await save(USER1_ID, [radius(K1)]);
    await save(USER1_ID, [radius(K1, { radius: 3 })]);
    await save(USER1_ID, [radius(K1, { radius: 3 }), radius(K2)]);
    await save(USER1_ID, [radius(K1, { radius: 4 }), radius(K2)]);

    const first = await entries("?limit=2");
    expect(first.entries.map((e) => e.changes.map((c) => c.kind))).toEqual([["changed"], ["added"]]);
    expect(first.nextBefore).toBe(first.entries[1].sequence);

    const second = await entries(`?limit=2&before=${first.nextBefore}`);
    // The radius change is compared with the save before it, not with nothing.
    expect(second.entries.map((e) => e.changes[0])).toEqual([
      expect.objectContaining({ kind: "changed", key: K1, fields: ["radius"] }),
      expect.objectContaining({ kind: "added", key: K1 }),
    ]);
    expect(second.nextBefore).toBeNull();
  });

  test("stops a page early once its snapshots get large", async () => {
    await save(USER1_ID, [radius(K1)]);
    await save(USER1_ID, [radius(K1, { radius: 3 })]);
    await save(USER1_ID, [radius(K1, { radius: 4 })]);
    pageByteBudget.bytes = 1;

    const first = await entries();
    expect(first.entries).toHaveLength(1);
    expect(first.entries[0].changes[0]).toMatchObject({ kind: "changed", fields: ["radius"] });
    expect(first.nextBefore).toBe(first.entries[0].sequence);

    const second = await entries(`?before=${first.nextBefore}`);
    expect(second.entries[0].changes[0]).toMatchObject({ kind: "changed", fields: ["radius"] });
  });

  test("stops a page early once the saves are large as stored", async () => {
    await save(USER1_ID, [radius(K1)]);
    await save(USER1_ID, [radius(K1, { radius: 3 })]);
    await save(USER1_ID, [radius(K1, { radius: 4 })]);
    pageStoredBudget.bytes = 1;

    const first = await entries();
    expect(first.entries.map((e) => e.changes[0].fields)).toEqual([["radius"]]);
    const second = await entries(`?before=${first.nextBefore}`);
    expect(second.entries.map((e) => e.changes[0].fields)).toEqual([["radius"]]);
    const third = await entries(`?before=${second.nextBefore}`);
    expect(third.entries.map((e) => e.changes[0].kind)).toEqual(["added"]);
    expect(third.nextBefore).toBeNull();
  });

  test("a removal reads the question at its place, whatever the entry holds", async () => {
    const zone = { id: "matching", key: K2, data: { type: "custom-zone", geo: { type: "Point", coordinates: [4, 52] } } };
    const entry = (payloadJson: unknown, ordinal: number, extra = {}) => ({
      clientUuid: randomUUID(),
      ordinal,
      payloadJson,
      ...extra,
    });
    // An entry stored with an "index" of its own.
    await insertReplace(
      USER1_ID,
      JSON.stringify({ replacementId: "a", questions: [entry(radius(K1), 0), entry(zone, 1, { index: 7 })] }),
    );
    await save(USER1_ID, [radius(K1)]);

    const [removal] = (await entries()).entries;
    expect(removal.changes).toEqual([{ kind: "removed", key: K2, id: "matching", index: 1, typeIndex: 1, question: zone }]);
  });

  test("a kicked player's changes keep their name", async () => {
    await prisma.sessionParticipant.create({
      data: { sessionId: SESSION_ID, userId: USER2_ID, role: "member", acceptedAt: new Date() },
    });
    await save(USER2_ID, [radius(K1)]);
    await prisma.sessionParticipant.update({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: USER2_ID } },
      data: { revokedAt: new Date() },
    });

    expect((await history("", USER2_ID)).statusCode).toBe(403);
    const [entry] = (await entries()).entries;
    expect(entry).toMatchObject({ userId: USER2_ID, displayName: "History User 2" });
  });

  test("never shows hider positions or other events", async () => {
    await save(USER1_ID, [radius(K1)]);
    const session = await prisma.gameSession.update({
      where: { id: SESSION_ID },
      data: { eventSequence: { increment: 2 } },
    });
    await prisma.event.createMany({
      data: [
        {
          sessionId: SESSION_ID,
          userId: USER1_ID,
          sequence: session.eventSequence - 1,
          type: "hider.update",
          payloadJson: { hiderLat: 48.858370123, hiderLng: 2.294481456 },
          clientUuid: `qhist-hider-${randomUUID()}`,
          clientCreatedAt: new Date(),
        },
        {
          sessionId: SESSION_ID,
          userId: USER1_ID,
          sequence: session.eventSequence,
          type: "stroke.create",
          payloadJson: { questions: [radius(K3)] },
          clientUuid: `qhist-stroke-${randomUUID()}`,
          clientCreatedAt: new Date(),
        },
      ],
    });
    await save(USER1_ID, [radius(K1), radius(K2)]);

    const res = await history();
    expect(res.body).not.toContain("48.85837");
    expect(res.body).not.toContain("2.29448");
    expect(res.body).not.toContain("hider");
    const body = res.json<QuestionHistoryResponse>();
    expect(body.entries).toHaveLength(2);
    expect(body.entries.flatMap((e) => e.changes.map((c) => c.key))).toEqual([K2, K1]);
  });

  test("a key saved one ulp off is not a delete and an add", async () => {
    await save(USER1_ID, [radius(K1), radius(K2)]);
    await save(USER1_ID, [radius(nextUp(K1)), radius(K2)]);
    await save(USER1_ID, [radius(nextUp(K1), { within: false }), radius(K2)]);

    const body = await entries();
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0].changes).toEqual([
      expect.objectContaining({ kind: "changed", key: nextUp(K1), fields: ["within"] }),
    ]);
    // Keys come back exactly as stored.
    expect(body.entries[1].changes.map((c) => c.key)).toEqual([K1, K2]);
  });
  test("reads what PUT /questions stores", async () => {
    const put = async (questions: unknown[]) => {
      const res = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie: cookies[USER1_ID] },
        payload: {
          replacementId: randomUUID(),
          questions: questions.map((payloadJson, ordinal) => ({ clientUuid: randomUUID(), ordinal, payloadJson })),
        },
      });
      expect(res.statusCode).toBe(204);
    };
    // Short keys: the Prisma write path can store a 17-digit one an ulp off.
    await put([radius(0.5), radius(0.25)]);
    await put([radius(0.25), radius(0.5, { within: false })]);
    await put([radius(0.5, { within: false })]);

    const body = await entries();
    expect(body.entries.map((e) => e.changes.map((c) => [c.kind, c.key]))).toEqual([
      [["removed", 0.25]],
      [["changed", 0.5]],
      [
        ["added", 0.5],
        ["added", 0.25],
      ],
    ]);
    expect(body.entries[1].reordered).toBe(true);
    expect(body.entries[1].changes[0].fields).toEqual(["within"]);
    expect(body.entries[0].order).toEqual([0.25, 0.5]);
  });

  test("skips a malformed save, comparing the next with the last good one", async () => {
    await save(USER1_ID, [radius(K1)]);
    await insertReplace(USER1_ID, JSON.stringify({ replacementId: "x", questions: "not a list" }));
    await save(USER1_ID, [radius(K1, { within: false })]);

    const body = await entries();
    expect(body.entries.map((e) => e.changes.map((c) => c.kind))).toEqual([["changed"], ["added"]]);
  });

  test("after= gives only the saves since, compared with the one before", async () => {
    await save(USER1_ID, [radius(K1)]);
    const first = await entries();
    expect(first.newest).toBe(first.entries[0].sequence);

    // Nothing new.
    expect(await entries(`?after=${first.newest}`)).toEqual({ entries: [], nextBefore: null, newest: null });

    // A fold changes nothing, but moves the cursor on.
    const fold = await save(USER1_ID, [radius(K1, { collapsed: true })]);
    expect(await entries(`?after=${first.newest}`)).toEqual({ entries: [], nextBefore: null, newest: fold });

    await save(USER1_ID, [radius(K1, { collapsed: true, within: false })]);
    const last = await save(USER1_ID, [radius(K1, { collapsed: true, within: false }), radius(K2)]);
    const since = await entries(`?after=${fold}`);
    expect(since.newest).toBe(last);
    expect(since.entries.map((e) => e.changes.map((c) => [c.kind, c.key]))).toEqual([
      [["added", K2]],
      [["changed", K1]],
    ]);

    // The default page reports the newest save, even a fold.
    const latestFold = await save(USER1_ID, [radius(K1, { within: false }), radius(K2)]);
    expect((await entries()).newest).toBe(latestFold);
  });

  test("after= says when more came since than one response holds", async () => {
    const start = await save(USER1_ID, [radius(K1)]);
    await save(USER1_ID, [radius(K1, { radius: 3 })]);
    await save(USER1_ID, [radius(K1, { radius: 4 })]);
    expect(await entries(`?after=${start}&limit=1`)).toEqual({ entries: [], nextBefore: null, newest: null, more: true });
    expect((await entries(`?after=${start}&limit=2`)).entries).toHaveLength(2);

    pageByteBudget.bytes = 1;
    expect((await entries(`?after=${start}`)).more).toBe(true);
    pageByteBudget.bytes = BUDGETS.read;
    pageStoredBudget.bytes = 1;
    expect((await entries(`?after=${start}`)).more).toBe(true);
  });

  test("400 for before and after together", async () => {
    expect((await history("?before=5&after=2")).statusCode).toBe(400);
  });

  describe("with a large custom zone", () => {
    // A matching question copied into a custom zone: the whole boundary, in
    // every save. Coordinates with 17 digits, as computed ones have.
    const boundary = Array.from({ length: 5000 }, (_, i) => {
      const angle = (i / 5000) * 2 * Math.PI;
      return [4.89 + 0.1 * Math.cos(angle) + i * 1e-9 + 1 / 3e7, 52.37 + 0.1 * Math.sin(angle) + 1 / 7e7];
    });
    const zoneWith = (ring: number[][], key = K2) => ({
      id: "matching",
      key,
      data: {
        type: "custom-zone",
        same: true,
        geo: {
          type: "FeatureCollection",
          features: [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } }],
        },
      },
    });
    const zone = zoneWith([...boundary, boundary[0]]);

    test("doesn't shrink a page to a few saves", async () => {
      for (let i = 0; i < 60; i++) {
        await save(USER1_ID, [zone, radius(K1, { radius: i + 1 })]);
      }
      const body = await entries();
      expect(body.entries).toHaveLength(60);
      expect(body.nextBefore).toBeNull();
      expect(body.entries[0].changes).toEqual([
        expect.objectContaining({ kind: "changed", key: K1, fields: ["radius"] }),
      ]);
      // The add still shows the zone without its geometry.
      expect(body.entries[59].changes.find((c) => c.key === K2)?.after).toMatchObject({
        geo: { omitted: true },
      });
    });

    test("reports an area change", async () => {
      const moved = zoneWith([[4.5, 52.5], ...boundary.slice(1), [4.5, 52.5]]);
      await save(USER1_ID, [zone, radius(K1)]);
      await save(USER1_ID, [moved, radius(K1)]);

      const body = await entries();
      expect(body.entries.map((e) => e.changes.map((c) => [c.kind, c.key, c.fields]))).toEqual([
        [["changed", K2, ["geo"]]],
        [
          ["added", K2, undefined],
          ["added", K1, undefined],
        ],
      ]);
      expect(body.entries[0].changes[0]).toMatchObject({ before: { geo: { omitted: true } }, after: { geo: { omitted: true } } });
    });

    test("a removed zone carries its whole boundary, to put back", async () => {
      await save(USER1_ID, [radius(K1), zone, radius(K3)]);
      await save(USER1_ID, [radius(K1), zone, radius(K3, { within: false })]);
      await save(USER1_ID, [radius(K1), radius(K3, { within: false })]);

      const [removal] = (await entries()).entries;
      expect(removal.changes).toEqual([
        { kind: "removed", key: K2, id: "matching", index: 1, typeIndex: 1, question: zone },
      ]);
      expect(removal.order).toEqual([K1, K2, K3]);
    });

    test("after= with a dozen saves since answers them, not more", async () => {
      // The whole lists would pass the byte budget after ten.
      const start = await save(USER1_ID, [zone, radius(K1)]);
      for (let i = 0; i < 12; i++) {
        await save(USER1_ID, [zone, radius(K1, { radius: i + 3 })]);
      }
      const since = await entries(`?after=${start}`);
      expect(since.more).toBeUndefined();
      expect(since.entries).toHaveLength(12);
    });
  });
});
