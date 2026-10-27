# Adding a game

Every game is one self-contained JSON definition, `games/preloaded/<gameId>.game.json`, following the canonical schema (`https://searchlight.jetlageuropa.org/schemas/game-definition.v1.schema.json`). The definition is the whole game: the app offers exactly the questions it declares (radar and thermometer only when `radars`/`thermometer` enable them, matching/measuring/tentacles only from its `features` layers) and nothing is looked up in OSM/Overpass while playing.

The authoring guide is the game creation skill, `apps/web/public/skills/create-game.md` (served at `/skills/create-game.md`). It covers every field, how each layer type behaves in play, converting KML/GeoJSON/CSV/OSM data, and the quality rules the validator doesn't enforce. Its helper scripts are in `apps/web/public/skills/create-game/`.

## Steps

1. Build `games/preloaded/<gameId>.game.json` following the skill. The file name must equal the definition's `id`.
2. Check it:

   ```bash
   node apps/web/public/skills/create-game/check-game.mjs --strict games/preloaded/<gameId>.game.json
   pnpm verify:preloaded-games                     # every preloaded game: validator, file name, --strict checks
   pnpm --filter @searchlight/api validate-game <gameId>  # server validator only, on games/preloaded/<gameId>.game.json
   ```

   `check-game.mjs` fails on anything the import would reject, warns about problems that import fine but play badly (swapped coordinates, zones outside the play area, single-site matching, overlapping regions, heavy geometry), and prints the question list players will see. With `--strict` it also fails on the warnings that are always data defects (misplaced or swapped coordinates, duplicate zone or feature IDs, CDATA- or entity-wrapped names, single-feature matching, region layers no zone lies in, layers marked `noOverlaps` whose regions overlap). `pnpm verify:preloaded-games` runs the server validator, checks that each file name equals its game ID (the API refuses to preload otherwise), and applies the same strict checks to every preloaded game, exiting non-zero on any failure.

   To see the file on a map, drop it on `/designer` (no login; the file stays in the browser). It draws the play area, the hiding zones and each layer, with the same checks and the question list.
3. Start (or restart) the API. On boot, `preloadGameDefinitions` (`apps/api/src/games/preload.ts`) imports every `games/preloaded/*.game.json` whose content changed since the last start, creating the game or adding a revision and making it current. Content identical to an older revision (e.g. a reverted file) re-activates that revision instead. A file unchanged since the last start leaves its game alone, so a revision uploaded or re-activated since stays current (see [below](#games-uploaded-by-game-devs)). A file that fails to import is logged at error level and skipped, and the other files still load, so check the log for `Failed to preload game definition`.
4. In the browser (`pnpm dev`, see the [README](../README.md)), switch to the game and confirm the play area, the hiding-zone count and radii, and that each question in the check's list appears and evaluates.

## Games uploaded by game devs

Game devs don't need the repo. They build the file with the skill (an AI agent can do it from the announcement's rules doc and Google My Maps link, see its section 1.1) and upload it at `/games` → **+ Import Game JSON**. That opens the import page, `/games/import`, which draws the file on a map, shows `check-game.mjs`'s warnings, can fix overlapping regions, and previews what the import will do before saving. `/designer` draws a file on a map without logging in. Uploading needs a Discord role with `games.create` (new games) and `games.edit` (updates) on the game's server. A server admin grants these on `/admin` → **Manage Roles**. If the file's `id` is already taken, the import page says it will update that game and compares the two: a different name or a play area that doesn't overlap is flagged as a likely mistake, and the update then needs an extra confirmation. The page sends the revision it previewed (`expectedRevision`), and the import is refused (409 `REVISION_CHANGED`) if the game changed in between. An id taken by a game you can't edit (on another server, or someone else's Casual game) is refused; give the file a new `id`. Uploaded games live only in the database; don't also add them to `games/preloaded`, or a file that differs from the upload replaces it on the next API start.

