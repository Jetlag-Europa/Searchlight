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
3. Start the API. On boot, `preloadGameDefinitions` (`apps/api/src/games/preload.ts`) imports every `games/preloaded/*.game.json`, creating the game or adding a revision when the content changed. Content identical to an older revision re-activates that revision instead. A file that fails to import is logged at error level and skipped, and the other files still load, so check the log for `Failed to preload game definition`.
4. In the browser (`pnpm dev`), switch to the game and confirm the play area, the hiding-zone count and radii, and that each question in the check's list appears and evaluates.

Users with game permissions can instead import through the web UI (`/games` → **+ Import Game JSON**) or `POST /games/import`. Exports and historical definitions are served only from the database, with access checks. Sessions load their pinned revision, and fork snapshots keep the revision captured with their questions. A session gives its participants access to that revision only; creating a session or upgrading it to the current revision needs the same server membership and role as reading the game.

## Private games

A game can be **unlisted** (shown as *Private* in the UI): it stays out of the game picker, and only the people who manage it can start sessions of it or export it directly. Everyone else plays it through a **game link** (`/join?token=g_…`). Each time someone opens the link and starts, they get a new private session of the game's current revision. They don't need to be in the game's Discord server, and the game's role gate doesn't apply. From there the usual session invites and share links work, so access can spread from session to session. Sessions of a private game can upgrade to its newer revisions. The grant is recorded on each session started from a link or forked from a private game's session, so those sessions keep upgrading even after the game is made public. Other sessions of a public game need the creator's server membership to upgrade.

- **Who manages a game:** admins, holders of `games.edit` on its server, and the user who imported it while they still hold `games.create` or `games.create-unlisted` there. Managers see the game's links in `/games` → **Links**, where they create, copy and revoke them. Revoking a link stops new sessions from it; sessions already started keep working.
- **Trusted uploaders:** grant a role `games.create-unlisted` in `/admin`. Its holders can import new games, which are always private and owned by them. They can update and delete their own games and manage their links, but they can't publish them or touch other games.
- **Publishing:** `games.create` holders can create a private game by ticking **Private game** in the import dialog (or `POST /games/import?listing=unlisted`). Making a game public (`PATCH /games/:id {"listing":"listed"}`) needs `games.create` or `games.edit`, and revokes its links, because a public game is for its server's members. Re-importing a game never changes whether it is private.
- Preloaded games are always public.

## Appendix — Production deployment & preloading

Preloading in production is automated:
- The API container runs `preloadGameDefinitions` on startup, loading definitions from `games/preloaded/`.
- Schema migrations (`prisma migrate deploy`) manage database schema updates independently of game content.
- Preloading is idempotent: games are matched by canonical ID and updated if their revision or content changes. Existing revisions are never rewritten, since sessions are pinned to them.
- Before the API starts, the container creates any missing Discord servers (`seed.js --missing-only`), because a game's server must exist for it to load. Existing servers' names and role mappings are left alone; `pnpm --filter @searchlight/api seed:prod` runs the full seed that resets them.
