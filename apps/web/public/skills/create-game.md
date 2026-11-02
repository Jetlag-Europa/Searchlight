---
name: create-searchlight-game
description: Create, convert, check and import a Searchlight game definition (*.game.json) from a game announcement (a rules Google Doc and a Google My Map), KML/KMZ, GeoJSON, CSV or OpenStreetMap data, covering the play area, hiding zones, radar/thermometer and matching, measuring and tentacle question layers. Use when asked to make, convert, fix or update a Searchlight game.
---

# Create a Searchlight game definition (v1)

A Searchlight game is one self-contained JSON file. **The file is the whole game.** The app offers exactly the questions the file declares: there are no default questions, and nothing is looked up in OpenStreetMap/Overpass while playing. If players should be able to ask about something (radar, thermometer, museums, districts, a coastline), it has to be declared in the file, with its data embedded.

Two helper scripts (Node 18+) live next to this guide, in the repo at `apps/web/public/skills/create-game/` and online at:

- `https://searchlight.jetlageuropa.org/skills/create-game/game-tools.mjs`: reads KML, GeoJSON and CSV, normalizes geometry, fetches OSM POIs and assembles layers (section 6).
- `https://searchlight.jetlageuropa.org/skills/create-game/check-game.mjs`: checks a finished file, mirroring the server's validator and adding the play-quality checks it doesn't do. It also lists the questions the game will offer (section 7).

## 1. Workflow

1. **Gather inputs.** Use the table below. Ask the user for anything you can't derive from their files. Never invent a server ID, a radius, or which questions the game has. Most games start as an announcement with a rules doc and a map link: see section 1.1.
2. **Convert** each source into normalized GeoJSON features (section 6).
3. **Assemble** the definition (section 2) and declare every question explicitly.
4. **Check** with `node check-game.mjs <file>`. Fix every ERROR. Fix each WARN, or tell the user why it stays.
5. **Import** (section 8). The import page previews the file first, and the API has `?dryRun=true`.
6. **Report back:** zone count, features per layer, the question list `check-game.mjs` printed, and anything you dropped, merged or assumed.

| Input | Goes to | Source |
|---|---|---|
| Game name and date | `name`, `id` | user |
| Discord server | `serverId` | user (known IDs in section 3) |
| Play area outline | `map.playArea` | user file. If there is none, ask which boundary to use |
| Hiding zones (usually stations) | `hidingZones.features` | user file |
| Hiding radius and per-tier radii | `hidingZones.radius`, `tierOverrides` | user, or the game's rules |
| Radar sizes, thermometer yes/no | `radars`, `thermometer` | user, or the game's rules |
| Question layers and which kinds each allows | `features[]` | user files. For standard POI categories without data, offer to fetch them from OSM (section 6) |

### 1.1 Starting from a game announcement

Organisers usually post a Discord message linking a rules Google Doc and a Google My Map. That is enough to build the game.

**Copy the game, don't redesign it.** Take the stops, play area, regions, lines and POIs exactly as drawn, with their names as spelled on the map. Don't add stations or POIs, top up from OSM, simplify geometry, or derive layers the map doesn't draw. Only these fixes are allowed: decoding escaped names, merging one region drawn as several shapes, and dropping a duplicate pin at identical coordinates. Report each one. If the checker warns about heavy geometry, ask before simplifying.

**Download both sources.** Neither needs a sign-in when shared as "anyone with the link":

```bash
curl -fsSL -o map.kml  "https://www.google.com/maps/d/kml?mid=<mid>&forcekml=1"           # gt.myMapsKmlUrl(link)
curl -fsSL -o rules.txt "https://docs.google.com/document/d/<id>/export?format=txt"      # gt.googleDocTextUrl(link)
```

The KML holds the whole map, one folder per My Maps layer. If a download returns an HTML sign-in page, ask the user to share the file or to export it themselves.

**Fill the fields from the announcement and rules:**

