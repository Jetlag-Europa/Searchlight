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
    osm_id: 438171,
    extent: [49.2943708, 16.4279898, 49.1098796, 16.7278346],
    country: "Czech Republic",
    osm_key: "place",
    countrycode: "CZ",
    osm_value: "city",
    name: "Brno",
    type: "city",
  },
};

const PARIS_CITY_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [48.8566, 2.3522],
  },
  properties: {
    osm_type: "R",
    osm_id: 71525,
    extent: [49.0, 2.0, 48.6, 2.7],
    country: "France",
    osm_key: "place",
    countrycode: "FR",
    osm_value: "city",
    name: "Paris",
    type: "city",
  },
};

const SOUTH_LIMBURG_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [50.8474, 5.8666],
  },
  properties: {
    osm_type: "R",
    osm_id: 47772,
    extent: [50.9434, 5.6389, 50.7504, 6.0942],
    country: "Netherlands",
    osm_key: "place",
    countrycode: "NL",
    osm_value: "region",
    name: "South Limburg",
    type: "region",
  },
};

const BUCHAREST_CITY_FEATURE = {
  type: "Feature",
  geometry: {
    type: "Point",
    coordinates: [44.4268, 26.1025], // [lat, lng] — Leaflet LatLngTuple
  },
  properties: {
    osm_type: "R",
    osm_id: 1246893,
    extent: [44.5455, 25.9700, 44.3300, 26.2900],
    country: "Romania",
    osm_key: "place",
    countrycode: "RO",
    osm_value: "city",
    name: "Bucharest",
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
    serverId: "1369664929975767120", // JetLag BNL
    name: "South Limburg 2026",
    sentinelValue: "__bundled-south-limburg-2026__",
    kmlPath: "south-limburg-poi.kml",
    mapLocationJson: SOUTH_LIMBURG_FEATURE,
    hidingRadius: 500,
    hidingRadiusUnits: "meters",
    size: "medium",
  },
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Bucharest 2026",
    sentinelValue: "__bundled-bucharest-2026__",
    kmlPath: "bucharest-poi.kml",
    mapLocationJson: BUCHAREST_CITY_FEATURE,
    hidingRadius: 350,
    hidingRadiusUnits: "meters",
    tierRadiusOverrides: { "Metro": 350, "Tram": 250 },
    size: "medium",
  },
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Paris",
    sentinelValue: "__bundled-paris-0.1__",
    kmlPath: "paris-hiding-zone.geojson",
    mapLocationJson: PARIS_CITY_FEATURE,
    hidingRadius: 1,
    hidingRadiusUnits: "kilometers",
    hidingZoneGeoJsonPath: "paris-hiding-zone.geojson",
    size: "large",
  },
  {
    serverId: "1190673594649415730", // JetLag EU
    name: "Brno 2026",
    sentinelValue: "__bundled-brno-2026-v2__",
    kmlPath: "brno-poi-v2.kml",
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
      update: { name: game.name, kmlPath: game.kmlPath },
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
