import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { sessionContentRoutes } from "./session-content.js";
import { sessionRoutes } from "./sessions.js";
import { subscribe } from "../lib/broadcaster.js";
import type { EventRecord } from "@searchlight/shared";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const USER_ID = "test-scontent-user";
const SERVER_ID = "test-scontent-server";
const GAME_ID = "test-scontent-game";
const SESSION_ID = "test-scontent-session";
const SESSION2_ID = "test-scontent-session2";
const AUTH_SESSION_ID = "test-scontent-auth";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionContentRoutes, { prefix: "/sessions" });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.ready();
  return app;
}

describe("session-content mutations: atomicity, durability, and idempotency", () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    // Clean up
    await prisma.event.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.stroke.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.sessionQuestion.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.gameSession.deleteMany({ where: { id: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
    await prisma.game.deleteMany({ where: { id: GAME_ID } });
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });

    // Fixtures
    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "contentuser",
        displayName: "Content User",
        avatarUrl: "https://example.com/c.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await prisma.server.create({ data: { id: SERVER_ID, name: "Content Server" } });
    // Upgrading a session requires access to the game's server.
    await prisma.serverMembershipCache.create({
      data: { userId: USER_ID, serverId: SERVER_ID, isMember: true, roles: [], cachedAt: new Date() },
    });

    const game = await prisma.game.create({
      data: {
        id: GAME_ID,
        serverId: SERVER_ID,
        name: "Content Game",
        gameKey: "content-game",
        size: "medium",
      },
    });

    const rev = await prisma.gameRevision.create({
      data: {
        gameId: game.id,
        revision: 1,
        checksum: "content-rev-checksum",
        definition: {
          id: "content-game",
          name: "Content Game",
          serverId: SERVER_ID,
        },
      },
    });

    await prisma.game.update({
      where: { id: game.id },
      data: { currentRevisionId: rev.id },
    });

    await prisma.gameSession.createMany({
      data: [
        {
          id: SESSION_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER_ID,
          name: "Content Session 1",
          gameRevisionId: rev.id,
        },
        {
          id: SESSION2_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER_ID,
          name: "Content Session 2",
          gameRevisionId: rev.id,
        },
      ],
    });

    await prisma.authSession.create({
      data: {
        id: AUTH_SESSION_ID,
        userId: USER_ID,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    app = await buildTestApp();
    cookie = `session=${app.signCookie(AUTH_SESSION_ID)}`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.event.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.stroke.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.sessionQuestion.deleteMany({ where: { sessionId: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.authSession.deleteMany({ where: { id: AUTH_SESSION_ID } });
    await prisma.gameSession.deleteMany({ where: { id: { in: [SESSION_ID, SESSION2_ID] } } });
    await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
    await prisma.game.deleteMany({ where: { id: GAME_ID } });
    await prisma.serverMembershipCache.deleteMany({ where: { userId: USER_ID } });
    await prisma.server.deleteMany({ where: { id: SERVER_ID } });
    await prisma.user.deleteMany({ where: { discordId: USER_ID } });
    await prisma.$disconnect();
  });

  // ── Stroke Create ──────────────────────────────────────────────────────────
  describe("POST /sessions/:sessionId/strokes", () => {
    test("creates stroke and durable event atomically, broadcasts once, idempotent retry does not rebroadcast", async () => {
      const strokeClientUuid = "stroke-test-atomic-1";
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && ev.type === "stroke.create") {
          broadcasted.push(ev as EventRecord);
        }
      });

      try {
        // Initial creation
        const res1 = await app.inject({
          method: "POST",
          url: `/sessions/${SESSION_ID}/strokes`,
          headers: { cookie },
          payload: {
            clientUuid: strokeClientUuid,
            payloadJson: { points: [1, 2, 3] },
          },
        });

        expect(res1.statusCode).toBe(201);
        const stroke1 = res1.json<{ id: string; clientUuid: string }>();
        expect(stroke1.clientUuid).toBe(strokeClientUuid);

        // Durable stroke and event in database
        const strokeInDb = await prisma.stroke.findUnique({ where: { clientUuid: strokeClientUuid } });
        expect(strokeInDb).not.toBeNull();
        expect(strokeInDb?.sessionId).toBe(SESSION_ID);

        const eventInDb = await prisma.event.findUnique({ where: { clientUuid: `stroke-create-${strokeClientUuid}` } });
        expect(eventInDb).not.toBeNull();
        expect(eventInDb?.type).toBe("stroke.create");
        expect(eventInDb?.sessionId).toBe(SESSION_ID);

        // Broadcasted exactly once
        expect(broadcasted).toHaveLength(1);
        expect(broadcasted[0].clientUuid).toBe(`stroke-create-${strokeClientUuid}`);

        // Idempotent retry: same clientUuid
        const res2 = await app.inject({
          method: "POST",
          url: `/sessions/${SESSION_ID}/strokes`,
          headers: { cookie },
          payload: {
            clientUuid: strokeClientUuid,
            payloadJson: { points: [1, 2, 3] },
          },
        });

        expect(res2.statusCode).toBe(201);
        const stroke2 = res2.json<{ id: string; clientUuid: string }>();
        expect(stroke2.id).toBe(stroke1.id);

        // Events count in DB must still be 1
        const eventCount = await prisma.event.count({
          where: { clientUuid: `stroke-create-${strokeClientUuid}` },
        });
        expect(eventCount).toBe(1);

        // Must NOT have rebroadcast
        expect(broadcasted).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });

    test("rejects 409 conflict when clientUuid already exists in another session without leaking payload", async () => {
      const foreignUuid = "stroke-foreign-session";
      await prisma.stroke.create({
        data: {
          sessionId: SESSION2_ID,
          userId: USER_ID,
          clientUuid: foreignUuid,
          payloadJson: { secret: "do-not-leak" },
        },
      });

      const res = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/strokes`,
        headers: { cookie },
        payload: {
          clientUuid: foreignUuid,
          payloadJson: { points: [9, 9, 9] },
        },
      });

      expect(res.statusCode).toBe(409);
      expect(res.body).not.toContain("do-not-leak");
    });
  });

  // ── Stroke Delete ──────────────────────────────────────────────────────────
  describe("DELETE /sessions/:sessionId/strokes/:clientUuid", () => {
    test("soft-deletes stroke and creates durable event, broadcasts once, idempotent retry does not rebroadcast", async () => {
      const strokeClientUuid = "stroke-test-atomic-del";

      // Seed active stroke
      await prisma.stroke.create({
        data: {
          sessionId: SESSION_ID,
          userId: USER_ID,
          payloadJson: { points: [4, 5, 6] },
          clientUuid: strokeClientUuid,
        },
      });

      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && ev.type === "stroke.delete") {
          broadcasted.push(ev as EventRecord);
        }
      });

      try {
        // Initial delete
        const res1 = await app.inject({
          method: "DELETE",
          url: `/sessions/${SESSION_ID}/strokes/${strokeClientUuid}`,
          headers: { cookie },
        });

        expect(res1.statusCode).toBe(204);

        // Verify stroke is soft-deleted and event exists durably
        const strokeInDb = await prisma.stroke.findUnique({ where: { clientUuid: strokeClientUuid } });
        expect(strokeInDb?.deletedAt).not.toBeNull();

        const eventInDb = await prisma.event.findUnique({ where: { clientUuid: `stroke-delete-${strokeClientUuid}` } });
        expect(eventInDb).not.toBeNull();
        expect(eventInDb?.type).toBe("stroke.delete");

        // Broadcasted exactly once
        expect(broadcasted).toHaveLength(1);
        expect(broadcasted[0].clientUuid).toBe(`stroke-delete-${strokeClientUuid}`);

        // Idempotent retry of delete
        const res2 = await app.inject({
          method: "DELETE",
          url: `/sessions/${SESSION_ID}/strokes/${strokeClientUuid}`,
          headers: { cookie },
        });

        expect(res2.statusCode).toBe(204);

        // Event count still 1
        const eventCount = await prisma.event.count({
          where: { clientUuid: `stroke-delete-${strokeClientUuid}` },
        });
        expect(eventCount).toBe(1);

        // Must NOT have rebroadcast
        expect(broadcasted).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });

    test("rejects 409 conflict when stroke belongs to another session", async () => {
      const foreignStrokeUuid = "stroke-foreign-del";
      await prisma.stroke.create({
        data: {
          sessionId: SESSION2_ID,
          userId: USER_ID,
          clientUuid: foreignStrokeUuid,
          payloadJson: { secret: "foreign" },
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/sessions/${SESSION_ID}/strokes/${foreignStrokeUuid}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(409);
      const foreignStroke = await prisma.stroke.findUnique({ where: { clientUuid: foreignStrokeUuid } });
      expect(foreignStroke?.deletedAt).toBeNull();
    });

    test("rejects 409 conflict when delete event belongs to another session", async () => {
      const foreignEventUuid = "stroke-foreign-ev-del";
      const foreignSession = await prisma.gameSession.update({
        where: { id: SESSION2_ID },
        data: { eventSequence: { increment: 1 } },
        select: { eventSequence: true },
      });
      await prisma.event.create({
        data: {
          sessionId: SESSION2_ID,
          userId: USER_ID,
          sequence: foreignSession.eventSequence,
          type: "stroke.delete",
          payloadJson: { clientUuid: foreignEventUuid },
          clientUuid: `stroke-delete-${foreignEventUuid}`,
          clientCreatedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "DELETE",
        url: `/sessions/${SESSION_ID}/strokes/${foreignEventUuid}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(409);
    });

    test("delete-before-create stroke race: creates tombstone and prevents resurrection on subsequent create", async () => {
      const raceUuid = "stroke-race-uuid-1";
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && (ev.type === "stroke.delete" || ev.type === "stroke.create")) {
          broadcasted.push(ev as EventRecord);
        }
      });

      try {
        const resDel = await app.inject({
          method: "DELETE",
          url: `/sessions/${SESSION_ID}/strokes/${raceUuid}`,
          headers: { cookie },
        });
        expect(resDel.statusCode).toBe(204);

        const strokeTombstone = await prisma.stroke.findUnique({ where: { clientUuid: raceUuid } });
        expect(strokeTombstone).not.toBeNull();
        expect(strokeTombstone?.deletedAt).not.toBeNull();

        const delEvent = await prisma.event.findUnique({ where: { clientUuid: `stroke-delete-${raceUuid}` } });
        expect(delEvent).not.toBeNull();
        expect(delEvent?.type).toBe("stroke.delete");
        expect(delEvent?.sequence).toBeGreaterThan(0);
        expect(broadcasted).toHaveLength(1);
        expect(broadcasted[0].type).toBe("stroke.delete");

        const resPost = await app.inject({
          method: "POST",
          url: `/sessions/${SESSION_ID}/strokes`,
          headers: { cookie },
          payload: {
            clientUuid: raceUuid,
            payloadJson: { points: [1, 2, 3] },
          },
        });
        expect(resPost.statusCode).toBe(201);

        const strokeAfterPost = await prisma.stroke.findUnique({ where: { clientUuid: raceUuid } });
        expect(strokeAfterPost?.deletedAt).not.toBeNull();

        const createEvent = await prisma.event.findUnique({ where: { clientUuid: `stroke-create-${raceUuid}` } });
        expect(createEvent).toBeNull();
        expect(broadcasted).toHaveLength(1);

        const getRes = await app.inject({
          method: "GET",
          url: `/sessions/${SESSION_ID}/strokes`,
          headers: { cookie },
        });
        const { strokes } = getRes.json<{ strokes: Array<{ clientUuid: string }> }>();
        expect(strokes.some((s) => s.clientUuid === raceUuid)).toBe(false);
      } finally {
        unsubscribe();
        await prisma.event.deleteMany({ where: { clientUuid: `stroke-delete-${raceUuid}` } });
        await prisma.stroke.deleteMany({ where: { clientUuid: raceUuid } });
      }
    });
  });

  // ── Question Replacement ───────────────────────────────────────────────────
  describe("PUT /sessions/:sessionId/questions", () => {
    test("replaces questions and writes durable event atomically when replacementId present, idempotent retry does not rebroadcast", async () => {
      const replacementId = "rep-test-atomic-1";
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && ev.type === "questions.replace") {
          broadcasted.push(ev as EventRecord);
        }
      });

      try {
        const questionsPayload = [
          { clientUuid: "q-1", ordinal: 0, payloadJson: { text: "Question 1" } },
          { clientUuid: "q-2", ordinal: 1, payloadJson: { text: "Question 2" } },
        ];

        // Initial replacement
        const res1 = await app.inject({
          method: "PUT",
          url: `/sessions/${SESSION_ID}/questions`,
          headers: { cookie },
          payload: {
            questions: questionsPayload,
            replacementId,
          },
        });

        expect(res1.statusCode).toBe(204);

        // Content exists in DB
        const savedQuestions = await prisma.sessionQuestion.findMany({
          where: { sessionId: SESSION_ID },
          orderBy: { ordinal: "asc" },
        });
        expect(savedQuestions).toHaveLength(2);
        expect(savedQuestions[0].clientUuid).toBe("q-1");
        expect(savedQuestions[1].clientUuid).toBe("q-2");

        // Durable corresponding event exists
        const eventInDb = await prisma.event.findUnique({
          where: { clientUuid: `questions-replace-${replacementId}` },
        });
        expect(eventInDb).not.toBeNull();
        expect(eventInDb?.type).toBe("questions.replace");

        // Broadcasted exactly once
        expect(broadcasted).toHaveLength(1);
        expect(broadcasted[0].clientUuid).toBe(`questions-replace-${replacementId}`);

        // Idempotent retry: same replacementId
        const res2 = await app.inject({
          method: "PUT",
          url: `/sessions/${SESSION_ID}/questions`,
          headers: { cookie },
          payload: {
            questions: questionsPayload,
            replacementId,
          },
        });

        expect(res2.statusCode).toBe(204);

        // Event count still 1
        const eventCount = await prisma.event.count({
          where: { clientUuid: `questions-replace-${replacementId}` },
        });
        expect(eventCount).toBe(1);

        // No duplicate broadcast
        expect(broadcasted).toHaveLength(1);
      } finally {
        unsubscribe();
      }
    });

    test("content mutation rolls back if event persistence fails", async () => {
      // Seed existing question
      await prisma.sessionQuestion.deleteMany({ where: { sessionId: SESSION_ID } });
      await prisma.sessionQuestion.create({
        data: {
          sessionId: SESSION_ID,
          clientUuid: "q-original",
          ordinal: 0,
          payloadJson: { text: "Original Question" },
        },
      });

      // Pre-seed an event with a conflicting clientUuid for a DIFFERENT session to simulate
      // a condition where tx.event.create fails (e.g. unique constraint violation on Event)
      const conflictReplacementId = "rep-conflict-test";
      const conflictEventUuid = `questions-replace-${conflictReplacementId}`;

      // Create a dummy session to hold the conflicting event
      const OTHER_SESSION_ID = "test-scontent-other";
      const game = await prisma.game.findUniqueOrThrow({ where: { id: GAME_ID } });
      await prisma.gameSession.create({
        data: {
          id: OTHER_SESSION_ID,
          gameId: GAME_ID,
          serverId: SERVER_ID,
          creatorId: USER_ID,
          name: "Other Session",
          gameRevisionId: game.currentRevisionId!,
        },
      });

      await prisma.event.create({
        data: {
          sessionId: OTHER_SESSION_ID,
          userId: USER_ID,
          sequence: 1,
          type: "questions.replace",
          payloadJson: { dummy: true },
          clientUuid: conflictEventUuid,
          clientCreatedAt: new Date(),
        },
      });

      try {
        // Now try to PUT questions to SESSION_ID with the conflictReplacementId.
        // In the transaction, existingEvent check for SESSION_ID will be null (since it was for OTHER_SESSION_ID),
        // but tx.event.create will fail on global unique constraint `clientUuid`!
        // The transaction must roll back, preserving q-original!
        const res = await app.inject({
          method: "PUT",
          url: `/sessions/${SESSION_ID}/questions`,
          headers: { cookie },
          payload: {
            questions: [
              { clientUuid: "q-attempted-new", ordinal: 0, payloadJson: { text: "Should be rolled back" } },
            ],
            replacementId: conflictReplacementId,
          },
        });

        expect(res.statusCode).toBe(409);
        const questionsInDb = await prisma.sessionQuestion.findMany({
          where: { sessionId: SESSION_ID },
        });
        // Original question must still be there because transaction rolled back!
        expect(questionsInDb).toHaveLength(1);
        expect(questionsInDb[0].clientUuid).toBe("q-original");
      } finally {
        await prisma.event.deleteMany({ where: { sessionId: OTHER_SESSION_ID } });
        await prisma.gameSession.delete({ where: { id: OTHER_SESSION_ID } });
      }
    });

    test("rejects 409 conflict when replacementId belongs to another session", async () => {
      const foreignRepId = "rep-foreign-session";
      const foreignSession = await prisma.gameSession.update({
        where: { id: SESSION2_ID },
        data: { eventSequence: { increment: 1 } },
        select: { eventSequence: true },
      });
      await prisma.event.create({
        data: {
          sessionId: SESSION2_ID,
          userId: USER_ID,
          sequence: foreignSession.eventSequence,
          type: "questions.replace",
          payloadJson: { replacementId: foreignRepId, questions: [] },
          clientUuid: `questions-replace-${foreignRepId}`,
          clientCreatedAt: new Date(),
        },
      });

      const res = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "q-new", ordinal: 0, payloadJson: {} }],
          replacementId: foreignRepId,
        },
      });

      expect(res.statusCode).toBe(409);
    });

    test("propagates 409 conflict on question clientUuid duplicate and rolls back", async () => {
      await prisma.sessionQuestion.deleteMany({ where: { sessionId: SESSION_ID } });
      await prisma.sessionQuestion.create({
        data: {
          sessionId: SESSION_ID,
          clientUuid: "q-keep",
          ordinal: 0,
          payloadJson: { text: "Should remain" },
        },
      });

      const res = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [
            { clientUuid: "q-dup", ordinal: 0, payloadJson: {} },
            { clientUuid: "q-dup", ordinal: 1, payloadJson: {} },
          ],
          replacementId: "rep-dup-test",
        },
      });

      expect(res.statusCode).toBe(409);

      const inDb = await prisma.sessionQuestion.findMany({ where: { sessionId: SESSION_ID } });
      expect(inDb).toHaveLength(1);
      expect(inDb[0].clientUuid).toBe("q-keep");
    });

    test("rejects 400 Bad Request when replacementId is missing or empty (no 204 for undurable mutation)", async () => {
      const resMissing = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "q-req-id", ordinal: 0, payloadJson: {} }],
        },
      });
      expect(resMissing.statusCode).toBe(400);

      const resEmpty = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "q-req-id", ordinal: 0, payloadJson: {} }],
          replacementId: "",
        },
      });
      expect(resEmpty.statusCode).toBe(400);
    });

    test("rejects 400 Bad Request for a fractional ordinal (the column is an integer)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "q-fraction", ordinal: 0.5, payloadJson: {} }],
          replacementId: "replace-fractional-ordinal",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    test("rejects 400 Bad Request for an ordinal too large for the column", async () => {
      const res = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "q-huge-ordinal", ordinal: 2147483648, payloadJson: {} }],
          replacementId: "replace-huge-ordinal",
        },
      });
      expect(res.statusCode).toBe(400);
    });

    test("mutations allocate contiguous strictly increasing sequence numbers matching GameSession.eventSequence", async () => {
      const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      const initialSeq = session.eventSequence;

      const res1 = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/strokes`,
        headers: { cookie },
        payload: {
          clientUuid: "seq-test-stroke-1",
          payloadJson: { a: 1 },
        },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: {
          questions: [{ clientUuid: "seq-test-q-1", ordinal: 0, payloadJson: { q: 1 } }],
          replacementId: "seq-test-rep-1",
        },
      });
      expect(res2.statusCode).toBe(204);

      const ev1 = await prisma.event.findUniqueOrThrow({ where: { clientUuid: "stroke-create-seq-test-stroke-1" } });
      const ev2 = await prisma.event.findUniqueOrThrow({ where: { clientUuid: "questions-replace-seq-test-rep-1" } });

      expect(ev1.sequence).toBe(initialSeq + 1);
      expect(ev2.sequence).toBe(initialSeq + 2);

      const updatedSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      expect(updatedSession.eventSequence).toBe(initialSeq + 2);

      await prisma.event.deleteMany({ where: { id: { in: [ev1.id, ev2.id] } } });
      await prisma.stroke.deleteMany({ where: { clientUuid: "seq-test-stroke-1" } });
      await prisma.sessionQuestion.deleteMany({ where: { clientUuid: "seq-test-q-1" } });
    });
  });

  describe("PATCH /sessions/:sessionId and POST /upgrade-revision durable events", () => {
    test("persists hider.update and planning.toggle events with sequence and updates session state", async () => {
      const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      const initialSeq = session.eventSequence;

      const resHider = await app.inject({
        method: "PATCH",
        url: `/sessions/${SESSION_ID}`,
        headers: { cookie },
        payload: {
          hiderLat: 48.8566,
          hiderLng: 2.3522,
        },
      });
      expect(resHider.statusCode).toBe(200);

      const hiderEvent = await prisma.event.findFirst({
        where: { sessionId: SESSION_ID, type: "hider.update" },
        orderBy: { sequence: "desc" },
      });
      expect(hiderEvent).not.toBeNull();
      expect(hiderEvent?.sequence).toBe(initialSeq + 1);
      expect(hiderEvent?.payloadJson).toEqual({ hiderLat: 48.8566, hiderLng: 2.3522 });

      const resPlanning = await app.inject({
        method: "PATCH",
        url: `/sessions/${SESSION_ID}`,
        headers: { cookie },
        payload: {
          planningModeEnabled: true,
        },
      });
      expect(resPlanning.statusCode).toBe(200);

      const planningEvent = await prisma.event.findFirst({
        where: { sessionId: SESSION_ID, type: "planning.toggle" },
        orderBy: { sequence: "desc" },
      });
      expect(planningEvent).not.toBeNull();
      expect(planningEvent?.sequence).toBe(initialSeq + 2);
      expect(planningEvent?.payloadJson).toEqual({ planningModeEnabled: true });

      // Idempotent PATCH does not create duplicate events
      const resIdempotent = await app.inject({
        method: "PATCH",
        url: `/sessions/${SESSION_ID}`,
        headers: { cookie },
        payload: {
          planningModeEnabled: true,
        },
      });
      expect(resIdempotent.statusCode).toBe(200);

      const finalSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      expect(finalSession.eventSequence).toBe(initialSeq + 2);
    });

    test("persists and broadcasts a zones.disabled event with the whole list, only when it changes", async () => {
      const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      const initialSeq = session.eventSequence;
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && ev.type === "zones.disabled") {
          broadcasted.push(ev as EventRecord);
        }
      });

      try {
        const res = await app.inject({
          method: "PATCH",
          url: `/sessions/${SESSION_ID}`,
          headers: { cookie },
          payload: { disableZoneIds: ["zone-b", "zone-a"], zonesClientUuid: `zones-disabled-${SESSION_ID}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json<{ disabledZoneIds: string[] }>().disabledZoneIds).toEqual(["zone-a", "zone-b"]);

        const zonesEvent = await prisma.event.findUniqueOrThrow({
          where: { clientUuid: `zones-disabled-${SESSION_ID}` },
        });
        expect(zonesEvent.type).toBe("zones.disabled");
        expect(zonesEvent.sequence).toBe(initialSeq + 1);
        expect(zonesEvent.payloadJson).toEqual({ disabledZoneIds: ["zone-a", "zone-b"] });
        expect(broadcasted).toHaveLength(1);
        expect(broadcasted[0].clientUuid).toBe(zonesEvent.clientUuid);
        expect(broadcasted[0].payloadJson).toEqual({ disabledZoneIds: ["zone-a", "zone-b"] });

        // The same change again (a retry) is no change: no event, no broadcast
        const resSame = await app.inject({
          method: "PATCH",
          url: `/sessions/${SESSION_ID}`,
          headers: { cookie },
          payload: { disableZoneIds: ["zone-a"] },
        });
        expect(resSame.statusCode).toBe(200);
        expect(resSame.json<{ disabledZoneIds: string[] }>().disabledZoneIds).toEqual(["zone-a", "zone-b"]);
        expect(broadcasted).toHaveLength(1);

        const finalSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
        expect(finalSession.eventSequence).toBe(initialSeq + 1);
      } finally {
        unsubscribe();
        await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { disabledZoneIds: [] } });
      }
    });

    test("upgrade-revision creates durable session.revision-upgraded event with sequence", async () => {
      const rev2 = await prisma.gameRevision.create({
        data: {
          gameId: GAME_ID,
          revision: 2,
          checksum: "content-rev2-checksum",
          definition: { id: "content-game", name: "Content Game v2", serverId: SERVER_ID },
        },
      });
      await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: rev2.id } });

      const sessionBefore = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      const initialSeq = sessionBefore.eventSequence;

      const res = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/upgrade-revision`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ status: string; newRevision: number }>();
      expect(body.status).toBe("upgraded");
      expect(body.newRevision).toBe(2);

      const upgradeEvent = await prisma.event.findFirst({
        where: { sessionId: SESSION_ID, type: "session.revision-upgraded" },
        orderBy: { sequence: "desc" },
      });
      expect(upgradeEvent).not.toBeNull();
      expect(upgradeEvent?.sequence).toBe(initialSeq + 1);

      const sessionAfter = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      expect(sessionAfter.gameRevisionId).toBe(rev2.id);
      expect(sessionAfter.eventSequence).toBe(initialSeq + 1);

      const resRetry = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/upgrade-revision`,
        headers: { cookie },
      });
      expect(resRetry.statusCode).toBe(200);
      expect(resRetry.json()).toEqual({
        status: "already-current",
        newRevision: 2,
        gameRevisionId: rev2.id,
      });

      const sessionFinal = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      expect(sessionFinal.eventSequence).toBe(initialSeq + 1);
    });

    test.each([
      { publishAfterFirstUpgrade: false, revision: 10 },
      { publishAfterFirstUpgrade: true, revision: 20 },
    ])("serializes delayed upgrades with publication timing $publishAfterFirstUpgrade", async ({
      publishAfterFirstUpgrade,
      revision,
    }) => {
      const initialSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION2_ID } });
      const initialGame = await prisma.game.findUniqueOrThrow({ where: { id: GAME_ID } });
      const target2 = await prisma.gameRevision.create({
        data: {
          gameId: GAME_ID,
          revision,
          checksum: `content-concurrent-${revision}`,
          definition: { id: "content-game", name: "Concurrent revision", serverId: SERVER_ID },
        },
      });
      const target3 = await prisma.gameRevision.create({
        data: {
          gameId: GAME_ID,
          revision: revision + 1,
          checksum: `content-concurrent-${revision + 1}`,
          definition: { id: "content-game", name: "Latest concurrent revision", serverId: SERVER_ID },
        },
      });
      await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: target2.id } });

      let reachedLock!: () => void;
      const waitingForLock = new Promise<void>((resolve) => { reachedLock = resolve; });
      let releaseLock!: () => void;
      const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
      const originalTransaction = prisma.$transaction;
      const transact = originalTransaction.bind(prisma);
      const transactionSpy = vi.fn(transact);
      prisma.$transaction = transactionSpy as unknown as typeof prisma.$transaction;
      // Pause only the first request immediately before its real row-lock query.
      // All reads, writes and the competing request still use PostgreSQL.
      transactionSpy.mockImplementationOnce((operation, options) =>
        transact(async (tx) => operation(new Proxy(tx, {
          get(target, property, receiver) {
            if (property === "$queryRaw") {
              return async (...args: Parameters<typeof tx.$queryRaw>) => {
                reachedLock();
                await lockReleased;
                return tx.$queryRaw(...args);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        })), options),
      );
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION2_ID, (event) => {
        if ("type" in event && event.type === "session.revision-upgraded") {
          broadcasted.push(event as EventRecord);
        }
      });
      const upgrade = () => app.inject({
        method: "POST",
        url: `/sessions/${SESSION2_ID}/upgrade-revision`,
        headers: { cookie },
      });
      const delayed = upgrade().then((response) => response);

      try {
        await waitingForLock;
        if (!publishAfterFirstUpgrade) {
          await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: target3.id } });
        }
        const first = await upgrade();
        expect(first.statusCode).toBe(200);
        expect(first.json()).toMatchObject({
          status: "upgraded",
          newRevision: publishAfterFirstUpgrade ? target2.revision : target3.revision,
        });
        if (publishAfterFirstUpgrade) {
          await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: target3.id } });
        }
        releaseLock();
        const resumed = await delayed;
        expect(resumed.statusCode).toBe(200);
        expect(resumed.json()).toEqual(publishAfterFirstUpgrade ? {
          status: "upgraded",
          previousRevision: target2.revision,
          newRevision: target3.revision,
          gameRevisionId: target3.id,
        } : {
          status: "already-current",
          newRevision: target3.revision,
          gameRevisionId: target3.id,
        });

        const retry = await upgrade();
        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual({
          status: "already-current",
          newRevision: target3.revision,
          gameRevisionId: target3.id,
        });
        const events = await prisma.event.findMany({
          where: {
            sessionId: SESSION2_ID,
            sequence: { gt: initialSession.eventSequence },
            type: "session.revision-upgraded",
          },
          orderBy: { sequence: "asc" },
        });
        const expectedTargets = publishAfterFirstUpgrade ? [target2, target3] : [target3];
        expect(events.map((event) => event.payloadJson)).toEqual(expectedTargets.map((target) => ({
          sessionId: SESSION2_ID,
          gameRevisionId: target.id,
          revision: target.revision,
        })));
        expect(events.map((event) => event.sequence)).toEqual(
          expectedTargets.map((_, index) => initialSession.eventSequence + index + 1),
        );
        expect(broadcasted.map((event) => event.id)).toEqual(events.map((event) => event.id));
        const finalSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION2_ID } });
        expect(finalSession.gameRevisionId).toBe(target3.id);
        expect(finalSession.eventSequence).toBe(initialSession.eventSequence + expectedTargets.length);
      } finally {
        releaseLock();
        await delayed;
        prisma.$transaction = originalTransaction;
        unsubscribe();
        await prisma.gameSession.update({
          where: { id: SESSION2_ID },
          data: { gameRevisionId: initialSession.gameRevisionId },
        });
        await prisma.game.update({
          where: { id: GAME_ID },
          data: { currentRevisionId: initialGame.currentRevisionId },
        });
        await prisma.gameRevision.deleteMany({ where: { id: { in: [target2.id, target3.id] } } });
      }
    });

    test("can recover a previously reached revision without reusing its old transition event", async () => {
      const initialGame = await prisma.game.findUniqueOrThrow({ where: { id: GAME_ID } });
      const initialSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION2_ID } });
      const target = await prisma.gameRevision.create({
        data: {
          gameId: GAME_ID,
          revision: 30,
          checksum: "content-recovery-revision",
          definition: { id: "content-game", name: "Recovery revision", serverId: SERVER_ID },
        },
      });
      await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: target.id } });
      // A session downgraded by the old race still retains its first upgrade event.
      const oldEvent = await prisma.event.create({
        data: {
          sessionId: SESSION2_ID,
          userId: USER_ID,
          sequence: initialSession.eventSequence + 1,
          type: "session.revision-upgraded",
          payloadJson: { sessionId: SESSION2_ID, gameRevisionId: target.id, revision: target.revision },
          clientUuid: `session-revision-upgraded-${SESSION2_ID}-${target.id}`,
          clientCreatedAt: new Date(),
        },
      });
      await prisma.gameSession.update({
        where: { id: SESSION2_ID },
        data: { eventSequence: oldEvent.sequence },
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: `/sessions/${SESSION2_ID}/upgrade-revision`,
          headers: { cookie },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          status: "upgraded",
          newRevision: target.revision,
          gameRevisionId: target.id,
        });
        const events = await prisma.event.findMany({
          where: { sessionId: SESSION2_ID, sequence: { gte: oldEvent.sequence } },
          orderBy: { sequence: "asc" },
        });
        expect(events.map((event) => event.sequence)).toEqual([oldEvent.sequence, oldEvent.sequence + 1]);
        expect(events[1].clientUuid).not.toBe(oldEvent.clientUuid);
        expect(events[1].payloadJson).toEqual(oldEvent.payloadJson);
        const finalSession = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION2_ID } });
        expect(finalSession.gameRevisionId).toBe(target.id);
        expect(finalSession.eventSequence).toBe(oldEvent.sequence + 1);
      } finally {
        await prisma.gameSession.update({
          where: { id: SESSION2_ID },
          data: { gameRevisionId: initialSession.gameRevisionId },
        });
        await prisma.game.update({
          where: { id: GAME_ID },
          data: { currentRevisionId: initialGame.currentRevisionId },
        });
        await prisma.gameRevision.delete({ where: { id: target.id } });
      }
    });
  });
});