| Field | Where it comes from |
|---|---|
| `name`, `id` | The game's city and date, e.g. "Hide + Seek: Sheffield (17th October)" gives `"Sheffield 17-10"` and `sheffield-2026`. |
| `serverId` | The Discord server the announcement was posted in (section 3). Ask if you don't know it. A mention like `<@&1546157665368145941>` is a *role* ID, not a server. Use it for `visibility` only if the user wants the game restricted to that role. |
| `size` | "a small/medium/large game". |
| `hidingZones.radius` | The rules. If they don't state it, measure the map's drawn zone circles with `gt.circleRadius()` and take the most common value (circles cut at the play-area edge come out smaller). Otherwise ask. |
| `tierOverrides` | Only when the map draws differently sized circles per stop style or folder, or the rules give per-mode radii. |
| `radars` | The rules' radar list, converted to the game unit (`1 km` gives `1000`). A "Custom" entry needs nothing, since radii stay editable. |
| `thermometer` | `true` if the rules list any thermometer. Players set its distance in the app. |
| `features` | The rules' matching/measuring table and tentacle list (below). |

**Map the rules' feature table to layers.** Rules usually list the rulebook categories, each with a source:

- **"N/A" or blank:** no layer.
- **"Use Custom Map 'X' layer":** a layer built from that folder. If no folder has that name (the rules say "2nd Administrative Divisions" but the map has "Wards" and "Postcodes"), match by meaning and tell the user what you chose and why.
- **"Use Google Maps"**, or "anything with five or more reviews": Google Maps data can't be embedded. Leave the category out, and tell the user that players will use custom questions for it. Don't substitute OSM data without asking.
- **A line layer standing in for areas** (e.g. landmasses separated by a Rivers layer): matching needs region polygons, which the map doesn't draw. Leave it out and say so.

Name each layer after its rulebook category, in the singular. The question kinds follow the rulebook unless the rules restrict them, e.g. "Rail line (Measuring Only)":

| Rulebook category | `matching` | `measuring` | `tentacle` |
|---|:-:|:-:|:-:|
| 1st and 2nd administrative division | yes | yes (border) | |
| 3rd and 4th administrative division | yes | | |
| Commercial airport | yes | yes | |
| Rail station, high-speed or rail line, international border, coastline, body of water | | yes | |
| Mountain, park, amusement park, zoo, aquarium, golf course, museum, cinema, hospital, library, foreign consulate | yes | yes | only if the rules list it under tentacles |
| Landmass | yes (region polygons) | | |

Transit line, station name length, street/path, photo questions and curses have no data-driven version in Searchlight. Leave them out.

**Watch for these My Maps quirks:**

- **Several categories in one folder** (a "POIs" layer): split it by `styleUrl` with `gt.groupBy(features, "styleUrl")`, not by the `icon` URL: different categories often share the same blank pin and differ only in colour. List each style's names, map every style to a category, and fail on an unmapped one.
- **Placeholder names** ("Polygon 82", "Line 2"): look for the real name in the other properties (ExtendedData, e.g. a `WD26NM` ward name) and pass `{ name: "WD26NM" }` to `normalize()`. Lines used for measuring only can keep placeholder names, since players never see them.
- **One region drawn as several shapes** (five polygons named `S60`): `gt.mergeByName()`.
- **Drawn hiding-zone circles:** don't import them. The stop pins are the zones, and the app draws the circles from the radius.
- **Folders no question uses:** list them for the user.

## 2. Complete example

