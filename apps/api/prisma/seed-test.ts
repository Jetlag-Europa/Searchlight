import { PrismaClient } from "@prisma/client";

// Deterministic e2e fixtures for the `writemap-test` stack. Assumes the base
// seed (servers + games) has already run — run `pnpm seed` first, then this.
// Creates a stable test user and a stable session pointing at the South Limburg
// 2026 game (its bundled GeoJSON assets ship in the web image, so boundary/
// matching questions work offline). IDs are fixed so Playwright can hard-code
// them.

const prisma = new PrismaClient();

const TEST_USER_ID = process.env["TEST_AUTH_USER_ID"] ?? "e2e-test-user";
const SESSION_ID = "e2e-session";
const GAME_SENTINEL = "__bundled-south-limburg-2026__";

async function main() {
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
    where: { sentinelValue: GAME_SENTINEL },
  });
  if (!game) {
    throw new Error(
      `Seed-test: game "${GAME_SENTINEL}" not found. Run the base seed (pnpm seed) first.`,
    );
  }

  await prisma.gameSession.upsert({
    where: { id: SESSION_ID },
    update: {},
    create: {
      id: SESSION_ID,
      gameId: game.id,
      serverId: game.serverId,
      creatorId: user.discordId,
      name: "E2E Session",
      visibility: "private",
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
