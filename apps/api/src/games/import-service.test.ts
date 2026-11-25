import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CASUAL_SERVER_ID } from "@searchlight/shared";
import { type AnySSEEvent, subscribe } from "../lib/broadcaster.js";
import prisma from "../lib/prisma.js";
import {
  ImportConflictError,
  ImportForbiddenError,
  importGameDefinition,
  ImportValidationError,
  pruneGame,
  replaceGameDefinition,
} from "./import-service.js";
import { preloadGameDefinitions } from "./preload.js";

const SERVER_ID = "test-import-svc-server";
const OTHER_SERVER_ID = "test-import-svc-other";
const KEY_PREFIX = "test-import-svc-";
const USER_ID = "test-import-svc-user";

function definition(id: string, name: string, serverId = SERVER_ID) {
  return {
    id,
    name,
    serverId,
    map: {
      center: [0.5, 0.5],
      playArea: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
            },
          },
        ],
      },
    },
    hidingZones: {
      features: {
        type: "FeatureCollection",
        features: [{ type: "Feature", geometry: { type: "Point", coordinates: [0.5, 0.5] } }],
      },
    },
  };
}

// A stub actor who may create games everywhere, and edit them if canEdit.
const actorFor = (userId: string, canEdit = false) => ({
  userId,
  canCreateGames: () => true,
  canEditGames: () => canEdit,
});

// The unique lookup of a game with this key on a real server.
const onServer = (gameKey: string, serverId = SERVER_ID) => ({
  serverId_ownerScope_gameKey: { serverId, ownerScope: "", gameKey },
});

// Casual Games is a fixed server: created if missing, never deleted.
const ensureCasualServer = () =>
  prisma.server.createMany({
    data: [{ id: CASUAL_SERVER_ID, name: "Casual Games" }],
    skipDuplicates: true,
  });

async function revisionsOf(gameKey: string) {
  return prisma.gameRevision.findMany({
    where: { game: { gameKey } },
    orderBy: { revision: "asc" },
    select: { id: true, revision: true, checksum: true, definition: true },
  });
}

async function cleanup() {
  const games = { gameKey: { startsWith: KEY_PREFIX } };
  const ids = (await prisma.game.findMany({ where: games, select: { id: true } })).map((g) => g.id);
  await prisma.auditLog.deleteMany({ where: { targetId: { in: ids } } });
  await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
  await prisma.gameSession.deleteMany({ where: { game: games } });
  await prisma.gameRevision.deleteMany({ where: { game: games } });
  await prisma.game.deleteMany({ where: games });
  await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
  await prisma.user.deleteMany({ where: { discordId: USER_ID } });
}