```json
{
  "$schema": "https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json",
  "id": "paris-2026",
  "name": "Paris 15-08",
  "serverId": "1190673594649415730",
  "size": "large",
  "visibility": { "kind": "server-members" },
  "map": {
    "center": [2.35, 48.85],
    "bounds": [2.15, 48.75, 2.55, 48.95],
    "playArea": {
      "type": "FeatureCollection",
      "features": [{
        "type": "Feature",
        "geometry": { "type": "Polygon", "coordinates": [[[2.15, 48.75], [2.55, 48.75], [2.55, 48.95], [2.15, 48.95], [2.15, 48.75]]] },
        "properties": { "name": "Paris" }
      }]
    }
  },
  "hidingZones": {
    "radius": 400,
    "unit": "meters",
    "tierOverrides": { "Outer": 600 },
    "features": {
      "type": "FeatureCollection",
      "features": [
        { "type": "Feature", "id": "gare-du-nord", "geometry": { "type": "Point", "coordinates": [2.355312, 48.880912] }, "properties": { "name": "Gare du Nord", "tier": "Outer" } },
        { "type": "Feature", "id": "chatelet", "geometry": { "type": "Point", "coordinates": [2.347, 48.8584] }, "properties": { "name": "Châtelet" } }
      ]
    }
  },
  "radars": [400, 600],
  "thermometer": true,
  "features": [
    {
      "name": "Museum",
      "enabledFor": ["matching", "measuring", "tentacle"],
      "data": { "type": "FeatureCollection", "features": [
        { "type": "Feature", "id": "louvre", "geometry": { "type": "Point", "coordinates": [2.3376, 48.8606] }, "properties": { "name": "Louvre" } },
        { "type": "Feature", "id": "orsay", "geometry": { "type": "Point", "coordinates": [2.3266, 48.86] }, "properties": { "name": "Musée d'Orsay" } }
      ] }
    },
    {
      "name": "Arrondissement",
      "enabledFor": ["matching", "measuring"],
      "data": { "type": "FeatureCollection", "features": [
        { "type": "Feature", "id": "west", "geometry": { "type": "Polygon", "coordinates": [[[2.15, 48.75], [2.35, 48.75], [2.35, 48.95], [2.15, 48.95], [2.15, 48.75]]] }, "properties": { "name": "West" } },
        { "type": "Feature", "id": "east", "geometry": { "type": "Polygon", "coordinates": [[[2.35, 48.75], [2.55, 48.75], [2.55, 48.95], [2.35, 48.95], [2.35, 48.75]]] }, "properties": { "name": "East" } }
      ] }
    },
    {
      "name": "High-Speed Line",
      "enabledFor": ["matching", "measuring"],
      "data": { "type": "FeatureCollection", "features": [
        { "type": "Feature", "id": "lgv-nord", "geometry": { "type": "MultiLineString", "coordinates": [[[2.35, 48.88], [2.4, 49.0]], [[2.4, 49.0], [2.5, 49.1]]] }, "properties": { "name": "LGV Nord" } },
        { "type": "Feature", "id": "lgv-sud-est", "geometry": { "type": "LineString", "coordinates": [[2.37, 48.84], [2.45, 48.75], [2.6, 48.6]] }, "properties": { "name": "LGV Sud-Est" } }
      ] }
    }
  ]
}
```

These questions are offered: radar at any radius (presets 400 m and 600 m), thermometer, Nearest Museum, Distance to Museum, Tentacles: Museum, Same Arrondissement, Distance to Arrondissement Boundary, Nearest High-Speed Line, and Distance to High-Speed Line.

## 3. Root fields

The import rejects unknown properties, both at the root and in each layer. Positions are always `[longitude, latitude]` with exactly two numbers, never an altitude.

| Field | Required | Default | What it does |
|---|---|---|---|
| `$schema` | no | | `https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json` gives editors validation. |
| `id` | no | slug of `name` | The game's permanent key: lowercase letters and digits, separated by single hyphens. Importing a file with the same `id` updates that game. Use `<city>-<year>`, or `<city>-<yyyy-mm-dd>` when a city hosts several games. Don't change it after the first import. |
| `revision` | no | | Leave it out. The server numbers revisions itself. |
| `name` | yes | | Shown in the game picker, at most 120 characters. Convention: `"City DD-MM"`, e.g. `"Paris 15-08"`. |
| `serverId` | yes | | The Discord server the game belongs to (table below). The server must already be registered in Searchlight, and an existing game can't move to another server. |
| `size` | no | `"medium"` | Sets the zoom level from which station names are drawn: `large` from 11 (region or country), `medium` from 13 (city), `small` from 17 (district). |
| `visibility` | no | `{"kind":"server-members"}` | Or `{"kind":"discord-role","guildId":"…","roleId":"…"}` to restrict the game to one role. |
| `unit` | no | | Avoid it. Set `hidingZones.unit` instead (section 4). |
| `map.center` | yes | | `[lng, lat]`. Use the play area's centre. |
| `map.bounds` | no | from `center`, the play area and zones ±0.05° | `[west, south, east, north]`. Set it to the play area's bbox plus a small margin. Matching cells are computed over this box, so a box much larger than the play area only slows matching down. |
| `map.playArea` | yes | | A FeatureCollection of Polygon/MultiPolygon features. It is the starting map: everything outside it is eliminated from the start, and the view fits to it. |
| `hidingZones` | yes | | Section 4. |
| `radars`, `thermometer` | no | **off** | Section 5.1. |
| `features` | no | none | Question layers, section 5.2. |

