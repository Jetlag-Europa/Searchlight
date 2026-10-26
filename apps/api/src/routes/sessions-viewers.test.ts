import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import prisma from "../lib/prisma.js";
import { broadcast, connectedUserIds } from "../lib/broadcaster.js";
import { sessionRoutes } from "./sessions.js";
import { sessionContentRoutes } from "./session-content.js";
import { eventRoutes } from "./events.js";
import { linkRoutes } from "./links.js";
import { gameImportRoutes } from "./game-imports.js";

// ── IDs scoped to this test suite ───────────────────────────────────────────
const CREATOR_ID = "test-sview-creator";
const MEMBER_ID = "test-sview-member";
const VIEWER_ID = "test-sview-viewer";
const OUTSIDER_ID = "test-sview-outsider";
const USER_IDS = [CREATOR_ID, MEMBER_ID, VIEWER_ID, OUTSIDER_ID];
const SERVER_ID = "test-sview-server";
const GAME_ID = "test-sview-game";
const SESSION_ID = "test-sview-session";

async function buildTestApp() {
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  await app.register(fastifyCookie, {
    secret: process.env["SESSION_COOKIE_SECRET"]!,
  });
  await app.register(sessionRoutes, { prefix: "/sessions" });
  await app.register(sessionContentRoutes, { prefix: "/sessions" });
  await app.register(eventRoutes, { prefix: "/sessions" });
  await app.register(linkRoutes, { prefix: "/links" });
  await app.register(gameImportRoutes, { prefix: "/games" });
  await app.ready();
  return app;
}

async function deleteSessions() {
  const where = { gameId: GAME_ID };
  const ids = (await prisma.gameSession.findMany({ where, select: { id: true } })).map((s) => s.id);
  await prisma.sessionLink.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.sessionQuestion.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.stroke.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.event.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.sessionParticipant.deleteMany({ where: { sessionId: { in: ids } } });
  await prisma.gameSession.deleteMany({ where });
}

async function cleanup() {
  await deleteSessions();
  await prisma.authSession.deleteMany({ where: { userId: { in: USER_IDS } } });
  await prisma.serverMembershipCache.deleteMany({ where: { serverId: SERVER_ID } });
  await prisma.game.updateMany({ where: { id: GAME_ID }, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { gameId: GAME_ID } });
  await prisma.game.deleteMany({ where: { id: GAME_ID } });
  await prisma.server.deleteMany({ where: { id: SERVER_ID } });
  await prisma.user.deleteMany({ where: { discordId: { in: USER_IDS } } });
}

// An SSE stream on a real socket: inject() only resolves once a stream ends.
interface Stream {
  res: IncomingMessage;
  events: () => Array<{ type: string; payloadJson: unknown; sequence?: number }>;
  ended: Promise<void>;
}

