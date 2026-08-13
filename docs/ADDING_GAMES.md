# Adding a game

A deterministic runbook. Every bundled game is added the **same way**: one
manifest in the registry, asset files in `public/`, re-seed. There is exactly
one source of truth — `packages/shared/src/games.ts` (`GAME_REGISTRY`) — and the
DB seed, the API visibility gates, and the web client wiring are all derived
from it.

This doc is written so Claude Code can execute it end to end from "here are the
files + this description" with no other human steps beyond the prompt.

---

## What the user provides

- A **stations** file (`.kml`, Point placemarks) — the hiding zones. (Or a
  single combined hiding-zones KML; or a polygon `.geojson` for polygon-based
  games.)
- A **POI** file (`.kml`) with placemarks grouped into `<Folder>`s — optional,
  only if the game has custom points of interest.
- Optionally a **boundary** (`.kml`/`.geojson`) — the play-area outline.
- The **city/region name + year**, the **Discord server**, the **base hiding
  radius** (+ any per-tier overrides), and any **custom questions**.

### POI override rule (important)

When the game provides a POI category, **all** questions that use that category
(matching, measuring, tentacles) use the custom POIs and **never** query
Overpass. Categories the game does *not* provide fall back to Overpass as usual.
So: include every category you want overridden in the POI file. The 13 rulebook
categories are in `POI_CATEGORIES` (`packages/shared/src/games.ts`):
`airport, zoo, aquarium, golf_course, museum, cinema, hospital, library,
consulate, park, theme_park, mountain, rail`.

The mountain question type is internally `peak`; bundle mountains under a folder
named `mountain`. Station-name questions use the `train_station` category.

---

## Steps

### 1. Get the OSM relation id

Query Nominatim (do **not** guess the id — a wrong id silently breaks the
boundary load):

```
https://nominatim.openstreetmap.org/search?city=CITY&country=COUNTRY&format=json&limit=3
```

Take `osm_id`, `lat`, `lon`, and `boundingbox` (order: north, west, south,
east → the manifest `extent`).

### 2. Normalise and place the asset files

Copy into `apps/web/public/` with lowercase, hyphenated names:

| Kind     | Name                          |
| -------- | ----------------------------- |
| stations | `<city>-stations.kml`         |
| POI      | `<city>-poi.kml`              |
| boundary | `<city>-border.geojson`       |
| combined | `<city>-hiding-zones.kml`     |

- The stations KML needs `<Point>` placemarks (non-points are ignored). Per-tier
  radii read `<Data name="tier"><value>…</value></Data>`.
- **Name each POI `<Folder>` with the canonical category** (e.g. `museum`,
  `zoo`, `mountain`). Then no folder map is needed. Aliases like
  `movie_theater`→`cinema`, `amusement_park`→`theme_park`, `peak`→`mountain`,
  `golf`→`golf_course` are normalised automatically (see `POI_FOLDER_ALIASES` in
  `apps/web/src/maps/api/importers.ts`). Folders named `administrative`/`water`
  are skipped.

#### GeoJSON format requirements (learned the hard way)

When converting KML polygons (boundary, municipalities, postcodes) to GeoJSON:

- **Every `.geojson` must be a `FeatureCollection`** — including the single-polygon
  `*-border.geojson`. The client sets `polyGeoJSON` from the border and treats it
  as a FeatureCollection (`.features[…]`); a bare `Feature` throws on the
  custom-boundary path and the error is **silently swallowed** by the try/catch in
  `adjustMapGeoDataForQuestion` — boundary/admin questions then fail to eliminate
  hiding zones with no visible error. (Generators like shapely emit a bare Feature
  by default — wrap it.)
- **Wind rings CCW** (GeoJSON RFC 7946: exterior counterclockwise, holes clockwise).
  shapely keeps the source orientation and KML is often clockwise; rewind with
  `shapely.geometry.polygon.orient(geom, 1.0)` or `turf.rewind`. (turf's PIP and
  intersect are winding-agnostic, but be spec-correct.)
- **Mountains go in a folder named `mountain`** (the question type is internally
  `peak`); station-name questions use the `train_station` category.
- After generating, replicate the masking in node with the project's `@turf/turf`
  (`turf.intersect(featureCollection([border, zone]))`) and confirm a sane,
  non-empty area before declaring it done — don't rely on point-in-polygon alone.

### 3. Add ONE manifest to `GAME_REGISTRY`

Edit `packages/shared/src/games.ts`. A standard POI game:

```ts
{
  sentinel: "__bundled-<city>-<year>__",
  name: "City YYYY",
  serverId: SERVER.EU,            // or UK / BNL / DE / CH / HOME
  size: "medium",                  // "small" | "medium" | "large"
  hidingRadius: 400,
  hidingRadiusUnits: "meters",
  // tierRadiusOverrides: { Outer: 600 },   // keys must match KML tier values
  osm: {
    type: "Feature",
    geometry: { type: "Point", coordinates: [LAT, LON] },
    properties: {
      osm_type: "R", osm_id: 123456, extent: [N, W, S, E],
      country: "Country", osm_key: "place", countrycode: "XX",
      osm_value: "city", name: "City", type: "city",
    },
  },
  kmlPath: "<city>-poi.kml",       // DB kmlPath = POI file for POI-split games
  stationsKml: "<city>-stations.kml",
  boundaryGeoJson: "<city>-border.geojson",
  poiFolders: {},                  // {} = folders are canonical (identity).
                                   // Only add entries to remap odd folder names.
}
```