Known `serverId` values:

| Server | `serverId` |
|---|---|
| JetLag EU (continental Europe) | `1190673594649415730` |
| JetLag UK | `1059625399979606166` |
| JetLag BNL (Benelux) | `1369664929975767120` |
| JetLag DE | `1333139120507064350` |
| JetLag CH | `1458858559952523305` |
| JetLag Nordics | `1376560872029290708` |
| Home Games (open to every signed-in user) | `home-games` |

Only Searchlight admins can import into Home Games, since it has no Discord roles to grant import rights. A game dev imports into the Discord server where their role has game permissions (section 8).

## 4. Hiding zones

```json
"hidingZones": { "radius": 400, "unit": "meters", "tierOverrides": { "Outer": 600 }, "features": { "type": "FeatureCollection", "features": [ … ] } }
```

- **Use Point features.** A Polygon or MultiPolygon zone also works: the app uses it as its own area, so no radius or tier applies to it, but `check-game.mjs` can't tell whether it lies inside the play area.
- **`id`:** give every zone a unique, stable string ID (the slug of its name, with `-2`, `-3` for repeats). Without one the zone name is used as the ID, so two stops with the same name collide.
- **`properties.name`** is the name shown to players.
- **`properties.tier`** selects a radius from `tierOverrides`. Write tiers as strings, like the `tierOverrides` keys (a number `1` is read as `"1"`). Tier names are case-sensitive: `"outer"` does not match `"Outer"`. Zones whose tier has no override use the base radius.
- **`properties.radius`** overrides the radius for that single zone: a number in the game unit, or `{ "value": 1, "unit": "kilometers" }`. Anything else (such as the string `"600"`) is ignored and the zone gets its tier or base radius.
- **Radius precedence:** zone `radius`, then `tierOverrides[tier]`, then `hidingZones.radius`, then 400.
- **Units:** every radius (zone, tier, base and radar values) is in one unit: root `unit` if set, otherwise `hidingZones.unit`, otherwise meters. A root `unit` silently overrides `hidingZones.unit`: `"unit": "kilometers"` with `"radius": 400, "unit": "meters"` gives 400 km zones. So set only `hidingZones.unit`.
- Every zone should lie inside the play area.

## 5. Questions

A game offers only what it declares. The Add Question buttons for radar and thermometer are disabled when the game doesn't declare them. Players can always draw their own custom matching, measuring and tentacle questions, so when the game has no layer for one of those families its button adds a custom question instead. Each picker lists only the game's own questions, plus players' hand-drawn custom questions. Questions pasted from other games are rejected if this game doesn't define them.

### 5.1 Radar and thermometer

| Field | Value | Result |
|---|---|---|
| `radars` | omitted or `false` | no radar questions |
| | `true` | radar enabled. A new radar starts at the base hiding radius (`hidingZones.radius`). |
| | `[400, 600]` | radar enabled. A new radar, from Add Question or the map's right-click menu, starts at the first radius, and the radar card offers every listed radius as a quick pick. List the radii the rules use, e.g. the rules' radar list, or by convention the base radius plus each tier radius. |
| `thermometer` | omitted or `false` | no thermometer |
| | `true` | thermometer enabled |