describe("session viewers", () => {
  let app: FastifyInstance;
  let revisionId: string;
  const cookies: Record<string, string> = {};
  const as = (userId: string) => ({ cookie: cookies[userId] });

  beforeAll(async () => {
    await cleanup();
    app = await buildTestApp();

    for (const discordId of USER_IDS) {
      await prisma.user.create({
        data: {
          discordId,
          username: discordId,
          displayName: discordId,
          avatarUrl: "https://example.com/a.png",
          discordAccessToken: "tok",
          discordRefreshToken: "ref",
          discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
        },
      });
      const auth = await prisma.authSession.create({
        data: { id: `${discordId}-auth`, userId: discordId, expiresAt: new Date(Date.now() + 86_400_000) },
      });
      cookies[discordId] = `session=${app.signCookie(auth.id)}`;
    }

    await prisma.server.create({ data: { id: SERVER_ID, name: "Viewer Server" } });
    await prisma.game.create({
      data: { id: GAME_ID, serverId: SERVER_ID, name: "Viewer Game", gameKey: "sview-game", size: "medium" },
    });
    const rev = await prisma.gameRevision.create({
      data: {
        gameId: GAME_ID,
        revision: 1,
        checksum: "sview-rev-checksum",
        definition: { id: "sview-game", name: "Viewer Game", serverId: SERVER_ID },
      },
    });
    revisionId = rev.id;
    await prisma.game.update({ where: { id: GAME_ID }, data: { currentRevisionId: rev.id } });

    // Nobody but the session's participants may read the game: these answer
    // the membership check without calling Discord.
    await prisma.serverMembershipCache.createMany({
      data: USER_IDS.map((userId) => ({ userId, serverId: SERVER_ID, isMember: false, cachedAt: new Date() })),
    });
  });

  // Every test starts from a fresh shared session with a creator, a member
  // and a viewer, with the hider placed.
  beforeEach(async () => {
    await deleteSessions();
    await prisma.gameSession.create({
      data: {
        id: SESSION_ID,
        gameId: GAME_ID,
        serverId: SERVER_ID,
        creatorId: CREATOR_ID,
        name: "Viewer Session",
        visibility: "shared",
        gameRevisionId: revisionId,
        hiderLat: 47.37,
        hiderLng: 8.54,
        participants: {
          create: [
            { userId: CREATOR_ID, role: "creator", acceptedAt: new Date() },
            { userId: MEMBER_ID, role: "member", acceptedAt: new Date() },
            { userId: VIEWER_ID, role: "viewer", acceptedAt: new Date() },
          ],
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
    await prisma.$disconnect();
  });

  async function createLink(linkType: "join" | "view" | "fork", sessionId = SESSION_ID) {
    const res = await app.inject({
      method: "POST",
      url: `/sessions/${sessionId}/links`,
      headers: as(CREATOR_ID),
      payload: { linkType },
    });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: string; token: string }>();
  }

  const redeem = (token: string, userId: string) =>
    app.inject({ method: "POST", url: `/links/${token}/redeem`, headers: as(userId) });

  const participantRow = (userId: string) =>
    prisma.sessionParticipant.findUnique({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId } },
    });

  const getSession = (userId: string) =>
    app.inject({ method: "GET", url: `/sessions/${SESSION_ID}`, headers: as(userId) });

  async function openStream(userId: string): Promise<Stream> {
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      get({ host: "127.0.0.1", port, path: `/sessions/${SESSION_ID}/stream`, headers: as(userId) }, resolve).on(
        "error",
        reject,
      );
    });
    expect(res.statusCode).toBe(200);
    let text = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      text += chunk;
    });
    const ended = new Promise<void>((resolve) => res.on("end", resolve));
    await vi.waitFor(() => expect(connectedUserIds().get(SESSION_ID) ?? []).toContain(userId));
    return {
      res,
      ended,
      events: () =>
        text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => JSON.parse(line.slice(6))),
    };
  }

  function broadcastHiderUpdate(sequence: number) {
    broadcast(SESSION_ID, {
      id: `test-sview-ev-${sequence}`,
      sessionId: SESSION_ID,
      userId: MEMBER_ID,
      sequence,
      type: "hider.update",
      payloadJson: { hiderLat: 1.5, hiderLng: 2.5 },
      clientUuid: `test-sview-hider-${sequence}`,
      clientCreatedAt: new Date().toISOString(),
      serverReceivedAt: new Date().toISOString(),
    });
  }

  // ── View links ──────────────────────────────────────────────────────────────

  test("the creator creates, lists and revokes a view link, which makes a private session shared", async () => {
    await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { visibility: "private" } });
    const link = await createLink("view");

    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
    expect(session.visibility).toBe("shared");
    // Live, like a join link: no snapshot.
    expect(await prisma.linkSnapshot.count({ where: { linkId: link.id } })).toBe(0);

    const info = await app.inject({ method: "GET", url: `/links/${link.token}` });
    expect(info.json()).toMatchObject({ valid: true, sessionName: "Viewer Session", linkType: "view" });

    const list = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/links`, headers: as(CREATOR_ID) });
    expect(list.json().links).toEqual([
      expect.objectContaining({ id: link.id, token: link.token, linkType: "view" }),
    ]);

    const revoke = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/links/${link.id}`,
      headers: as(CREATOR_ID),
    });
    expect(revoke.statusCode).toBe(204);
    expect((await redeem(link.token, OUTSIDER_ID)).statusCode).toBe(404);
  });

  test("only the creator can create view links", async () => {
    for (const userId of [MEMBER_ID, VIEWER_ID]) {
      const res = await app.inject({
        method: "POST",
        url: `/sessions/${SESSION_ID}/links`,
        headers: as(userId),
        payload: { linkType: "view" },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  test("redeeming a view link makes a newcomer a viewer", async () => {
    await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { visibility: "private" } });
    const { token } = await createLink("view");
    // Made private again after the link, as PATCH lets the creator do.
    await prisma.gameSession.update({ where: { id: SESSION_ID }, data: { visibility: "private" } });

    const res = await redeem(token, OUTSIDER_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "view" });
    expect(await participantRow(OUTSIDER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
    expect((await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } })).visibility).toBe("shared");

    const session = await getSession(OUTSIDER_ID);
    expect(session.statusCode).toBe(200);
    expect(session.json().role).toBe("viewer");
    expect(session.json().participants).toContainEqual(
      expect.objectContaining({ userId: OUTSIDER_ID, role: "viewer" }),
    );
  });

  test("the creator opening their view link just goes to the session", async () => {
    const { token } = await createLink("view");
    const res = await redeem(token, CREATOR_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "view" });
    expect(await participantRow(CREATOR_ID)).toMatchObject({ role: "creator" });
  });

  test("a view link never demotes a member, and a viewer stays a viewer", async () => {
    const { token } = await createLink("view");
    const before = await participantRow(MEMBER_ID);

    expect((await redeem(token, MEMBER_ID)).json()).toEqual({ sessionId: SESSION_ID, linkType: "view" });
    expect(await participantRow(MEMBER_ID)).toEqual(before);

    expect((await redeem(token, VIEWER_ID)).statusCode).toBe(200);
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
  });

  test("a kicked member who opens a view link comes back as a viewer", async () => {
    const kick = await app.inject({
      method: "DELETE",
      url: `/sessions/${SESSION_ID}/participants/${MEMBER_ID}`,
      headers: as(CREATOR_ID),
    });
    expect(kick.statusCode).toBe(204);
    const { token } = await createLink("view");

    expect((await redeem(token, MEMBER_ID)).statusCode).toBe(200);
    expect(await participantRow(MEMBER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
    expect((await getSession(MEMBER_ID)).json().role).toBe("viewer");
  });

  test("a join link leaves a viewer a viewer, but brings a kicked viewer back as a member", async () => {
    const { token } = await createLink("join");

    const res = await redeem(token, VIEWER_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "join" });
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
    expect((await getSession(VIEWER_ID)).json()).toMatchObject({ role: "viewer", hiderLat: null, hiderLng: null });

    await prisma.sessionParticipant.update({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: VIEWER_ID } },
      data: { revokedAt: new Date() },
    });
    expect((await redeem(token, VIEWER_ID)).statusCode).toBe(200);
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "member", revokedAt: null });
  });

  test("a member made a viewer can't make themselves a member again with the join link", async () => {
    const { token } = await createLink("join");
    expect((await redeem(token, OUTSIDER_ID)).statusCode).toBe(200);
    expect(await participantRow(OUTSIDER_ID)).toMatchObject({ role: "member" });

    expect((await setRole(OUTSIDER_ID, "viewer")).statusCode).toBe(200);
    const res = await redeem(token, OUTSIDER_ID);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: SESSION_ID, linkType: "join" });
    expect(await participantRow(OUTSIDER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
  });

  test("a viewer opening a fork link gets a copy without the hider position", async () => {
    const { token } = await createLink("fork");
    const res = await redeem(token, VIEWER_ID);
    expect(res.statusCode).toBe(200);
    const { sessionId, linkType } = res.json<{ sessionId: string; linkType: string }>();
    expect(linkType).toBe("fork");
    expect(sessionId).not.toBe(SESSION_ID);

    const copy = await prisma.gameSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(copy).toMatchObject({ creatorId: VIEWER_ID, hiderLat: null, hiderLng: null, eventSequence: 0 });
    expect(await prisma.event.count({ where: { sessionId } })).toBe(0);
    const asOwner = await app.inject({ method: "GET", url: `/sessions/${sessionId}`, headers: as(VIEWER_ID) });
    expect(asOwner.json()).toMatchObject({ role: "creator", hiderLat: null, hiderLng: null });
    // The original is unchanged, and they are still its viewer.
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "viewer", revokedAt: null });
  });

  // ── Writes ──────────────────────────────────────────────────────────────────

  test("viewers can't change the session", async () => {
    await prisma.stroke.create({
      data: { sessionId: SESSION_ID, userId: MEMBER_ID, clientUuid: "test-sview-stroke", payloadJson: {} },
    });
    const writes = [
      { method: "PATCH", url: `/sessions/${SESSION_ID}`, payload: { hiderLat: 1, hiderLng: 2 } },
      { method: "PATCH", url: `/sessions/${SESSION_ID}`, payload: { hiderLat: null, hiderLng: null } },
      { method: "PATCH", url: `/sessions/${SESSION_ID}`, payload: { planningModeEnabled: true } },
      { method: "PATCH", url: `/sessions/${SESSION_ID}`, payload: { name: "Renamed" } },
      { method: "PATCH", url: `/sessions/${SESSION_ID}`, payload: {} },
      {
        method: "POST",
        url: `/sessions/${SESSION_ID}/strokes`,
        payload: { clientUuid: "test-sview-new-stroke", payloadJson: { a: 1 } },
      },
      { method: "DELETE", url: `/sessions/${SESSION_ID}/strokes/test-sview-stroke` },
      {
        method: "PUT",
        url: `/sessions/${SESSION_ID}/questions`,
        payload: { questions: [{ clientUuid: "q1", ordinal: 0, payloadJson: {} }], replacementId: "test-sview-r1" },
      },
      { method: "POST", url: `/sessions/${SESSION_ID}/links`, payload: { linkType: "join" } },
      { method: "POST", url: `/sessions/${SESSION_ID}/upgrade-revision` },
      { method: "DELETE", url: `/sessions/${SESSION_ID}/participants/${MEMBER_ID}` },
      { method: "PATCH", url: `/sessions/${SESSION_ID}/participants/${MEMBER_ID}`, payload: { role: "viewer" } },
      { method: "DELETE", url: `/sessions/${SESSION_ID}` },
    ] as const;
    for (const write of writes) {
      const res = await app.inject({ ...write, headers: as(VIEWER_ID) });
      expect(res.statusCode, `${write.method} ${write.url}`).toBe(403);
    }
    // The four routes members may use say why.
    const patch = await app.inject({ ...writes[0], headers: as(VIEWER_ID) });
    expect(patch.json().message ?? patch.body).toContain("Spectators can't change this session");

    const session = await prisma.gameSession.findUniqueOrThrow({ where: { id: SESSION_ID } });
    expect(session).toMatchObject({ hiderLat: 47.37, hiderLng: 8.54, planningModeEnabled: false, eventSequence: 0 });
    expect(await prisma.event.count({ where: { sessionId: SESSION_ID } })).toBe(0);
    expect(await prisma.stroke.findUnique({ where: { clientUuid: "test-sview-stroke" } })).toMatchObject({
      deletedAt: null,
    });
    expect(await prisma.stroke.count({ where: { clientUuid: "test-sview-new-stroke" } })).toBe(0);
    expect(await prisma.sessionQuestion.count({ where: { sessionId: SESSION_ID } })).toBe(0);
    expect(await participantRow(MEMBER_ID)).toMatchObject({ role: "member", revokedAt: null });
  });

  test("viewers read the session's content", async () => {
    for (const url of ["strokes", "questions", "events", "events/cursor"]) {
      const res = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/${url}`, headers: as(VIEWER_ID) });
      expect(res.statusCode, url).toBe(200);
    }
  });

  test("a viewer can leave", async () => {
    const res = await app.inject({ method: "DELETE", url: `/sessions/${SESSION_ID}/leave`, headers: as(VIEWER_ID) });
    expect(res.statusCode).toBe(204);
    expect((await participantRow(VIEWER_ID))!.revokedAt).not.toBeNull();
    expect((await getSession(VIEWER_ID)).statusCode).toBe(403);
  });

  // ── The hider's position ────────────────────────────────────────────────────

  test("session responses leave out the hider's position for viewers", async () => {
    const asViewer = await getSession(VIEWER_ID);
    expect(asViewer.json()).toMatchObject({ role: "viewer", hiderLat: null, hiderLng: null });
    const asMember = await getSession(MEMBER_ID);
    expect(asMember.json()).toMatchObject({ role: "member", hiderLat: 47.37, hiderLng: 8.54 });
    expect((await getSession(CREATOR_ID)).json()).toMatchObject({ role: "creator", hiderLat: 47.37 });

    const list = async (userId: string) => {
      const res = await app.inject({ method: "GET", url: `/sessions?serverId=${SERVER_ID}`, headers: as(userId) });
      return res.json().sessions.find((s: { id: string }) => s.id === SESSION_ID);
    };
    expect(await list(VIEWER_ID)).toMatchObject({ role: "viewer", hiderLat: null, hiderLng: null });
    expect(await list(MEMBER_ID)).toMatchObject({ role: "member", hiderLat: 47.37, hiderLng: 8.54 });
  });

  test("hider updates reach viewers without the position when catching up", async () => {
    // A hider update between two strokes.
    await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/strokes`,
      headers: as(MEMBER_ID),
      payload: { clientUuid: "test-sview-s1", payloadJson: { n: 1 } },
    });
    const patch = await app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}`,
      headers: as(MEMBER_ID),
      payload: { hiderLat: 10, hiderLng: 20 },
    });
    expect(patch.json()).toMatchObject({ role: "member", hiderLat: 10, hiderLng: 20 });
    await app.inject({
      method: "POST",
      url: `/sessions/${SESSION_ID}/strokes`,
      headers: as(MEMBER_ID),
      payload: { clientUuid: "test-sview-s2", payloadJson: { n: 2 } },
    });

    const events = async (userId: string) => {
      const res = await app.inject({ method: "GET", url: `/sessions/${SESSION_ID}/events`, headers: as(userId) });
      return res.json().events as Array<{ sequence: number; type: string; payloadJson: unknown }>;
    };
    const viewerEvents = await events(VIEWER_ID);
    expect(viewerEvents.map((e) => [e.sequence, e.type])).toEqual([
      [1, "stroke.create"],
      [2, "hider.update"],
      [3, "stroke.create"],
    ]);
    expect(viewerEvents[1].payloadJson).toEqual({ hiderLat: null, hiderLng: null });
    expect((await events(MEMBER_ID))[1].payloadJson).toEqual({ hiderLat: 10, hiderLng: 20 });
  });

  test("viewers' streams get hider updates without the position", async () => {
    const viewer = await openStream(VIEWER_ID);
    const member = await openStream(MEMBER_ID);
    try {
      broadcastHiderUpdate(1);
      await vi.waitFor(() => {
        expect(viewer.events()).toContainEqual(
          expect.objectContaining({ type: "hider.update", sequence: 1, payloadJson: { hiderLat: null, hiderLng: null } }),
        );
        expect(member.events()).toContainEqual(
          expect.objectContaining({ type: "hider.update", sequence: 1, payloadJson: { hiderLat: 1.5, hiderLng: 2.5 } }),
        );
      });
    } finally {
      viewer.res.destroy();
      member.res.destroy();
      await vi.waitFor(() => expect(connectedUserIds().get(SESSION_ID) ?? []).toEqual([]));
    }
  });

  // ── Changing roles ──────────────────────────────────────────────────────────

  const setRole = (userId: string, role: string, as_ = CREATOR_ID) =>
    app.inject({
      method: "PATCH",
      url: `/sessions/${SESSION_ID}/participants/${userId}`,
      headers: as(as_),
      payload: { role },
    });

  test("only the creator changes roles, of active participants other than themselves", async () => {
    expect((await setRole(VIEWER_ID, "member", MEMBER_ID)).statusCode).toBe(403);
    expect((await setRole(CREATOR_ID, "viewer")).statusCode).toBe(403);
    expect((await setRole(OUTSIDER_ID, "viewer")).statusCode).toBe(404);
    expect((await setRole(MEMBER_ID, "creator")).statusCode).toBe(400);

    await prisma.sessionParticipant.update({
      where: { sessionId_userId: { sessionId: SESSION_ID, userId: VIEWER_ID } },
      data: { revokedAt: new Date() },
    });
    expect((await setRole(VIEWER_ID, "member")).statusCode).toBe(404);
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "viewer" });
  });

  test("the creator promotes a viewer to member", async () => {
    const res = await setRole(VIEWER_ID, "member");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: VIEWER_ID, role: "member" });
    expect(await participantRow(VIEWER_ID)).toMatchObject({ role: "member" });
    expect((await getSession(VIEWER_ID)).json()).toMatchObject({ role: "member", hiderLat: 47.37 });
  });

  test("demoting a member tells the session, then reopens their stream as a viewer's", async () => {
    const member = await openStream(MEMBER_ID);
    const creator = await openStream(CREATOR_ID);
    try {
      const res = await setRole(MEMBER_ID, "viewer");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ userId: MEMBER_ID, role: "viewer" });
      expect(await participantRow(MEMBER_ID)).toMatchObject({ role: "viewer" });

      const changed = { type: "participant.role-changed", payloadJson: { userId: MEMBER_ID, role: "viewer" } };
      // The member's stream gets the event before it is closed.
      await member.ended;
      expect(member.events()).toContainEqual(changed);
      await vi.waitFor(() => expect(creator.events()).toContainEqual(changed));
      expect(connectedUserIds().get(SESSION_ID)).toEqual([CREATOR_ID]);

      // Reconnected, the stream is a viewer's.
      const reconnected = await openStream(MEMBER_ID);
      try {
        broadcastHiderUpdate(1);
        await vi.waitFor(() =>
          expect(reconnected.events()).toContainEqual(
            expect.objectContaining({ type: "hider.update", payloadJson: { hiderLat: null, hiderLng: null } }),
          ),
        );
      } finally {
        reconnected.res.destroy();
      }
      expect((await getSession(MEMBER_ID)).json()).toMatchObject({ role: "viewer", hiderLat: null });
    } finally {
      member.res.destroy();
      creator.res.destroy();
      await vi.waitFor(() => expect(connectedUserIds().get(SESSION_ID) ?? []).toEqual([]));
    }
  });

  test("setting the role a participant already has changes nothing", async () => {
    const viewer = await openStream(VIEWER_ID);
    try {
      const res = await setRole(VIEWER_ID, "viewer");
      expect(res.json()).toEqual({ userId: VIEWER_ID, role: "viewer" });
      expect(connectedUserIds().get(SESSION_ID)).toContain(VIEWER_ID);
      expect(viewer.events().map((e) => e.type)).not.toContain("participant.role-changed");
    } finally {
      viewer.res.destroy();
      await vi.waitFor(() => expect(connectedUserIds().get(SESSION_ID) ?? []).toEqual([]));
    }
  });

  // ── The game ────────────────────────────────────────────────────────────────

  test("viewers read the revision the session is pinned to, and only through it", async () => {
    const pinned = await app.inject({
      method: "GET",
      url: `/games/revisions/${revisionId}?sessionId=${SESSION_ID}`,
      headers: as(VIEWER_ID),
    });
    expect(pinned.statusCode).toBe(200);
    expect(pinned.json().name).toBe("Viewer Game");

    const direct = await app.inject({ method: "GET", url: `/games/revisions/${revisionId}`, headers: as(VIEWER_ID) });
    expect(direct.statusCode).toBe(403);
  });
});