A preloaded game can also be updated by upload (web or `POST /games/import`), including uploading an older version to roll it back. The update survives API restarts while the file stays unchanged: the API only applies a preloaded file when its content changed since the last start (it remembers the file's checksum per game). When it keeps a revision other than the file's, it logs a warning such as `games/preloaded/<gameId>.game.json is unchanged since the last start, but revision 2 was made current since; keeping 2`, counted as `kept` in the `Preloaded game definitions` line. Once the file's content changes, the next start applies it and makes it current, replacing the upload, so carry an upload's fix into the file before changing it.

Deleting a game (`/games` → **Delete**, `DELETE /games/:id`, needs `games.delete`) removes it with all its revisions, and is refused while the game has sessions: delete those first. A deleted preloaded game is created again from its file on the next API start; remove the file from `games/preloaded` to delete it for good.

Users with game permissions can import through the web UI (`/games` → **+ Import Game JSON**, which opens the import page, `/games/import`) or `POST /games/import`. The import page shows the file on the map with the checker's findings, and can fix overlapping regions before importing (see [Region overlaps](#region-overlaps)). Exports and historical definitions are served only from the database, with access checks. Sessions load their pinned revision, and fork snapshots keep the revision captured with their questions. A session gives its participants access to that revision only; creating a session or upgrading it to the current revision needs the same server membership and role as reading the game.

A game can be **unlisted** (the **Unlisted** box on the import page, `/games/import`, for a new game, or **Make unlisted** on `/games`). Unlisted games aren't offered when creating a session, and nobody, game managers and admins included, can start a session of one directly: everyone plays them through a **game link**. Only `/games` lists them, for the server's game managers (`games.create`, `games.edit`, `games.delete` or `server.admin`), who alone may still read their definitions. Game links (`/games` → **Links**, for game managers) work for listed games too. A link lets whoever holds it start sessions of the game, without server membership or the role gate, until it is revoked; listing or unlisting the game doesn't affect it. A session started from a link can be upgraded to newer revisions while that link is active.

### Casual Games

**Casual Games** (formerly Home Games, server id `home-games` in game files) is for games outside the JetLag servers, such as a game among friends. It has no Discord server of its own: who may create Casual games comes from a role on JetLag EU, which a global admin (`ADMIN_DISCORD_IDS`) maps to `games.create` on `/admin` → **Casual Games** → **Manage Roles**. No other permission can be mapped there. Casual games are always unlisted, and only their creator and global admins see them on `/games`. The creator can update their game (while they hold the role), export it and make game links for it; only global admins can delete one. Casual is never offered when creating a session: it only lists your existing sessions there, and every session of a Casual game starts from a game link, also for its creator.

On a server, game changes ship with a normal deploy: the definitions are part of the api image.

## Region overlaps

Neighbouring regions in a layer (provinces, boroughs) should share their borders exactly. Traced or simplified independently, they often overlap in slivers instead. A player in an overlap is in the first of its regions in file order, both for matching answers and for measuring to their own region's boundary.

The import page (and `/designer`) checks every region layer for overlaps, ignoring hairlines under 0.5 m wide or 1 m² in area. For each layer it shows how many overlaps there are, their total area, the widest, and how many hiding zones reach into one, and it can draw them on the map. **Fix** gives each overlap to the first region, as the app already does: each region loses what the regions before it cover, where it overlaps them by more than a hairline (regions that only touch are left as they were). So players stay in the regions they were in, and a distance to a border moves by at most the overlap's width. New corners are rounded to the layer's precision, but to no fewer than 6 decimals (about 0.1 m). A layer with a region entirely inside earlier ones can't be fixed: no one is ever in that region, so remove it or move it before them.

A fixed layer, or one without overlaps, is marked `"noOverlaps": true`. Without overlaps, the border of the region a player is in is also the nearest border of any region, so the app can answer "Distance to {name} Boundary" with one buffer around the whole border network. Download the fixed file from the page to keep your copy in step: importing the old copy again undoes the fix. Nothing on the server checks the mark, so a file edited after it was marked, or marked by hand, could still overlap: the import page refuses to import a marked layer that overlaps until it is fixed or the mark removed, and `check-game.mjs --strict` fails on one whose regions' borders reach more than 0.5 m into another region.

For files in the repo, `pnpm fix:region-overlaps [files]` makes the same fix (every preloaded game by default), and a web test checks that every preloaded region layer is marked and has no overlaps.