Radar radii are in the game unit (section 4). They are starting values, not limits: the radius stays editable on the radar card, next to the declared radii as quick picks (shown as "500 m", "2 km") when there are several.

Write both fields explicitly in every game, even when the value is `false`.

### 5.2 Question layers (`features`)

Each layer has three properties: `{ "name", "enabledFor", "data" }`, and a region layer may have a fourth, `"noOverlaps": true`. `data` is an embedded FeatureCollection. All features in one layer must share one geometry family. Don't set `noOverlaps` yourself: Searchlight's import page sets it when it checks a region layer, or fixes its overlaps, before importing.

| Layer geometry | `matching` | `measuring` | `tentacle` |
|---|---|---|---|
| **Point** (sites) | **Nearest {name}**: do seeker and hider have the same nearest site? Each point owns its Voronoi cell. | **Distance to {name}**: is the hider closer to their nearest site than the seeker is to theirs? | **Tentacles: {name}**: of the sites within the radius the seeker picks, which is the hider's nearest? |
| **LineString / MultiLineString** | **Nearest {name}**: is the same line nearest to both? Each *feature* is one line. | **Distance to {name}**: compares the distance to the nearest line in the layer. | not allowed |
| **Polygon / MultiPolygon** (regions) | **Same {name}**: are they in the same region? "Outside every region" counts as its own answer. | **Distance to {name} Boundary**: compares each player's distance to the boundary of the region *they* are in. | not allowed |

**Labels and IDs come from `name`.**

- Matching prefixes "Nearest" (points and lines) or "Same" (regions), unless the name already starts with that word.
- Measuring on regions appends " Boundary", unless the name contains "boundary" or "border".
- Tentacles prefix "Tentacles: ", unless the name starts with "Tentacle".
- **Use singular nouns in Title Case**, like the labels around them: `Museum` gives "Nearest Museum", `Golf Course` gives "Nearest Golf Course", and `Arrondissement` gives "Same Arrondissement". `Arrondissements` would give "Same Arrondissements".
- Question IDs are `<kind>-<slug(name)>`, e.g. `matching-museum`. A slug is lowercase ASCII, with accents removed and every run of other characters turned into `-`.
- Give every layer a distinct slug. `A B` and `A-B` collide.
- Renaming a layer changes its question IDs. Sessions already running keep their pinned revision, but don't rename a layer without a reason.

**The import rejects:**

- mixed geometry families in one layer
- `tentacle` on lines or regions
- `MultiPoint` or `GeometryCollection` features (split or merge them)
- non-embedded data
- unclosed rings, rings with fewer than 4 positions, or lines with fewer than 2
- positions with an altitude or outside the valid range
- an empty slug or colliding question IDs
- two layers with the same `name`

**Imports anyway but plays badly** (`check-game.mjs` warns about these):

- **Matching on a single feature** always gets the same answer. Use `measuring` only for one-off sites (the only airport, the only zoo) and single lines (one coastline, one border).
- **One feature per real-world line.** Matching treats each feature as its own line, so merge the segments of one line into one MultiLineString. A layer of 500 rail segments asks "nearest segment?".
- **Matching regions should tile the play area without overlaps.** Where regions overlap, the first in file order wins, and zones outside every region form an extra "outside" answer. Searchlight's import page finds overlaps, shows what fixing them changes, and fixes them (giving each overlap to the first region) before importing; tell the user to download the fixed file it offers.
- **Own boundary is the nearest boundary.** When regions don't overlap, the boundary of the region a player is in is also the nearest boundary of *any* region: a straight line to another region's boundary has to cross the player's own boundary first, or end on it. So for everyone inside a region, "Distance to {name} Boundary" already compares distances to the nearest region boundary. The two differ only for a player outside every region, who has no own boundary in the region layer (and counts as infinitely far) but still has a nearest line in a line layer. Once Searchlight's import page has marked a region layer `noOverlaps`, the app answers its distance question with one buffer around the whole boundary network, so a separate line layer of the same boundaries (e.g. `"Borough Boundary"` as MultiLineStrings next to the `"Borough"` region layer) is no longer needed for speed. If you add one anyway, both are labelled "Distance to Borough Boundary", so enable measuring on only one of them.
- **Include sites just outside the play area.** The nearest museum to a hider near the edge may be across the border, so take POIs from the play area's bbox plus a few km.
- **Keep geometry light:**
  - Keep each layer measured to, and each line layer matched on, well under 20,000 vertices in all, and each region matched on under 20,000 by itself: matching on regions only ever works with the one region a seeker is in.
  - If a layer is over, and its vertices lie closer than about 50 m (borders traced point by point, as from OSM), simplify it with a topology-preserving simplifier at about 10 m tolerance. Simplifying each feature on its own opens gaps and overlaps between neighbours. Where vertices are already far apart, simplifying removes little; the checker then only notes the layer.
  - Round coordinates to 6 decimal places (about 0.1 m). Use fixed decimals, not 6 *significant* digits, which leaves about 11 m steps.
  - Keep only `name` in properties (plus `tier`/`radius` on zones).
  - Preloaded games range from tens of KB to about 8 MB, and the import limit is 50 MB of compact JSON. The checker warns over 10 MB and fails over 50 MB.
