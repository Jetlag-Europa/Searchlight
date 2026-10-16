# Adding a game

Every game is one self-contained JSON definition, `games/preloaded/<gameId>.game.json`, following the canonical schema (`https://sl-dev.jl-e.org/schemas/game-definition.v1.schema.json`). The definition is the whole game: the app offers exactly the questions it declares (radar and thermometer only when `radars`/`thermometer` enable them, matching/measuring/tentacles only from its `features` layers) and never falls back to OSM/Overpass for a game.

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
3. Start (or restart) the API. On boot, `preloadGameDefinitions` (`apps/api/src/games/preload.ts`) imports every `games/preloaded/*.game.json`, creating the game or adding a revision when the content changed. Content identical to an older revision re-activates that revision instead. A file that fails to import is logged at error level and skipped, and the other files still load, so check the log for `Failed to preload game definition`.
4. In the browser (`pnpm dev`, see the [README](../README.md)), switch to the game and confirm the play area, the hiding-zone count and radii, and that each question in the check's list appears and evaluates.

## Games uploaded by game devs

Game devs don't need the repo. They build the file with the skill (an AI agent can do it from the announcement's rules doc and Google My Maps link, see its section 1.1) and upload it at `/games` → **+ Import Game JSON**, which validates and previews it before saving. Uploading needs a Discord role with `games.create` (new games) and `games.edit` (updates) on the game's server. A server admin grants these on `/admin` → **Manage Roles**. Home Games has no roles, so only `ADMIN_DISCORD_IDS` can upload there. Uploaded games live only in the database; don't also add them to `games/preloaded`, or the file would overwrite web updates on every API start.

Users with game permissions can import through the web UI (`/games` → **+ Import Game JSON**) or `POST /games/import`. Exports and historical definitions are served only from the database, with access checks. Sessions load their pinned revision, and fork snapshots keep the revision captured with their questions. A session gives its participants access to that revision only; creating a session or upgrading it to the current revision needs the same server membership and role as reading the game.

On a server, game changes ship with a normal deploy: the definitions are part of the api image.
