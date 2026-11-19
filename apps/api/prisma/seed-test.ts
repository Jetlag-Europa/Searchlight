import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { importGameDefinition } from "../src/games/import-service.js";
import prisma from "../src/lib/prisma.js";

// Deterministic e2e fixtures for the `searchlight-test` stack. Assumes the API
// has started once (it creates the Discord servers), then run this. Imports the
// South Limburg 2026 game from the web tests' fixtures (as a boot-time preload
// would), and creates a stable test user and a stable session on it. IDs are
// fixed so Playwright can hard-code them.

const GAME_FILE = resolve(
  import.meta.dirname,
  "../../web/tests/fixtures/games/south-limburg-2026.game.json",
);

const TEST_USER_ID = process.env["TEST_AUTH_USER_ID"] ?? "e2e-test-user";
const SESSION_ID = "e2e-session";
const GAME_KEY = "south-limburg-2026";

async function main() {
  // Unchanged since the last seed, this leaves the game as it is.
  await importGameDefinition({
    raw: JSON.parse(await readFile(GAME_FILE, "utf8")),
    source: "preload",
  });

  const user = await prisma.user.upsert({
    where: { discordId: TEST_USER_ID },
    update: {},
    create: {
      discordId: TEST_USER_ID,
      username: TEST_USER_ID,
      displayName: "E2E Test User",
      avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
      discordAccessToken: "test-access-token",
      discordRefreshToken: "test-refresh-token",
      discordTokenExpiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
    },
  });

  const game = await prisma.game.findFirst({
    where: { gameKey: GAME_KEY },
  });
  if (!game || !game.currentRevisionId) {
    throw new Error(
      `Seed-test: game "${GAME_KEY}" not found or has no current revision after importing ${GAME_FILE}.`,
    );
  }

  await prisma.gameSession.upsert({
    where: { id: SESSION_ID },
    update: {
      gameRevisionId: game.currentRevisionId,
    },
    create: {
      id: SESSION_ID,
      gameId: game.id,
      serverId: game.serverId,
      creatorId: user.discordId,
      name: "E2E Session",
      visibility: "private",
      gameRevisionId: game.currentRevisionId,
    },
  });

  // Creator participant row (the session list endpoint reads participants[0]).
  await prisma.sessionParticipant.upsert({
    where: { sessionId_userId: { sessionId: SESSION_ID, userId: user.discordId } },
    update: {},
    create: {
      sessionId: SESSION_ID,
      userId: user.discordId,
      role: "creator",
      acceptedAt: new Date(),
    },
  });

  console.log(
    `Seeded e2e fixtures: user=${user.discordId}, session=${SESSION_ID}, game=${game.name}`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
