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

   `check-game.mjs` fails on anything the import would reject, warns about problems that import fine but play badly (swapped coordinates, zones outside the play area, single-site matching, overlapping regions, heavy geometry), and prints the question list players will see. With `--strict` it also fails on the warnings that are always data defects (misplaced or swapped coordinates, duplicate zone or feature IDs, CDATA- or entity-wrapped names, single-feature matching, region layers no zone lies in). `pnpm verify:preloaded-games` runs the server validator, checks that each file name equals its game ID (the API refuses to preload otherwise), and applies the same strict checks to every preloaded game, exiting non-zero on any failure.

   To see the file on a map, drop it on `/designer` (no login; the file stays in the browser). It draws the play area, the hiding zones and each layer, with the same checks and the question list.
3. Start (or restart) the API. On boot, `preloadGameDefinitions` (`apps/api/src/games/preload.ts`) imports every `games/preloaded/*.game.json` whose content changed since the last start, creating the game or adding a revision and making it current. Content identical to an older revision (e.g. a reverted file) re-activates that revision instead. A file unchanged since the last start leaves its game alone, so a revision uploaded or re-activated since stays current (see [below](#games-uploaded-by-game-devs)). A file that fails to import is logged at error level and skipped, and the other files still load, so check the log for `Failed to preload game definition`.
4. In the browser (`pnpm dev`, see the [README](../README.md)), switch to the game and confirm the play area, the hiding-zone count and radii, and that each question in the check's list appears and evaluates.

## Games uploaded by game devs

Game devs don't need the repo. They build the file with the skill (an AI agent can do it from the announcement's rules doc and Google My Maps link, see its section 1.1) and upload it at `/games` → **+ Import Game JSON**, which validates and previews it before saving, and shows `check-game.mjs`'s warnings. `/designer` draws a file on a map without logging in. Uploading needs a Discord role with `games.create` (new games) and `games.edit` (updates) on the game's server. A server admin grants these on `/admin` → **Manage Roles**. Home Games has no roles, so only `ADMIN_DISCORD_IDS` can upload there. Uploaded games live only in the database; don't also add them to `games/preloaded`, or a file that differs from the upload replaces it on the next API start.

A preloaded game can also be updated by upload (web or `POST /games/import`), including uploading an older version to roll it back. The update survives API restarts while the file stays unchanged: the API only applies a preloaded file when its content changed since the last start (it remembers the file's checksum per game). When it keeps a revision other than the file's, it logs a warning such as `games/preloaded/<gameId>.game.json is unchanged since the last start, but revision 2 was made current since; keeping 2`, counted as `kept` in the `Preloaded game definitions` line. Once the file's content changes, the next start applies it and makes it current, replacing the upload, so carry an upload's fix into the file before changing it.

Deleting a game (`/games` → **Delete**, `DELETE /games/:id`, needs `games.delete`) removes it with all its revisions, and is refused while the game has sessions: delete those first. A deleted preloaded game is created again from its file on the next API start; remove the file from `games/preloaded` to delete it for good.

Users with game permissions can import through the web UI (`/games` → **+ Import Game JSON**) or `POST /games/import`. Exports and historical definitions are served only from the database, with access checks. Sessions load their pinned revision, and fork snapshots keep the revision captured with their questions. A session gives its participants access to that revision only; creating a session or upgrading it to the current revision needs the same server membership and role as reading the game.

A game can be **unlisted** (the import dialog's **Unlisted** box for a new game, or **Make unlisted** on `/games`). Unlisted games aren't offered when creating a session, and nobody, game managers and admins included, can start a session of one directly: everyone plays them through a **game link**. Only `/games` lists them, for the server's game managers (`games.create`, `games.edit`, `games.delete` or `server.admin`), who alone may still read their definitions. Game links (`/games` → **Links**, for game managers) work for listed games too. A link lets whoever holds it start sessions of the game, without server membership or the role gate, until it is revoked; listing or unlisting the game doesn't affect it. A session started from a link can be upgraded to newer revisions while that link is active.

Listed games also appear on `/browse` ("Find a game") for everyone who can play them, across all their servers. A server whose admins set a Discord invite on `/admin` also shows its listed games without a role gate to those who aren't in it, greyed out with the invite. It places a game by its definition's `map.center` and `map.bounds`, so a search for any place inside the bounds finds it; set `bounds` to the play area's extent.

On a server, game changes ship with a normal deploy: the definitions are part of the api image.