describe("importGameDefinition revisions", () => {
  beforeAll(async () => {
    await cleanup();
    await prisma.server.createMany({
      data: [
        { id: SERVER_ID, name: "Import Service Server" },
        { id: OTHER_SERVER_ID, name: "Import Service Other" },
      ],
    });
    await ensureCasualServer();
    await prisma.user.create({
      data: {
        discordId: USER_ID,
        username: "import-svc",
        displayName: "Import Svc",
        avatarUrl: "",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });

  afterAll(cleanup);

  test("re-importing content identical to an older revision re-activates it", async () => {
    const key = `${KEY_PREFIX}reactivate`;
    const a = await importGameDefinition({ raw: definition(key, "A") });
    const b = await importGameDefinition({ raw: definition(key, "B"), allowUpdate: true });
    expect([a.status, a.revision, b.status, b.revision]).toEqual(["created", 1, "updated", 2]);

    const again = await importGameDefinition({ raw: definition(key, "A"), allowUpdate: true });
    expect(again).toMatchObject({ status: "updated", revision: 1, checksum: a.checksum });
    const [rev1, rev2] = await revisionsOf(key);
    const game = await prisma.game.findUniqueOrThrow({ where: onServer(key) });
    expect(game.currentRevisionId).toBe(rev1.id);
    expect(game.name).toBe("A");

    // New content still gets a fresh number, and revision 2 keeps its content.
    const c = await importGameDefinition({ raw: definition(key, "C"), allowUpdate: true });
    expect(c).toMatchObject({ status: "updated", revision: 3 });
    const after = await revisionsOf(key);
    expect(after.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(after[1]).toEqual(rev2);
  });

  test("tells the game's open sessions when its current revision changes", async () => {
    const key = `${KEY_PREFIX}announce`;
    const { gameId } = await importGameDefinition({ raw: definition(key, "A") });
    const [rev1] = await revisionsOf(key);
    const session = await prisma.gameSession.create({
      data: { gameId, serverId: SERVER_ID, creatorId: USER_ID, name: "S", gameRevisionId: rev1.id },
    });
    const events: AnySSEEvent[] = [];
    const unsubscribe = subscribe(session.id, (event) => events.push(event));
    try {
      await importGameDefinition({ raw: definition(key, "A"), allowUpdate: true });
      await importGameDefinition({ raw: definition(key, "B"), allowUpdate: true });
    } finally {
      unsubscribe();
    }
    const [, rev2] = await revisionsOf(key);
    expect(events).toEqual([
      { type: "game.revision-changed", payloadJson: { gameRevisionId: rev2.id, revision: 2 } },
    ]);
  });

  test("concurrent updates each add their own revision and never rewrite one", async () => {
    const key = `${KEY_PREFIX}concurrent`;
    await importGameDefinition({ raw: definition(key, "Base") });

    const results = await Promise.all(
      ["X", "Y", "Z"].map((name) =>
        importGameDefinition({ raw: definition(key, name), allowUpdate: true }),
      ),
    );

    const revisions = await revisionsOf(key);
    expect(revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    for (const result of results) {
      const row = revisions.find((r) => r.revision === result.revision);
      expect(row?.checksum).toBe(result.checksum);
    }
  });

  test("racing creations of the same new game add a revision instead of failing", async () => {
    const key = `${KEY_PREFIX}new-race`;
    const results = await Promise.all(
      ["P", "Q"].map((name) =>
        importGameDefinition({ raw: definition(key, name), allowUpdate: true }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual(["created", "updated"]);
    expect((await revisionsOf(key)).map((r) => r.revision)).toEqual([1, 2]);
  });

  test("a lost creation race without allowUpdate is a conflict, not a database error", async () => {
    const key = `${KEY_PREFIX}new-race-conflict`;
    const results = await Promise.allSettled(
      ["P", "Q"].map((name) => importGameDefinition({ raw: definition(key, name) })),
    );

    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBeLessThanOrEqual(1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(ImportConflictError);
    }
  });

  test("the same id on another server is a different game", async () => {
    const key = `${KEY_PREFIX}owned`;
    const owned = await importGameDefinition({ raw: definition(key, "Owned") });

    const other = await importGameDefinition({
      raw: definition(key, "Other", OTHER_SERVER_ID),
      allowUpdate: true,
    });
    expect(other.status).toBe("created");
    expect(other.gameId).not.toBe(owned.gameId);
    expect(await prisma.game.count({ where: { gameKey: key } })).toBe(2);

    const game = await prisma.game.findUniqueOrThrow({
      where: onServer(key),
      include: { _count: { select: { revisions: true } } },
    });
    expect(game).toMatchObject({ name: "Owned", _count: { revisions: 1 } });
  });

  test("racing creations inside one Casual creator's scope add a revision instead of failing", async () => {
    const key = `${KEY_PREFIX}casual-race`;
    const user = `${KEY_PREFIX}user-a`;
    const results = await Promise.all(
      ["P", "Q"].map((name) =>
        importGameDefinition({
          raw: definition(key, name, CASUAL_SERVER_ID),
          actor: actorFor(user),
          allowUpdate: true,
        }),
      ),
    );

    expect(results.map((r) => r.status).sort()).toEqual(["created", "updated"]);
    const games = await prisma.game.findMany({ where: { gameKey: key } });
    expect(games).toHaveLength(1);
    expect(games[0].ownerScope).toBe(user);
    // Revision 1 went: nothing uses it.
    expect((await revisionsOf(key)).map((r) => r.revision)).toEqual([2]);
  });

  test("two Casual creators can use the same id", async () => {
    const key = `${KEY_PREFIX}casual-shared`;
    const [userA, userB] = [`${KEY_PREFIX}user-a`, `${KEY_PREFIX}user-b`];
    const a = await importGameDefinition({
      raw: definition(key, "A", CASUAL_SERVER_ID),
      actor: actorFor(userA),
    });
    const b = await importGameDefinition({
      raw: definition(key, "B", CASUAL_SERVER_ID),
      actor: actorFor(userB),
    });
    expect([a.status, b.status]).toEqual(["created", "created"]);
    expect(b.gameId).not.toBe(a.gameId);
    for (const [result, user] of [
      [a, userA],
      [b, userB],
    ] as const) {
      const game = await prisma.game.findUniqueOrThrow({ where: { id: result.gameId } });
      expect(game).toMatchObject({ ownerScope: user, createdById: user });
    }

    const again = await importGameDefinition({
      raw: definition(key, "A v2", CASUAL_SERVER_ID),
      actor: actorFor(userA),
      allowUpdate: true,
    });
    expect(again).toMatchObject({ status: "updated", gameId: a.gameId });
  });

  test("refuses a revision-pinned import with GAME_CHANGED when the game was deleted after preview", async () => {
    const key = `${KEY_PREFIX}deleted-after-preview`;
    const created = await importGameDefinition({ raw: definition(key, "Before delete") });
    const preview = await importGameDefinition({
      raw: definition(key, "After edit"),
      dryRun: true,
      allowUpdate: true,
    });
    const previewedRevisionId = preview.existing?.currentRevisionId;
    expect(previewedRevisionId).toBeTruthy();

    await prisma.game.update({ where: { id: created.gameId }, data: { currentRevisionId: null } });
    await prisma.gameRevision.deleteMany({ where: { gameId: created.gameId } });
    await prisma.game.delete({ where: { id: created.gameId } });

    await expect(
      importGameDefinition({
        raw: definition(key, "After edit"),
        allowUpdate: true,
        expectedCurrentRevisionId: previewedRevisionId!,
      }),
    ).rejects.toMatchObject({
      name: "ImportConflictError",
      code: "GAME_CHANGED",
      statusCode: 409,
    });

    expect(await prisma.game.findUnique({ where: onServer(key) })).toBeNull();
  });

  describe("replaceGameDefinition", () => {
    // A game on SERVER_ID made by an actor-less import, as the replace route
    // loads it.
    async function createGame(key: string) {
      const { gameId } = await importGameDefinition({ raw: definition(key, "Original") });
      return prisma.game.findUniqueOrThrow({
        where: { id: gameId },
        select: { id: true, gameKey: true, serverId: true, createdById: true, currentRevisionId: true },
      });
    }

    test("refuses someone who can't update the game before validating", async () => {
      const game = await createGame(`${KEY_PREFIX}replace-forbidden`);
      const attempt = replaceGameDefinition({ game, raw: {}, actor: actorFor("u", false) });
      await expect(attempt).rejects.toBeInstanceOf(ImportForbiddenError);
      await expect(attempt).rejects.not.toBeInstanceOf(ImportValidationError);
    });

    test("returns a clean 400 ImportValidationError at / for non-object bodies", async () => {
      const game = await createGame(`${KEY_PREFIX}replace-non-obj`);
      for (const raw of ["hello", [1, 2], null]) {
        try {
          await replaceGameDefinition({ game, raw, actor: actorFor("u", true) });
          expect.unreachable(`expected ImportValidationError for ${JSON.stringify(raw)}`);
        } catch (err) {
          expect(err).toBeInstanceOf(ImportValidationError);
          const validationErr = err as ImportValidationError;
          expect(validationErr.statusCode).toBe(400);
          expect(validationErr.errors).toEqual([
            { path: "/", code: "SCHEMA_VALIDATION_ERROR", message: "Expected object" },
          ]);
        }
      }
    });
  });
});

describe("revision pruning", () => {
  const USER = `${KEY_PREFIX}pruner`;
  const casual = (key: string, name: string) => ({
    raw: definition(key, name, CASUAL_SERVER_ID),
    actor: actorFor(USER),
    allowUpdate: true,
  });
  const gameOf = (key: string) =>
    prisma.game.findFirstOrThrow({ where: { gameKey: key }, include: { revisions: true } });
  const numbers = async (key: string) => (await revisionsOf(key)).map((r) => r.revision);

  async function sessionOn(key: string, revision: number) {
    const game = await gameOf(key);
    return prisma.gameSession.create({
      data: {
        gameId: game.id,
        serverId: game.serverId,
        creatorId: USER,
        name: "Pinning",
        gameRevisionId: game.revisions.find((r) => r.revision === revision)!.id,
      },
    });
  }

  // A fork link of the session, its snapshot on the given revision.
  async function forkLinkOn(key: string, sessionId: string, revision: number, revoked = false) {
    const game = await gameOf(key);
    await prisma.sessionLink.create({
      data: {
        token: `${KEY_PREFIX}${key}-${revision}`,
        sessionId,
        createdById: USER,
        linkType: "fork",
        revokedAt: revoked ? new Date() : null,
        snapshot: {
          create: {
            questions: [],
            gameRevisionId: game.revisions.find((r) => r.revision === revision)!.id,
          },
        },
      },
    });
  }

  async function cleanupPruning() {
    await prisma.gameSession.deleteMany({ where: { creatorId: USER } });
    await cleanup();
    await prisma.user.deleteMany({ where: { discordId: USER } });
  }

  beforeAll(async () => {
    await cleanupPruning();
    await prisma.server.createMany({ data: [{ id: SERVER_ID, name: "Import Service Server" }] });
    await ensureCasualServer();
    await prisma.user.create({
      data: {
        discordId: USER,
        username: USER,
        displayName: USER,
        avatarUrl: "https://example.com/a.png",
        discordAccessToken: "tok",
        discordRefreshToken: "ref",
        discordTokenExpiresAt: new Date(Date.now() + 86_400_000),
      },
    });
  });

  afterAll(cleanupPruning);

  test("an update of a Casual game deletes the older revisions nothing uses", async () => {
    const key = `${KEY_PREFIX}prune-casual`;
    await importGameDefinition(casual(key, "R1"));
    const session = await sessionOn(key, 1);
    await importGameDefinition(casual(key, "R2"));
    await forkLinkOn(key, session.id, 2);
    await importGameDefinition(casual(key, "R3"));
    await forkLinkOn(key, session.id, 3, true);
    await importGameDefinition(casual(key, "R4"));
    expect(await numbers(key)).toEqual([1, 2, 4]);

    await importGameDefinition(casual(key, "R5"));
    // 1: a session's; 2: an active fork link's; 3 (a revoked link's) and 4: unused.
    expect(await numbers(key)).toEqual([1, 2, 5]);
  });

  test("an official game keeps every revision, with no prune run", async () => {
    const key = `${KEY_PREFIX}prune-official`;
    // The prune's deletes, also within a transaction.
    const executeRaw = vi.spyOn(prisma, "$executeRaw");
    try {
      for (const name of ["A", "B", "C"]) {
        await importGameDefinition({ raw: definition(key, name), allowUpdate: true });
      }
      // As after a session delete.
      const { id } = await gameOf(key);
      await prisma.$transaction((tx) => pruneGame(tx, id));
      expect(executeRaw).not.toHaveBeenCalled();
    } finally {
      executeRaw.mockRestore();
    }
    expect(await numbers(key)).toEqual([1, 2, 3]);
  });

  test("a re-activated revision keeps the highest, so its number isn't used again", async () => {
    const key = `${KEY_PREFIX}prune-numbers`;
    const first = await importGameDefinition(casual(key, "A"));
    await sessionOn(key, 1);
    await importGameDefinition(casual(key, "B"));
    const again = await importGameDefinition(casual(key, "A"));
    expect(again).toMatchObject({ revision: 1, checksum: first.checksum });
    expect(await numbers(key)).toEqual([1, 2]);

    expect(await importGameDefinition(casual(key, "C"))).toMatchObject({ revision: 3 });
    expect(await numbers(key)).toEqual([1, 3]);
  });

  test("an update of a deleted game is GAME_DELETED, before a stale preview's GAME_CHANGED", async () => {
    const key = `${KEY_PREFIX}prune-deleted`;
    const { gameId } = await importGameDefinition(casual(key, "A"));
    await prisma.game.update({ where: { id: gameId }, data: { archivedAt: new Date() } });
    const game = await prisma.game.findUniqueOrThrow({ where: { id: gameId } });
    await expect(
      replaceGameDefinition({
        game,
        raw: definition(key, "B", CASUAL_SERVER_ID),
        actor: actorFor(USER),
        expectedCurrentRevisionId: "not-current",
      }),
    ).rejects.toMatchObject({ code: "GAME_DELETED", statusCode: 409 });
  });
});

describe("preloadGameDefinitions", () => {
  let dir: string;

  beforeAll(async () => {
    await cleanup();
    await prisma.server.create({ data: { id: SERVER_ID, name: "Import Service Server" } });
    await ensureCasualServer();
    dir = await mkdtemp(join(tmpdir(), "searchlight-preload-"));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await cleanup();
  });

  test("logs and skips a failing file instead of aborting the remaining ones", async () => {
    const key = `${KEY_PREFIX}preload`;
    await writeFile(join(dir, "a-broken.game.json"), "{ not json");
    await writeFile(
      join(dir, "b-misnamed.game.json"),
      JSON.stringify(definition(`${KEY_PREFIX}other-name`, "Misnamed")),
    );
    await writeFile(join(dir, `${key}.game.json`), JSON.stringify(definition(key, "Preloaded")));

    const summary = await preloadGameDefinitions(dir);

    expect(summary).toMatchObject({ total: 1, created: 1 });
    expect(summary.failures.map((f) => f.fileName)).toEqual([
      "a-broken.game.json",
      "b-misnamed.game.json",
    ]);
    expect(await prisma.game.findUnique({ where: onServer(key) })).not.toBeNull();
  });

  test("fails on a directory it can't read", async () => {
    await expect(preloadGameDefinitions(join(dir, "missing"))).rejects.toThrow("ENOENT");
  });

  // A directory holding only the given game's file; start(name) writes it
  // with that name and preloads, like an API start.
  async function preloadDir(key: string) {
    const gameDir = await mkdtemp(join(dir, "game-"));
    return {
      start: async (name: string) => {
        await writeFile(join(gameDir, `${key}.game.json`), JSON.stringify(definition(key, name)));
        return preloadGameDefinitions(gameDir);
      },
      current: () =>
        prisma.game.findUniqueOrThrow({
          where: onServer(key),
          include: { currentRevision: { select: { revision: true, checksum: true } } },
        }),
    };
  }

  test("an upload survives restarts until the file's content changes", async () => {
    const key = `${KEY_PREFIX}preload-upload`;
    const { start, current } = await preloadDir(key);

    const first = await start("Preloaded");
    expect(first).toMatchObject({ created: 1 });
    expect((await current()).preloadChecksum).toBe(first.results[0].checksum);

    const upload = await importGameDefinition({
      raw: definition(key, "Uploaded"),
      source: "web",
      allowUpdate: true,
    });
    expect(upload).toMatchObject({ status: "updated", revision: 2 });

    // The next start finds the file unchanged and keeps the upload.
    const restart = await start("Preloaded");
    expect(restart).toMatchObject({ unchanged: 0, updated: 0 });
    expect(restart.kept).toEqual([{ fileName: `${key}.game.json`, revision: 2 }]);
    expect(await current()).toMatchObject({ name: "Uploaded", currentRevision: { revision: 2 } });

    // New file content becomes the next revision, replacing the upload.
    const changed = await start("Preloaded v3");
    expect(changed).toMatchObject({ updated: 1, kept: [] });
    expect(await current()).toMatchObject({
      name: "Preloaded v3",
      preloadChecksum: changed.results[0].checksum,
      currentRevision: { revision: 3 },
    });
    expect(await start("Preloaded v3")).toMatchObject({ unchanged: 1, kept: [] });

    // Logged once per change: the restarts that changed nothing add nothing.
    const log = await prisma.auditLog.findMany({
      where: { targetId: (await current()).id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(log.map((e) => [e.action, e.details])).toEqual([
      ["game.create", { revision: 1, source: "preload" }],
      [
        "game.revision",
        { revision: 2, source: "web", name: { from: "Preloaded", to: "Uploaded" } },
      ],
      [
        "game.revision",
        { revision: 3, source: "preload", name: { from: "Uploaded", to: "Preloaded v3" } },
      ],
    ]);
    expect(log.every((e) => e.actorId === null)).toBe(true);
  });

  test("a rollback by upload to an older preloaded revision survives restarts", async () => {
    const key = `${KEY_PREFIX}preload-rollback`;
    const { start, current } = await preloadDir(key);
    await start("A");
    await start("B");
    expect(await current()).toMatchObject({ currentRevision: { revision: 2 } });

    // Uploading A again re-activates revision 1, which the preload created.
    const rollback = await importGameDefinition({
      raw: definition(key, "A"),
      source: "web",
      allowUpdate: true,
    });
    expect(rollback).toMatchObject({ status: "updated", revision: 1 });

    const restart = await start("B");
    expect(restart.kept).toEqual([{ fileName: `${key}.game.json`, revision: 1 }]);
    expect(await current()).toMatchObject({ name: "A", currentRevision: { revision: 1 } });
  });

  test("reverting the file to older content re-activates that revision", async () => {
    const key = `${KEY_PREFIX}preload-revert`;
    const { start, current } = await preloadDir(key);
    const a = await start("A");
    await start("B");

    const reverted = await start("A");
    expect(reverted).toMatchObject({ updated: 1, kept: [] });
    expect(await current()).toMatchObject({
      name: "A",
      preloadChecksum: a.results[0].checksum,
      currentRevision: { revision: 1, checksum: a.results[0].checksum },
    });
    expect((await revisionsOf(key)).map((r) => r.revision)).toEqual([1, 2]);
  });

  // A preload has no actor, so a Casual file could never find its creator's
  // game: it would add a copy on every start.
  test("a Casual file is refused and never duplicates its creator's game", async () => {
    const key = `${KEY_PREFIX}preload-casual`;
    await importGameDefinition({
      raw: definition(key, "Owned", CASUAL_SERVER_ID),
      actor: actorFor(`${KEY_PREFIX}owner`),
    });
    const gameDir = await mkdtemp(join(dir, "casual-"));
    await writeFile(
      join(gameDir, `${key}.game.json`),
      JSON.stringify(definition(key, "Preloaded", CASUAL_SERVER_ID)),
    );

    for (let start = 0; start < 2; start++) {
      const summary = await preloadGameDefinitions(gameDir);
      expect(summary.failures.map((f) => f.fileName)).toEqual([`${key}.game.json`]);
      expect(summary.created).toBe(0);
    }
    const games = await prisma.game.findMany({
      where: { gameKey: key },
      include: { _count: { select: { revisions: true } } },
    });
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ name: "Owned", _count: { revisions: 1 } });
  });
});
