import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SERVERS = [
  { id: "1059625399979606166", name: "JetLag UK" },
  { id: "1190673594649415730", name: "JetLag EU" },
  { id: "1369664929975767120", name: "JetLag BNL" },
  { id: "1333139120507064350", name: "JetLag DE" },
];

const ROLE_PERMISSIONS = [
  // JetLag UK — role 1383202208799129731 → server.admin
  { serverId: "1059625399979606166", discordRoleId: "1383202208799129731", permission: "server.admin" },
];

const BRNO_CITY_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [49.1951, 16.6068],
  },
  properties: {
    osm_type: "R",
    osm_id: 86469,
    extent: [49.27, 16.47, 49.11, 16.74],
    country: "Czech Republic",
    osm_key: "place",
    countrycode: "CZ",
    osm_value: "city",
    name: "Brno",
    type: "city",
  },
};

const BRUSSELS_CITY_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [50.8503, 4.3517],
  },
  properties: {
    osm_type: "R",
    osm_id: 54094,
    extent: [51.05, 4.0, 50.65, 4.70],
    country: "Belgium",
    osm_key: "place",
    countrycode: "BE",
    osm_value: "city",
    name: "Brussels",
    type: "city",
  },
};

const LUXEMBOURG_COUNTRY_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [49.8158683, 6.1296751],
  },
  properties: {
    osm_type: "R",
    osm_id: 2171347,
    extent: [50.1827989, 5.7356988, 49.4478587, 6.5312481],
    country: "Luxembourg",
    osm_key: "place",
    countrycode: "LU",
    osm_value: "country",
    name: "Luxembourg",
    type: "country",
  },
};

const GAMES = [
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Brno 2026",
    sentinelValue: "__bundled-brno-2026__",
    kmlPath: "brno-hiding-zones.kml",
    mapLocationJson: BRNO_CITY_FEATURE,
    hidingRadius: 400,
    hidingRadiusUnits: "meters",
  },
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Luxembourg 2026",
    sentinelValue: "__bundled-luxembourg-2026__",
    kmlPath: "luxembourg-hiding-zones.kml",
    mapLocationJson: LUXEMBOURG_COUNTRY_FEATURE,
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
  },
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Brussels 2026",
    sentinelValue: "__bundled-brussels-2026__",
    kmlPath: "brussels-hiding-zones.kml",
    mapLocationJson: BRUSSELS_CITY_FEATURE,
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
  },
];

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
    await prisma.game.upsert({
      where: { sentinelValue: game.sentinelValue },
      update: { name: game.name },
      create: game,
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