- Every feature should have `properties.name`, because players see it in answers and tentacle lists.

### 5.3 Standard rulebook layers

Name layers after the rulebook categories, singular: `Airport`, `Aquarium`, `Cinema`, `Consulate`, `Golf Course`, `Hospital`, `Library`, `Mountain`, `Museum`, `Park`, `Theme Park`, `Zoo`, plus game-specific ones such as `Castle`, `Stadium` or `Rail Terminus`. Admin regions use their local term, e.g. `Arrondissement`, `Borough`, `Canton`, `Province`. A layer only exists if you add it. A category the user didn't ask for is simply absent.

## 6. Converting sources with `game-tools.mjs`

Put `game-tools.mjs` in a working directory. For KML, install the parser there:

```bash
npm i @tmcw/togeojson@7.1.2 @xmldom/xmldom@0.9.12
```

| Helper | Use |
|---|---|
| `readKmlFolders(path)` | KML (unzip KMZ first, it's a zip around `doc.kml`). Returns a `Map` from top-level folder name to features; Google My Maps layers are folders. Nested folders belong to their top-level folder. `ExtendedData` becomes string properties (e.g. `tier`, `radius`). `get()` returns `undefined` for a mistyped folder name, which `normalize()` and `bbox()` reject with an error. |
| `readGeoJson(path)` | A FeatureCollection, Feature or bare geometry, returned as features. |
| `readCsv(path)` | Header row with `lat`/`latitude` and `lng`/`lon`/`longitude`. Other columns become properties (e.g. `name`, `tier`, `category`). Quoted fields are handled. Rows with a blank or non-numeric lat or lng are skipped, and the count is printed. |
| `overpassPoints(OSM_TAGS.museum, bbox)` | Named OSM sites in a bbox, as Points. `OSM_TAGS` covers the rulebook categories (airport means `aeroway=aerodrome` with an IATA code). Ask the user before using OSM, review the results with them, and run one query at a time against the public endpoint. |
| `normalize(features, { keep })` | **Always run this.** It drops altitude, rounds to 6 decimals, closes rings, removes degenerate parts, splits MultiPoint, merges KML MultiGeometry (`GeometryCollection`) into MultiLineString/MultiPolygon, and keeps only the `keep` properties (default `["name"]`). A numeric-looking `radius` string becomes a number. A `GeometryCollection` that mixes families (a pin plus a shape) becomes one feature per family: filter by `geometry.type` before building a layer. |
| `normalize(features, { name: "WD26NM" })` | Reads the name from another property when the placemark name is a placeholder. `normalize()` also strips CDATA and decodes entities in every kept string (`decodeText()`). |
| `dedupePoints(features)` | Drops repeated coordinates. |
| `mergeByName(features)` | Merges lines or regions that share a name into one MultiLineString or MultiPolygon. |
| `groupBy(features, key)` | A `Map` from a property's value to its features, e.g. `groupBy(kml.get("POIs"), "styleUrl")` to split a mixed My Maps layer. |
| `circleRadius(feature)` | Radius in meters of a circle drawn as a Polygon or closed LineString. |
| `myMapsKmlUrl(link)`, `googleDocTextUrl(link)` | Download URLs for a Google My Maps link (KML) and a Google Docs link (plain text). |
| `withIds(features, fallback)` | Assigns unique slug IDs from names. |
| `layer(name, enabledFor, features)`, `collection(features)`, `bbox(features)`, `center(bbox)` | Assemble the file. `layer()` throws if the features mix geometry families. |
| `formatGame(game)` | The file's text: indented, with each `coordinates` array on one line. `JSON.stringify(game, null, 2)` puts every number on its own line, making the file about 4.5x larger. |

```js
// build-game.mjs (run: node build-game.mjs)
import { writeFileSync } from "node:fs";
import * as gt from "./game-tools.mjs";

const kml = await gt.readKmlFolders("mymap.kml");
const playArea = gt.normalize(kml.get("Play area"));
const zones = gt.withIds(gt.normalize(kml.get("Stations"), { keep: ["name", "tier"] }), "zone");
const bounds = gt.bbox(playArea);
const margin = [bounds[0] - 0.05, bounds[1] - 0.05, bounds[2] + 0.05, bounds[3] + 0.05];
const museums = gt.withIds(gt.dedupePoints(gt.normalize(await gt.overpassPoints(gt.OSM_TAGS.museum, margin))));

const game = {
  $schema: "https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json",
  id: "testville-2026",
  name: "Testville 12-10",
  serverId: "home-games",
  size: "medium",
  map: { center: gt.center(bounds), bounds, playArea: gt.collection(playArea) },
  hidingZones: { radius: 400, unit: "meters", tierOverrides: { Outer: 600 }, features: gt.collection(zones) },
  radars: [400, 600],
  thermometer: true,
  features: [
    gt.layer("Museum", ["matching", "measuring", "tentacle"], museums),
    gt.layer("District", ["matching", "measuring"], gt.withIds(gt.normalize(kml.get("Districts")))),
    gt.layer("Rail Line", ["matching", "measuring"], gt.withIds(gt.normalize(kml.get("Rail lines")))),
  ],
};
writeFileSync(`${game.id}.game.json`, gt.formatGame(game));
```

Other notes:

- Where no KML parser can be installed, GDAL works too: `ogr2ogr -f GeoJSON out.geojson in.kml <layer>`. Pass the result through `normalize()`.
- For admin boundaries, export the relations from OpenStreetMap (e.g. via Overpass with `out geom` and `osmtogeojson`, or a boundary download service) or use national open data. Simplify the result before adding it.
- Don't hand-write regex KML parsers. They miss CDATA, entities, MultiGeometry, holes and altitude.

## 7. Checking

```bash
node check-game.mjs testville-2026.game.json
node check-game.mjs --strict testville-2026.game.json
```

- **ERROR:** the import will refuse the file (the same rules as the server).
- **WARN:** it imports but will play badly, e.g. swapped `[lat, lng]`, zones outside the play area, duplicate zone or feature IDs, names with CDATA wrappers or XML entities (`<![CDATA[…]]>`, `&amp;`), case-mismatched or numeric tiers, single-feature matching or tentacles, regions that overlap or that no zone lies in, or heavy geometry.
- **NOTE:** worth a look but often intentional, e.g. plural-looking layer names.

`--strict` reports the warnings that are always data defects as **FAIL** and exits with an error: misplaced or swapped coordinates, duplicate zone or feature IDs, undecoded names, matching on a single feature, region layers no hiding zone lies in, and layers marked `noOverlaps` whose regions reach more than 0.5 m into each other. Preloaded games must pass it.

The checker ends with the question list and labels, which is what players will see. Read it back to the user. To see the file on a map, the user can drop it on the import page, `https://searchlight.jetlageuropa.org/games/import` (after signing in): it draws the play area, the hiding zones and each layer, runs the same checks, and only saves the game when they click import. The page sends files as compact JSON, so it skips the checker's warning about a formatted file over the 50 MB limit, which only matters when posting the file to the API yourself. Inside the Searchlight repo, also run `pnpm verify:preloaded-games` for preloaded games. `pnpm --filter @searchlight/api validate-game <id>` runs only the server validator, and only on a file already saved as `games/preloaded/<id>.game.json`.

## 8. Import, update, export

- **Web:** on `/games`, click **+ Import Game JSON**, which opens the import page, and pick the file. It draws the file on a map, lists the checker's findings, offers to fix overlapping regions, and previews the import with the server's validation before anything is saved. Importing a file whose `id` already exists updates that game.
- **Unlisted:** a new game can be imported unlisted (the import page's **Unlisted** box, or `&unlisted=true` on the API). It isn't offered when creating a session; everyone, game managers included, starts sessions of it through a game link. Game managers still see it on `/games`. Game managers change it later, and create or revoke links, on `/games` (**Make listed**/**Make unlisted**, **Links**). Updates keep the game's listing.
- **API:** `POST /games/import` with the definition (or `{"game": …}`) as the JSON body.
  - Add `?dryRun=true` to validate only, `&allowUpdate=true` to replace an existing game with the same `id`, and `&unlisted=true` to create the game unlisted.
  - Authenticate with the session cookie you get by signing in to the web app; Searchlight doesn't issue API tokens. You need the `games.create` permission (new game) or `games.edit` (update) on that server, or server admin. Without either, the import is refused before the definition is validated.
- **Who can import:** permissions come from Discord roles. A server admin grants them on `/admin`: click **Manage Roles** on the server, then tick `games.create` and `games.edit` for the role game devs hold. The change applies within a minute. Without them, `/games` shows no import button for that server.
  - Responses: `201` created; `200` updated or `unchanged`; `400` with `errors[]` (at most 100; `message` gives the total); `401` when not signed in; `403` for a missing permission or a server change; `409` if the game exists and `allowUpdate` isn't set.
  - The body limit is 50 MB. The checker sizes the file both as compact JSON and as it is on disk; post it compact (`JSON.stringify(game)`) if only its indentation takes it over.
- **Preloaded (Searchlight repo maintainers):** save the file as `games/preloaded/<id>.game.json`. The file name must equal the `id`. The API imports and updates these files on every start, so the file wins over an earlier web import of the same game. A file that fails to import is logged as an error and skipped; the other files still load.
- **Revisions:** every import with new content creates a new revision. Running sessions stay on the revision they started with. Content identical to the current revision is reported as `unchanged`; content identical to an older revision re-activates that revision (reported as `updated` with its number) instead of creating a new one.
- **Export:**
  - Web: **Export JSON** on `/games` (the current revision), or **Export Game JSON** under Options in the map's left drawer (the revision being played, which in a session started before an update is its pinned revision).
  - API: `GET /games/<id>/export`.
  - Edit the exported file and re-import it to update a game.

## 9. Common mistakes

- Positions written as `[lat, lng]`. GeoJSON is `[lng, lat]`, and swapped boxes still pass validation.
- KML altitude left in positions, or `GeometryCollection`/`MultiPoint` features. Run `normalize()`.
- `radars` or `thermometer` left out, expecting them to be on by default. They are off.
- Expecting the app to fill in museums, airports or train-station questions from OpenStreetMap. Nothing is filled in. Add the layer.
- Root `unit` set to something other than `hidingZones.unit`.
- Plural layer names ("Same Districts"), or two layers whose names slug to the same value.
- Names copied from KML or HTML without decoding (`<![CDATA[Gare d'Est]]>`, `Art &amp; Craft`).
- Two features with the same `id` in one layer, e.g. from slugging repeated names without `withIds()`.
- Matching enabled on a one-site layer or a single line.
- Rail lines split into many segment features with matching enabled.
- `bounds` or `center` copied from somewhere else instead of computed from the play area.
