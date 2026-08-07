import { Prisma, PrismaClient } from "@prisma/client";
import { GAME_REGISTRY } from "@taibled/shared";

const prisma = new PrismaClient();

const SERVERS = [
  { id: "1059625399979606166", name: "JetLag UK" },
  { id: "1190673594649415730", name: "JetLag EU" },
  { id: "1369664929975767120", name: "JetLag BNL" },
  { id: "1333139120507064350", name: "JetLag DE" },
  { id: "1458858559952523305", name: "JetLag CH" },
  { id: "1376560872029290708", name: "JetLag Nordics" },
  // Virtual server — no real Discord guild. Visible to everyone; its games are
  // gated per-game (see apps/api/src/lib/game-gates.ts).
  { id: "home-games", name: "Home Games" },
];

const ROLE_PERMISSIONS = [
  // JetLag UK — role 1383202208799129731 → server.admin
  { serverId: "1059625399979606166", discordRoleId: "1383202208799129731", permission: "server.admin" },
];

// Derived from the single source of truth in @taibled/shared. To add or tune a
// game, edit GAME_REGISTRY there — not here. See docs/ADDING_GAMES.md.
const GAMES = GAME_REGISTRY.map((m) => ({
  serverId: m.serverId,
  name: m.name,
  sentinelValue: m.sentinel,
  kmlPath: m.kmlPath,
  mapLocationJson: m.osm,
  hidingRadius: m.hidingRadius,
  hidingRadiusUnits: m.hidingRadiusUnits,
  tierRadiusOverrides: m.tierRadiusOverrides ?? null,
  size: m.size,
  hidingZoneGeoJsonPath: m.hidingZoneGeoJson ?? null,
}));

async function main() {
  for (const server of SERVERS) {
    await prisma.server.upsert({
      where: { id: server.id },
      update: { name: server.name },
      create: { id: server.id, name: server.name },
    });
    console.log(`Upserted server: ${server.name} (${server.id})`);
  }

  for (const rp of ROLE_PERMISSIONS) {
    await prisma.rolePermission.upsert({
      where: { serverId_discordRoleId_permission: rp },
      update: {},
      create: rp,
    });
    console.log(`Upserted role permission: ${rp.serverId} / ${rp.discordRoleId} → ${rp.permission}`);
  }

  for (const game of GAMES) {
    // The casts are for Prisma's Json input types only — GameOSMFeature and
    // Record<string, number> are structurally fine but lack the index
    // signature InputJsonObject wants. Values are passed through unchanged;
    // this file used to run under tsx, which never typechecked it, and it is
    // now compiled by tsconfig.seed.json so it can run in the prod image.
    await prisma.game.upsert({
      where: { sentinelValue: game.sentinelValue },
      update: {
        serverId: game.serverId,
        name: game.name,
        kmlPath: game.kmlPath,
        mapLocationJson: game.mapLocationJson,
        hidingRadius: game.hidingRadius,
        hidingRadiusUnits: game.hidingRadiusUnits,
        tierRadiusOverrides: game.tierRadiusOverrides ?? null,
        size: game.size,
        hidingZoneGeoJsonPath: game.hidingZoneGeoJsonPath ?? null,
      } as unknown as Prisma.GameUncheckedUpdateInput,
      create: game as unknown as Prisma.GameUncheckedCreateInput,
    });
    console.log(`Upserted game: ${game.name} (${game.sentinelValue})`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
