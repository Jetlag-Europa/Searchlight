import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { QUESTION_CHANGES_LIMIT, sessionContentRoutes } from "./session-content.js";
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

  describe("PUT /sessions/:sessionId/questions with baseSequence", () => {
    const put = (replacementId: string, questions: unknown[], baseSequence?: number) =>
      app.inject({
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
        payload: { questions, replacementId, ...(baseSequence === undefined ? {} : { baseSequence }) },
      });
    const read = async () => {
      const res = await app.inject({
        method: "GET",
        url: `/sessions/${SESSION_ID}/questions`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      return res.json() as { questions: Array<{ clientUuid: string }>; sequence: number };
    };
    const question = (clientUuid: string, ordinal = 0) => ({ clientUuid, ordinal, payloadJson: { key: ordinal } });

    test("reads the list with the sequence it's at, and saves over it with that base", async () => {
      await put("base-seq-setup", [question("base-a")]);
      const { questions, sequence } = await read();
      expect(questions.map((q) => q.clientUuid)).toEqual(["base-a"]);
      const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
      expect(sequence).toBe(session.eventSequence);

      const res = await put("base-seq-current", [question("base-b")], sequence);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sequence: sequence + 1 });
      expect((await read()).questions.map((q) => q.clientUuid)).toEqual(["base-b"]);
    });

    test("refuses a list made before another replace, and changes nothing", async () => {
      const { sequence: stale } = await read();
      await put("base-seq-other-device", [question("other-device")]);
      const eventsBefore = await prisma.event.count({ where: { sessionId: SESSION_ID } });

      const res = await put("base-seq-stale", [question("stale")], stale);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("QUESTIONS_CHANGED");
      expect((await read()).questions.map((q) => q.clientUuid)).toEqual(["other-device"]);
      expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(eventsBefore);
      expect(
        await prisma.event.findUnique({ where: { clientUuid: "questions-replace-base-seq-stale" } }),
      ).toBeNull();

      // The client merges and saves again on the new base.
      const { sequence } = await read();
      const merged = await put("base-seq-stale", [question("other-device"), question("stale", 1)], sequence);
      expect(merged.statusCode).toBe(200);
      expect((await read()).questions.map((q) => q.clientUuid)).toEqual(["other-device", "stale"]);
    });

    test("isn't refused for other kinds of events since the base", async () => {
      const { sequence } = await read();
      const stroke = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/strokes`,
        headers: { cookie },
        payload: { clientUuid: "base-seq-stroke", payloadJson: { a: 1 } },
      });
      expect(stroke.statusCode).toBe(201);
      expect((await put("base-seq-after-stroke", [question("after-stroke")], sequence)).statusCode).toBe(200);
    });

    test("answers a retry of a saved list with its sequence, even once it is stale", async () => {
      const { sequence } = await read();
      const first = await put("base-seq-retry", [question("retry")], sequence);
      expect(first.statusCode).toBe(200);
      await put("base-seq-after-retry", [question("later")]);

      const retry = await put("base-seq-retry", [question("retry")], sequence);
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual({ ...first.json(), duplicate: true });
      expect((await read()).questions.map((q) => q.clientUuid)).toEqual(["later"]);
    });

    test("says a retry was saved before", async () => {
      const { sequence } = await read();
      const first = await put("base-seq-dup", [question("dup")], sequence);
      expect(first.json()).toEqual({ sequence: sequence + 1 });
      const retry = await put("base-seq-dup", [question("dup")], sequence);
      expect(retry.json()).toEqual({ sequence: sequence + 1, duplicate: true });
    });

    test("refuses a base from beyond the session's sequence", async () => {
      const { sequence } = await read();
      const res = await put("base-seq-future", [question("future")], sequence + 5);
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("QUESTIONS_CHANGED");
    });

    test("keeps keys that need all 17 digits exactly, in the list and its event", async () => {
      const keys = [0.47550004144641034, 0.30000000000000004, 0.12345678901234568];
      const broadcasted: EventRecord[] = [];
      const unsubscribe = subscribe(SESSION_ID, (ev) => {
        if ("type" in ev && ev.type === "questions.replace") broadcasted.push(ev as EventRecord);
      });
      try {
        const { sequence } = await read();
        const res = await put(
          "base-seq-exact",
          keys.map((key, ordinal) => ({
            clientUuid: `exact-${ordinal}`,
            ordinal,
            payloadJson: { id: "radius", key, data: { lat: 47.42790359754809 } },
          })),
          sequence,
        );
        expect(res.statusCode).toBe(200);
        const read2 = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/questions`, headers: { cookie } });
        expect(read2.json().questions.map((q: { payloadJson: { key: number } }) => q.payloadJson.key)).toEqual(keys);
        const event = await prisma.event.findUniqueOrThrow({ where: { clientUuid: "questions-replace-base-seq-exact" } });
        const stored = (event.payloadJson as { questions: Array<{ payloadJson: { key: number } }> }).questions;
        expect(stored.map((q) => q.payloadJson.key)).toEqual(keys);
        const sent = (broadcasted[0].payloadJson as { questions: Array<{ payloadJson: { key: number } }> }).questions;
        expect(sent.map((q) => q.payloadJson.key)).toEqual(keys);
      } finally {
        unsubscribe();
      }
    });

    test("still replaces the list, with 204, for a client that sends no base", async () => {
      await put("base-seq-legacy-1", [question("legacy-1")]);
      const res = await put("base-seq-legacy-2", [question("legacy-2")]);
      expect(res.statusCode).toBe(204);
      expect((await read()).questions.map((q) => q.clientUuid)).toEqual(["legacy-2"]);
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

describe("GET /sessions/:sessionId/questions/changes", () => {
  const PREFIX = "test-qchanges";
  const CREATOR = `${PREFIX}-creator`;
  const PLAYER = `${PREFIX}-player`;
  const NAMELESS = `${PREFIX}-nameless`;
  const OUTSIDER = `${PREFIX}-outsider`;
  const REVOKED = `${PREFIX}-revoked`;
  const USERS = [CREATOR, PLAYER, NAMELESS, OUTSIDER, REVOKED];
  const SERVER = `${PREFIX}-server`;
  const GAME = `${PREFIX}-game`;
  const SESSION = `${PREFIX}-session`;
  const BUSY_SESSION = `${PREFIX}-busy`;
  const ODD_SESSION = `${PREFIX}-odd`;
  const SESSIONS = [SESSION, BUSY_SESSION, ODD_SESSION];
  // Needs all 17 digits: one unit in the last place off reads differently.
  const EXACT_KEY = 0.47550004144641034;

  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  async function cleanUp() {
    await prisma.event.deleteMany({ where: { sessionId: { in: SESSIONS } } });
    await prisma.sessionQuestion.deleteMany({ where: { sessionId: { in: SESSIONS } } });
    await prisma.sessionParticipant.deleteMany({ where: { sessionId: { in: SESSIONS } } });
    await prisma.gameSession.deleteMany({ where: { id: { in: SESSIONS } } });
    await prisma.gameRevision.deleteMany({ where: { gameId: GAME } });
    await prisma.game.deleteMany({ where: { id: GAME } });
    await prisma.server.deleteMany({ where: { id: SERVER } });
    await prisma.authSession.deleteMany({ where: { userId: { in: USERS } } });
    await prisma.user.deleteMany({ where: { discordId: { in: USERS } } });
  }

  const get = (query: string, as = CREATOR, sessionId = SESSION) =>
    app.inject({
      method: "GET",
      url: `/sessions/${sessionId}/questions/changes${query}`,
      headers: { cookie: cookies[as] },
    });
  const put = async (as: string, replacementId: string, payloads: unknown[]) => {
    const res = await app.inject({
      method: "PUT",
      url: `/sessions/${SESSION}/questions`,
      headers: { cookie: cookies[as] },
      payload: {
        replacementId,
        questions: payloads.map((payloadJson, ordinal) => ({
          clientUuid: `${PREFIX}-${replacementId}-${ordinal}`,
          ordinal,
          payloadJson,
        })),
      },
    });
    expect(res.statusCode).toBe(204);
    return (await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION } })).eventSequence;
  };

  beforeAll(async () => {
    await cleanUp();
    const names: Record<string, string> = {
      [CREATOR]: "Alex",
      [PLAYER]: "Sam",
      [NAMELESS]: "",
      [OUTSIDER]: "Outsider",
      [REVOKED]: "Revoked",
    };
    for (const id of USERS) {
      await prisma.user.create({
        data: {
          discordId: id,
          username: id,
          displayName: names[id],
          avatarUrl: "https://example.com/q.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
    }
    await prisma.server.create({ data: { id: SERVER, name: "Changes Server" } });
    await prisma.game.create({
      data: { id: GAME, serverId: SERVER, name: "Changes Game", gameKey: "qchanges-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: { gameId: GAME, revision: 1, checksum: "qchanges-checksum", definition: { id: "qchanges-game" } },
    });
    await prisma.gameSession.createMany({
      data: SESSIONS.map((id) => ({
        id,
        gameId: GAME,
        serverId: SERVER,
        creatorId: CREATOR,
        name: id,
        gameRevisionId: rev.id,
      })),
    });
    const now = new Date();
    await prisma.sessionParticipant.createMany({
      data: [
        { sessionId: SESSION, userId: PLAYER, role: "member", acceptedAt: now },
        { sessionId: SESSION, userId: NAMELESS, role: "member", acceptedAt: now },
        { sessionId: SESSION, userId: REVOKED, role: "member", acceptedAt: now, revokedAt: now },
      ],
    });

    app = await buildTestApp();
    for (const id of USERS) {
      await prisma.authSession.create({
        data: { id: `${id}-auth`, userId: id, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      cookies[id] = `session=${app.signCookie(`${id}-auth`)}`;
    }
  });

  afterAll(async () => {
    await app.close();
    await cleanUp();
    await prisma.$disconnect();
  });

  // Each test reads from the session's sequence when it starts.
  const sequenceNow = async () =>
    (await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION } })).eventSequence;

  test("lists the replacements after a sequence, oldest first, with only the requested questions", async () => {
    const start = await sequenceNow();
    const a = { id: "radius", key: EXACT_KEY, data: { radius: 2 } };
    const b = { id: "thermometer", key: 0.25, data: { hit: true } };
    const c = { id: "matching", key: 3, data: {} };
    await put(CREATOR, "keys-1", [a, b, c]);
    const a2 = { ...a, data: { radius: 3 } };
    const second = await put(PLAYER, "keys-2", [a2, c]);
    // A stroke between them isn't a question change.
    await app.inject({
      method: "POST",
      url: `/sessions/${SESSION}/strokes`,
      headers: { cookie: cookies[PLAYER] },
      payload: { clientUuid: `${PREFIX}-stroke`, payloadJson: { a: 1 } },
    });
    const third = await put(NAMELESS, "keys-3", [c]);

    const res = await get(`?after=${start}&keys=${EXACT_KEY},0.25`, PLAYER);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      changes: [
        { sequence: start + 1, userId: CREATOR, displayName: "Alex", questions: [a, b] },
        { sequence: second, userId: PLAYER, displayName: "Sam", questions: [a2] },
        // No name to show: the id stands in.
        { sequence: third, userId: NAMELESS, displayName: NAMELESS, questions: [] },
      ],
    });
    expect(third).toBe(second + 2);
    // The key comes back with all its digits.
    expect(res.json().changes[0].questions[0].key).toBe(EXACT_KEY);

    const later = await get(`?after=${second - 1}&keys=3`);
    expect(later.json().changes.map((e: { sequence: number }) => e.sequence)).toEqual([second, third]);
    expect(later.json().changes.map((e: { questions: unknown[] }) => e.questions)).toEqual([[c], [c]]);
    expect((await get(`?after=${third}&keys=3`)).json()).toEqual({ changes: [] });
  });

  test("stops at `until`, inclusive", async () => {
    const start = await sequenceNow();
    const q = (n: number) => ({ key: EXACT_KEY, n });
    const first = await put(CREATOR, "until-1", [q(1)]);
    const second = await put(PLAYER, "until-2", [q(2)]);
    await put(CREATOR, "until-3", [q(3)]);

    const res = await get(`?after=${start}&until=${second}&keys=${EXACT_KEY}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      changes: [
        { sequence: first, userId: CREATOR, displayName: "Alex", questions: [q(1)] },
        { sequence: second, userId: PLAYER, displayName: "Sam", questions: [q(2)] },
      ],
    });
    expect((await get(`?after=${start}&until=${start}&keys=${EXACT_KEY}`)).json()).toEqual({ changes: [] });
    // An `until` before `after` asks for nothing.
    expect((await get(`?after=${second}&until=${first}&keys=${EXACT_KEY}`)).json()).toEqual({ changes: [] });
  });

  test("picks the requested questions out of a large list, and copes with any stored shape", async () => {
    // Written as raw JSON text, like the PUT does, so every digit is kept.
    const event = async (sequence: number, payloadText: string) => {
      await prisma.$executeRaw`
        INSERT INTO "Event" (id, "sessionId", "userId", sequence, type, "payloadJson", "clientUuid", "clientCreatedAt")
        VALUES (${`${PREFIX}-odd-${sequence}`}, ${ODD_SESSION}, ${PLAYER}, ${sequence}, 'questions.replace',
          ${payloadText}::jsonb, ${`${PREFIX}-odd-${sequence}`}, now())
      `;
    };
    // A custom zone of 40,000 points: megabytes that never leave Postgres.
    const zone = {
      id: "custom-zone",
      key: 0.123,
      data: { polygon: Array.from({ length: 40_000 }, (_, i) => [5.123456789012345 + i * 1e-6, 50.98765432109876]) },
    };
    const wanted = { id: "radius", key: EXACT_KEY, data: { lat: 47.42790359754809 } };
    const list = (payloads: unknown[]) =>
      JSON.stringify({
        replacementId: "odd",
        questions: payloads.map((payloadJson, ordinal) => ({ clientUuid: `odd-${ordinal}`, ordinal, payloadJson })),
      });
    await event(1, list([zone, wanted]));
    await event(2, JSON.stringify({ replacementId: "no-list" }));
    await event(3, JSON.stringify({ questions: "not a list" }));
    await event(4, JSON.stringify({ questions: [null, 7, "x", [], {}, { payloadJson: null }, { payloadJson: 3 }] }));
    // Keys no double holds, and keys that aren't numbers.
    await event(5, `{"questions":[{"payloadJson":{"key":1e400}},{"payloadJson":{"key":1e-400}},{"payloadJson":{"key":"${EXACT_KEY}"}},{"payloadJson":{"key":null}},{"payloadJson":{"key":{"n":1}}}]}`);
    await event(6, list([wanted]));
    await prisma.gameSession.update({ where: { id: ODD_SESSION }, data: { eventSequence: 6 } });

    const res = await get(`?after=0&keys=${EXACT_KEY},0`, CREATOR, ODD_SESSION);
    expect(res.statusCode).toBe(200);
    // The answer is small: the zone isn't in it.
    expect(res.body.length).toBeLessThan(2000);
    expect(res.json()).toEqual({
      changes: [1, 2, 3, 4, 5, 6].map((sequence) => ({
        sequence,
        userId: PLAYER,
        displayName: "Sam",
        questions: sequence === 1 || sequence === 6 ? [wanted] : [],
      })),
    });
    expect(res.json().changes[0].questions[0].key).toBe(EXACT_KEY);
    expect(res.json().changes[0].questions[0].data.lat).toBe(47.42790359754809);

    const zoneOnly = await get("?after=0&until=1&keys=0.123", CREATOR, ODD_SESSION);
    expect(zoneOnly.json().changes[0].questions).toEqual([zone]);
  });

  test("knows a key by its 17 digits, and one a few units in the last place off as the same key", async () => {
    const start = await sequenceNow();
    const near = 0.30000000000000004;
    await put(CREATOR, "exact-1", [
      { key: EXACT_KEY },
      { key: near },
      { key: 0.3 },
      { key: "0.25" },
      { data: {} },
    ]);
    const exact = await get(`?after=${start}&keys=${EXACT_KEY}`);
    expect(exact.json().changes[0].questions).toEqual([{ key: EXACT_KEY }]);
    // 0.4755000414464103 is the same key read one unit off.
    const offByOne = await get(`?after=${start}&keys=0.4755000414464103`);
    expect(offByOne.json().changes[0].questions).toEqual([{ key: EXACT_KEY }]);
    // 0.3 and 0.30000000000000004 are one unit apart too.
    const point3 = await get(`?after=${start}&keys=0.3`);
    expect(point3.json().changes[0].questions).toEqual([{ key: near }, { key: 0.3 }]);
    // A key 1e-15 apart (the step between new keys) is another question; a
    // string key is no key.
    const other = await get(`?after=${start}&keys=${EXACT_KEY * (1 + 1e-15)},0.25`);
    expect(other.json().changes[0].questions).toEqual([]);
  });

  test("is only for the session's players", async () => {
    expect((await get("?after=0&keys=1", PLAYER)).statusCode).toBe(200);
    expect((await get("?after=0&keys=1", OUTSIDER)).statusCode).toBe(403);
    expect((await get("?after=0&keys=1", REVOKED)).statusCode).toBe(403);
    expect((await get("?after=0&keys=1", CREATOR, `${PREFIX}-missing`)).statusCode).toBe(404);
    const anonymous = await app.inject({ method: "GET", url: `/sessions/${SESSION}/questions/changes?after=0&keys=1` });
    expect(anonymous.statusCode).toBe(401);
  });

  test("refuses a missing or malformed after or keys", async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) => i).join(",");
    const fifty = Array.from({ length: 50 }, (_, i) => i).join(",");
    for (const query of [
      "?keys=1",
      "?after=0",
      "?after=0&until=-1&keys=1",
      "?after=0&until=1.5&keys=1",
      "?after=0&until=x&keys=1",
      "?after=-1&keys=1",
      "?after=1.5&keys=1",
      "?after=x&keys=1",
      "?after=0&keys=",
      "?after=0&keys=1,,2",
      "?after=0&keys=1,",
      "?after=0&keys=abc",
      "?after=0&keys=0x10",
      "?after=0&keys=NaN",
      "?after=0&keys=Infinity",
      "?after=0&keys=1e999",
      "?after=0&keys=%201",
      `?after=0&keys=${tooMany}`,
      "?after=0&keys=1&keys=2",
    ]) {
      expect({ query, status: (await get(query)).statusCode }).toEqual({ query, status: 400 });
    }
    expect((await get(`?after=0&keys=${fifty}`)).statusCode).toBe(200);
    expect((await get(`?after=0&keys=${encodeURIComponent("-1.5e-3,.5,2.,1E+2")}`)).statusCode).toBe(200);
  });

  test("answers at most QUESTION_CHANGES_LIMIT replacements, the oldest, and says there are more", async () => {
    const total = QUESTION_CHANGES_LIMIT + 1;
    await prisma.event.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        sessionId: BUSY_SESSION,
        userId: CREATOR,
        sequence: i + 1,
        type: "questions.replace",
        payloadJson: { replacementId: `busy-${i}`, questions: [{ clientUuid: `busy-${i}`, ordinal: 0, payloadJson: { key: 1, n: i } }] },
        clientUuid: `${PREFIX}-busy-${i}`,
        clientCreatedAt: new Date(),
      })),
    });
    await prisma.gameSession.update({ where: { id: BUSY_SESSION }, data: { eventSequence: total } });

    const capped = (await get("?after=0&keys=1", CREATOR, BUSY_SESSION)).json();
    expect(capped.truncated).toBe(true);
    expect(capped.changes).toHaveLength(QUESTION_CHANGES_LIMIT);
    expect(capped.changes[0]).toEqual({
      sequence: 1,
      userId: CREATOR,
      displayName: "Alex",
      questions: [{ key: 1, n: 0 }],
    });
    expect(capped.changes.at(-1).sequence).toBe(QUESTION_CHANGES_LIMIT);

    const rest = (await get(`?after=${QUESTION_CHANGES_LIMIT}&keys=1`, CREATOR, BUSY_SESSION)).json();
    expect(rest).toEqual({
      changes: [{ sequence: total, userId: CREATOR, displayName: "Alex", questions: [{ key: 1, n: total - 1 }] }],
    });
    const exactlyAtLimit = (await get("?after=1&keys=1", CREATOR, BUSY_SESSION)).json();
    expect(exactlyAtLimit.changes).toHaveLength(QUESTION_CHANGES_LIMIT);
    expect(exactlyAtLimit.truncated).toBeUndefined();

    // `until` bounds the page before the cap does.
    const bounded = (await get(`?after=0&until=${QUESTION_CHANGES_LIMIT}&keys=1`, CREATOR, BUSY_SESSION)).json();
    expect(bounded.changes).toHaveLength(QUESTION_CHANGES_LIMIT);
    expect(bounded.truncated).toBeUndefined();
    const boundedCapped = (await get(`?after=0&until=${total}&keys=1`, CREATOR, BUSY_SESSION)).json();
    expect(boundedCapped.changes).toHaveLength(QUESTION_CHANGES_LIMIT);
    expect(boundedCapped.truncated).toBe(true);
    const few = (await get("?after=10&until=12&keys=1", CREATOR, BUSY_SESSION)).json();
    expect(few).toEqual({
      changes: [11, 12].map((sequence) => ({
        sequence,
        userId: CREATOR,
        displayName: "Alex",
        questions: [{ key: 1, n: sequence - 1 }],
      })),
    });
  });

  test("leaves GET /questions as it was", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/sessions/${SESSION}/questions`,
      headers: { cookie: cookies[PLAYER] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().sequence).toBe(await sequenceNow());
  });
});
