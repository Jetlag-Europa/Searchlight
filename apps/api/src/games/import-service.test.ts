import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "../lib/prisma.js";
import {
  ImportConflictError,
  ImportForbiddenError,
  importGameDefinition,
} from "./import-service.js";
import { preloadGameDefinitions } from "./preload.js";

const SERVER_ID = "test-import-svc-server";
const OTHER_SERVER_ID = "test-import-svc-other";
const KEY_PREFIX = "test-import-svc-";

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

async function revisionsOf(gameKey: string) {
  return prisma.gameRevision.findMany({
    where: { game: { gameKey } },
    orderBy: { revision: "asc" },
    select: { id: true, revision: true, checksum: true, definition: true },
  });
}

async function cleanup() {
  const games = { gameKey: { startsWith: KEY_PREFIX } };
  await prisma.game.updateMany({ where: games, data: { currentRevisionId: null } });
  await prisma.gameRevision.deleteMany({ where: { game: games } });
  await prisma.game.deleteMany({ where: games });
  await prisma.server.deleteMany({ where: { id: { in: [SERVER_ID, OTHER_SERVER_ID] } } });
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
    const game = await prisma.game.findUniqueOrThrow({ where: { gameKey: key } });
    expect(game.currentRevisionId).toBe(rev1.id);
    expect(game.name).toBe("A");

    // New content still gets a fresh number, and revision 2 keeps its content.
    const c = await importGameDefinition({ raw: definition(key, "C"), allowUpdate: true });
    expect(c).toMatchObject({ status: "updated", revision: 3 });
    const after = await revisionsOf(key);
    expect(after.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(after[1]).toEqual(rev2);
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

  test("rejects another server's game id without naming that server", async () => {
    const key = `${KEY_PREFIX}owned`;
    await importGameDefinition({ raw: definition(key, "Owned") });

    const attempt = importGameDefinition({
      raw: definition(key, "Hijack", OTHER_SERVER_ID),
      allowUpdate: true,
    });
    await expect(attempt).rejects.toBeInstanceOf(ImportForbiddenError);
    await expect(attempt).rejects.not.toThrow(SERVER_ID);
  });
});

describe("preloadGameDefinitions", () => {
  let dir: string;

  beforeAll(async () => {
    await cleanup();
    await prisma.server.create({ data: { id: SERVER_ID, name: "Import Service Server" } });
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
    expect(await prisma.game.findUnique({ where: { gameKey: key } })).not.toBeNull();
  });
});