Variations:
- **Combined hiding-zones KML, no POI:** set `kmlPath: "<city>-hiding-zones.kml"`,
  omit `stationsKml`, `boundaryGeoJson`, `poiFolders`.
- **Station-only with custom boundary, no POI:** `kmlPath` and
  `stationsKml` both point at the stations file; add `boundaryGeoJson`; omit
  `poiFolders`. (Paris was the example until its Aug 2026 refresh gave it a POI
  file — note that a game in this shape sends *every* POI question to Overpass.)
- **Role-gated game** (e.g. Home Games): add
  `gate: { requireGuildId: "…", requireRoleId: "…" }`.
- **Hide a question type for this game:** add
  `hiddenQuestionTypes: ["airport", …]`. Use this when a POI's only real-world
  feature sits outside the play area but Overpass still matches it (e.g. an
  aerodrome polygon overlapping the boundary even though its centre is outside) —
  removing the POI from the KML is not enough. The type is dropped from the
  matching/measuring/tentacle pickers for this game only; already-added questions
  are unaffected.

> `poiFolders` is the trigger for POI loading. Use `{}` for a canonical POI KML;
> only games with a `poiFolders`/POI file load POIs.

Custom (game-only) question types — admin divisions, bespoke geometry — are
still registered in `apps/web/src/maps/schema.ts` and gated in
`GAME_GATED_TYPES` there. Generic POI questions need no schema change.

### 4. Build shared, validate, seed dev

```
pnpm --filter @taibled/shared build
cd apps/api
pnpm validate-game __bundled-<city>-<year>__   # asset + folder + boundary checks
pnpm seed:dev                                   # idempotent, full-field upsert
```

### 5. Verify in the browser (dev), then replicate to live

Load the dev site, switch to the game, and confirm in the console / network tab:

- `[taibled:stations] loaded N stations …` with the right count and radius.
- `[taibled:poi] loaded custom POI … museum:NN, …` listing each category.
- Open a matching, a measuring, and a tentacle question **per provided
  category** → **no** Overpass request fires.
- Open a question for a category the game does **not** provide → it still queries
  Overpass (expected).

Then follow the dev→live deploy flow in `startup.txt` (merge to `master`, pull
into the prod clone, rebuild) — **and then seed prod**, see below. A deploy alone
never creates the game row.

---

## Appendix — seeding prod

**The deploy does not do this for you.** The api container runs
`prisma migrate deploy` on boot, which applies schema migrations only. A new
entry in `GAME_REGISTRY` ships in the web bundle and its assets serve, but
without a `Game` row the game fails to activate. Seed after every deploy that
adds or changes a game:

```
docker compose --project-name writemap exec api sh -c 'cd /app/apps/api && pnpm seed:prod'
```

This is registry-driven (`prisma/seed.ts`) and upserts on `sentinelValue`, so it
is idempotent — safe to re-run, and it updates existing rows in place rather
than colliding.

`seed:prod` runs the **compiled** seed (`dist-seed/seed.js`, built by
`tsconfig.seed.json` in the image's builder stage). The runtime image installs
prod deps only, so `tsx` is not present and `pnpm seed` / `prisma db seed`
cannot work there — that is why the compiled copy exists. On the VPS there are
also no published DB ports, so seeding from the host is not an option either.

### Fallback — raw SQL

Only if the api container won't start (so `exec` is unavailable). Prefer
`seed:prod`; this is hand-maintained and drifts from the registry: 

```
docker exec writemap-postgres-1 psql -U taibled -d taibled -c "
INSERT INTO \"Game\" (id,\"serverId\",name,\"sentinelValue\",\"kmlPath\",
  \"mapLocationJson\",\"hidingRadius\",\"hidingRadiusUnits\",\"updatedAt\",
  \"tierRadiusOverrides\",size)
VALUES (gen_random_uuid()::text,'SERVER_ID','City YYYY',
  '__bundled-city-year__','city-poi.kml','{…osm json…}',400,'meters',NOW(),NULL,'medium')
ON CONFLICT (\"sentinelValue\") DO UPDATE SET
  \"serverId\"=EXCLUDED.\"serverId\", name=EXCLUDED.name, \"kmlPath\"=EXCLUDED.\"kmlPath\",
  \"mapLocationJson\"=EXCLUDED.\"mapLocationJson\", \"hidingRadius\"=EXCLUDED.\"hidingRadius\",
  \"hidingRadiusUnits\"=EXCLUDED.\"hidingRadiusUnits\", \"tierRadiusOverrides\"=EXCLUDED.\"tierRadiusOverrides\",
  size=EXCLUDED.size, \"updatedAt\"=NOW();
"
```

Note this only covers the `Game` table; the registry-driven seed also upserts
servers and role permissions.
