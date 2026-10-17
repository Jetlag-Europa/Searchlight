# Changelog

## Docs for a public repo (2026-10-18)

- `DEPLOY.md` clones the repo over HTTPS. A read-only deploy key is still the way to clone over SSH. A server only needs `docker login ghcr.io` if the GHCR packages are private; public packages and `--build` need no login.
- A new `SECURITY.md` asks for vulnerabilities to be reported privately on the repo's Security tab, not in public issues.

## Game stats for server admins (2026-10-17)

- On the games page, each game shows how much it is played, to anyone with `server.admin` on its server (global admins have that on every server): sessions live now and the players connected to them, sessions active in the last 24 hours and 7 days, sessions and players in total, questions asked across all sessions, and when it was last played. A session counts as active when it was created or had an event in that window.
- The numbers come from the new `GET /games/stats?serverId=`. It answers counts per game only, with no session ids, names, players, contents or links, so it can't lead anyone into a session. Game managers without `server.admin` get a 403.
- "Live now" counts the sessions with an open live-sync connection to this API process. It starts at 0 after the API restarts.
- The games page now also lists the servers where someone holds only `server.admin`. Its buttons show only what the API already allowed them, such as listing and links.

## The server picker lists only your servers (2026-10-17)

- The session picker lists the Discord servers you're in, plus Home Games. Servers you aren't in no longer show up, so picking one no longer leaves an empty game list (the API refused their catalog with a 403).
- A server you aren't in still shows up when you have sessions there, e.g. from a game link or an invite link. Its sessions open as before; instead of "+ New session" the picker says you can only open sessions shared with you there. Such a server stays listed while Discord can't be reached, since its sessions don't need Discord.
- Opening such a session no longer asks for the server's game list either (another 403 in the console). The board only used it for the game's size, which sets the zoom from which zone names show, and fell back to "medium" without it. It now reads the size from the game it loaded, so it also follows the session's pinned revision.
- `GET /servers` returns these servers with a new `isMember` flag (false for servers listed only for their sessions, with no permissions). Admins (`ADMIN_DISCORD_IDS`) still see every server. The list re-checks servers you weren't in every 10 minutes, so after joining a Discord server it shows up within 10 minutes.

## Tests run on pull requests (2026-10-17)

- A new "Tests" workflow runs on every pull request and every push to `main`. It builds the workspace, then runs the shared, web and API unit tests (the API tests against a Postgres service), `pnpm verify:preloaded-games` and `pnpm check:game-schema`. Before this, CI never ran the tests. Pull requests only had the image builds, and those stopped running on pull requests on 2026-10-16. The Playwright e2e tests still run by hand only.

## Sessions are shared by link only (2026-10-17)

- Inviting a specific user by username is gone; links are how a session is shared. The Invites drawer makes, copies and revokes invite links that let anyone with the link join the session, and Share a copy does the same for share links that give them their own private copy. Both drawers lost their "Send to user" tab with its user search and pending list, the Invites button lost its badge and its list of incoming invites to accept or decline, and both buttons show only to the session's creator.
- The API drops `GET /users/search`, `GET /sessions/pending-invites`, `POST /sessions/invites/:id/accept` and `/decline`, `GET`/`POST /sessions/:id/invites` and `DELETE /sessions/:id/invites/:id`, and `GET /sessions/:id/participants`, which only the user search used (`GET /sessions/:id` still lists participants). This fixes the review finding that user search let any logged-in user list every user of the app. Cached clients that still call these get 404s, which they treat as no invites and no search results.
- The `20261017020000_drop_invites` migration drops the `Invite` and `InviteSnapshot` tables. Invites still pending are dropped with them; send a link instead. Players who already accepted an invite stay in the session, and share links keep their own question snapshots (`LinkSnapshot`).

## Security hardening (2026-10-17)

- Hiding-zone names on the map and station names in their popups are shown as text. They come from the game definition, and Leaflet rendered them as HTML, so an imported game could run script in every player's browser.
- `POST /games/import` turns away a logged-in user who can't import on any server (no `games.create`, `games.edit` or `server.admin` on a server they are in, and not a global admin) with a 403 before reading the body, which can be up to 50 MB. Import tokens, and the check against the target server, are unchanged.
- Server errors (5xx) answer "Internal Server Error" instead of the error's own message, which could carry database details; the full error is logged. Client errors (4xx), including validation errors, keep their messages. `PUT /sessions/:id/questions` rejects a fractional `ordinal`, or one above 2147483647, with a 400 instead of failing in the database, as `GET /sessions/:id/events` does for such an `after`; `GET /games/:id/revisions/:revision` answers 404 for such a revision number.
- The API refuses to start with `ENABLE_TEST_AUTH=1` when `NODE_ENV` is `production`. The e2e stack sets `NODE_ENV=development`, so it keeps its test login.
- The join page and the login redirect after it encode the link token in their API requests, as the play page does.
- The web server sends `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY` with every response, so other sites can't frame the app. `public/_headers` sends the same when the web app is served from Cloudflare.

## Curses that resize the hiding zones (2026-10-17)

- A curse that makes the hiding zones bigger or smaller can be added to the question list with Add Question → Resize Hiding Zones (Curse). Its card takes a multiplier (starting at ×1.5; ×1.5 and ×0.5, the game's usual curses, are one tap; any positive number can be typed) and shows the zone radius from that point on.
- The list runs in the order things happened: questions below the curse are checked against zones at the new size, questions above it against the size they were asked at. A hider who answered from the edge of a 1 km zone isn't wrongly ruled out when the zones later shrink to 500 m, and a question asked after the zones doubled counts the whole larger zone. A curse added late can be moved to where it was cast with its Earlier and Later buttons.
- Curses multiply (two ×1.5 curses make zones 2.25 times the game's size; a ×0.5 undoes a ×2), a hidden curse counts as ×1, and the zones on the map and the Hiding Zone Radius in the zone sidebar are drawn at the current size. Polygon zones keep their own area.
- A curse is stored in the session's question list as `{"id": "zone-size", "data": {"multiplier": 1.5}}`, so it syncs, shares and pastes like a question. Clients from before this release don't know it and hide it; if one of them then edits the list, it saves the list without the curse.

## Pens erase with their eraser button (2026-10-17)

- In Pen Mode, a pen's eraser (the flipped end, or the eraser button on pens like the Lenovo Pen Pro or Surface Pen) and its barrel (side) button erase, whatever tool is chosen. Hold the button as the pen touches down: Windows reports these buttons only then, while browsers that report a press mid-stroke switch on the spot. Letting go returns to that tool, and the toolbar shows the eraser as active meanwhile. The barrel button's right-click no longer opens the map menu after erasing.
- In Pen Mode, a right or middle mouse button no longer draws a stroke.

## Dev login on preview deployments (2026-10-17)

- When `DEV_LOGIN_TOKEN` is set (at least 32 characters), the API registers `/auth/dev-login`: `GET` serves a small form, and `POST` (form, or JSON with `Authorization: Bearer <token>`) logs in as any Discord user ID without Discord, so testers and agents can act as specific users on PR previews. A real Discord user gets their profile from the bot and their servers and roles as usual; any other numeric ID becomes a placeholder user. A wrong token gets a 403. Prod never sets the token, and without it the routes don't exist. See `docs/TESTING.md`.

## Measuring questions show your distance (2026-10-17)

- A measuring question's card shows how far the seeker is from what it measures to, and which one is nearest when the game names them: "Your distance: 1.243 km to Brussels Airport", or "… to the Antwerpen boundary" for a region boundary. Custom measures show the distance to what is drawn. The distance is the geodetic one the map's measuring circle is drawn with, in the Default Unit to three places (meters under 1 km, then 1.123 km; feet under 0.1 mi, then 1.123 mi), and updates when the seeker moves.
- In hider mode the card also shows the hider's distance, so the automatic Closer/Further answer can be checked.

## Slow question results say they are calculating (2026-10-17)

- When the map takes longer than half a second to work out the questions' results (the eliminated area and then the hiding zones left in it), a small "Calculating…" pill appears under the Live indicator until both are done, so a slow answer such as a region-boundary question on Belgium no longer looks like a hung page. Quick answers don't show it, and an answer replaced mid-calculation doesn't end it early.

## Question names (2026-10-17)

- Every question card has a Name field, so a radar, thermometer, tentacle, matching or measuring question can be called "Airport radar" instead of only "Radius 2". A named card shows the name above its type and number, also while it is collapsed or hidden, and its map marker shows the name on hover. The name saves when you leave the field or press Enter, and syncs with the session like the rest of the question; clearing it goes back to the numbered label.
- Names travel with a question's JSON (`data.name`, at most 60 characters), so Share and Paste Question keep them. A question without a name has no `name` key, and a malformed name is ignored rather than rejecting the question.

## Region-boundary questions cover the whole play area (2026-10-17)

- A game's regions can fall short of its play area, as Belgium's provinces do along the French border, between neighbouring provinces and at sea. Distance-to-region-boundary questions treated a point in no region as infinitely far from any boundary, so those strips always survived "Hider Further" (drawn as dashed fragments along the border) and were always eliminated by "Hider Closer". A point in no region is now measured to the nearest region's boundary, for the seeker, the hider's automatic answer and the map alike.
- The eliminated area is built as every region's boundary buffer minus the parts of each region farther than the seeker from its own boundary, in the geometry worker, so no hairline slivers are left along the seams between regions and less of the work blocks the page.

## No Overpass proxy or boundary lookups in the API (2026-10-17)

- There is no free play: every session plays a JSON-defined game. The API drops what only free play used: the Overpass proxy (`POST /overpass`) and OSM boundary lookups (`/boundaries`). The web app stopped calling them in the same release (see below); cached clients that still do get 404s.
- The `20261017010000_drop_boundary_cache` migration drops the `BoundaryCache` table, a cache of OSM boundaries.
- `OVERPASS_URL`, `OVERPASS_CF_ACCESS_CLIENT_ID`, `OVERPASS_CF_ACCESS_CLIENT_SECRET` and `OVERPASS_MAX_RESPONSE_BYTES` are no longer read; remove them from a server's `.env`. The e2e stack has no Overpass stub (`infra/overpass-stub.conf` is removed), and `infra/deploy-test.sh` removes the old stub container.

## Every session plays its game (2026-10-17)

- Free play, inherited from JetLagHideAndSeek, is gone. It no longer runs behind the session picker (the default Luxembourg boundary isn't fetched any more) or when a session's game fails to load, and questions are only ever answered from the session's game.
- When a session's game can't be loaded (offline, a server error, no access), a "Game not loaded" banner with Retry and Change session appears under the map, alongside the revision banner. The board stays visible and the drawing tools keep working, but until the game has loaded Add Question, the map's Add items and hider mode are disabled and no question is evaluated. Radars, thermometers, the game's layer questions and custom questions are kept meanwhile, also in the cached board shown while loading; questions from the old built-in catalogue are hidden, as they already were once a game loaded. A revision upgrade that fails to load still shows the revision banner's own error. A session switch that fails no longer leaves the previous session's game, hider or planning mode on the board, and the session picker can be closed (Back to board, or Escape) whenever a session's board is showing.
- Removed the free-play tools that could overwrite a game's play area, questions or settings: the place picker (with "Clear Questions & Cache"), drawing a play area with the polygon tool (it still draws custom questions), the map's "Exclude Country" item, Copy/Paste Hiding Zone and `?hzc=`/`?pb=` links, the hidden Share and Tutorial buttons, the tutorial, and the Pastebin settings, which are no longer synced as preferences.
- Hiding zones always come from the game. The zone sidebar no longer looks up stations in OpenStreetMap, offers OSM place types or other games' zones, imports custom station lists (CSV, GeoJSON, KML) or merges duplicate stations, and it shows the game's hiding-zone radius instead of an editable one. A game's Polygon and MultiPolygon hiding zones are drawn and eliminated as their own areas.
- Questions and hiding zones never query OpenStreetMap/Overpass (only the coordinate fields' place search uses Photon, as before). The map frames each game when it loads, and after a reload shows the game it last framed (or the world) until then. The settings and map caches the removed features left in the browser are cleared.
- Changing the Default Unit no longer changes the game's hiding-zone radius unit, and hider mode starts at the game's centre.
- The old built-in question types are gone: airports, major cities, McDonald's and 7-Eleven, train stations and lines, station names, OSM zones, high-speed rail, international borders, the theme park, zoo, aquarium, museum, hospital, cinema and library tentacles, the "Small+Medium Games" and "Hiding Zone Mode" variants, and the hiding-zone filters they drove. Questions of these types still stored in a session are hidden, and are dropped from the session the next time its questions are saved.
- Switching a game's matching question to Custom Zone or Custom Points always starts blank and asks you to draw; "Copy from current" used to leave a Custom Zone empty without a word. Only Custom Points to Custom Zone can still copy (the seeker's cell), so only it asks, and its setting is now called "Custom Points to Custom Zone". Switching a measuring question to Custom Measure always starts blank, as only the built-in types had anything to copy.
- Custom zones, points and measures with nothing drawn yet, such as new ones from Add Question or the map menu, or a zone started blank, no longer break the map; they eliminate nothing until something is drawn. Clearing a radar or tentacle radius field keeps the last radius instead of saving an empty one.

## Hider mode turns off again (2026-10-17)

- Turning hider mode off saved the hider's position as 0, 0 instead of clearing it, so hider mode came straight back on at that point, also after a reload. `PATCH /sessions/:id` now stores `hiderLat`/`hiderLng` `null` as null and 0 as 0: its body schema checked them as a number first, and the request validator turned `null` into 0.
- The `20261017003000_clear_zero_hider_positions` migration clears the 0, 0 positions sessions saved this way, so they no longer open in hider mode.

## Session invites and share copies (2026-10-17)

- The new-session form no longer asks for Private or Shared. The choice changed nothing: every session starts with only its creator, and it becomes shared when the creator invites someone. `POST /sessions` now treats `visibility` as optional, defaulting to `private`.
- `POST /sessions/:id/invites` makes the session shared when it sends an invite to join, as creating a join link already did, and accepting one does too, for invites sent before this change. The web app no longer PATCHes visibility first. That PATCH replaced the active session with a response that lacked its revision fields, which could load the wrong game revision and hid the revision banner. `PATCH /sessions/:id` now returns those fields too.
- A user can have a pending invite to join and a pending copy at the same time; before, the second was refused with a 409 that the drawers didn't show. Inviting someone already in the session is refused, and the Invites search leaves current members out.
- The Share drawer, now "Share a copy", lists only pending copies. It listed invites to join as well.
- The Invites and Share a copy drawers show why sending failed, and the join page shows why redeeming a link failed.
- Accepting a copy sent to you makes you a participant of the new session, as redeeming a share link already did, so you appear in its participant list.
- A creator opening their own invite link is taken to the session instead of getting an error.
- Kicking someone who isn't in the session answers 404 instead of 500.

## Unlisted games and game links (2026-10-17)

- A game can be unlisted: it is no longer offered when creating a session, and sessions of it start only from a game link, for everyone including game managers and admins (`POST /sessions` refuses it). `/games` still lists it for the server's game managers (`games.create`, `games.edit`, `games.delete` or `server.admin`; `GET /games?includeUnlisted=true`), who alone may still read its definitions. New games can be imported unlisted (the import dialog's **Unlisted** box, or `POST /games/import?unlisted=true`); game managers can change it on `/games` with **Make unlisted**/**Make listed** (`PATCH /games/:gameId`). Updating a game by import keeps its listing.
- Game links start sessions of one game, listed or unlisted: `/play?token=…` asks for a session name and opens the new session on the map. Whoever holds a link can use it without server membership or the game's role gate. Links don't expire and don't change when the game is listed or unlisted; they end only when revoked. Game managers create, copy and revoke them on `/games` → **Links** (`GET`/`POST /games/:gameId/links`, `DELETE /games/:gameId/links/:linkId`). Sessions started from a link keep working after it is revoked, and can be upgraded to newer revisions while it is active.
- When the server's game catalog can't be read, a session's game is labelled with its game name, not the session name.
- The session picker has a cog that opens `/games` for users with `games.create`, `games.edit` or `games.delete` on any server.
- The session picker still lists sessions on servers whose game catalog the user can't read, instead of failing to load them.
- The `20261017000000_unlisted_games_and_game_links` migration adds `Game.unlisted`, the `GameLink` table and `GameSession.gameLinkId`.

## Overpass proxy limits (2026-10-16)

- `POST /overpass` clamps each query's `[timeout]` to 80 s and `[maxsize]` to 512 MiB, adding them when the query doesn't set them.
- Overpass responses are read up to `OVERPASS_MAX_RESPONSE_BYTES` (default 50 MiB). Larger ones are cancelled and fail with a 502, for `/overpass` and `/boundaries` alike.
- `POST /overpass` is rate limited per user: bursts of 120 requests, then 60 per minute, and at most 6 at once. Over the limit it answers 429.

## Bug reports and feature requests on GitHub Issues (2026-10-16)

- The in-app feedback feature is removed: the `/feedback` and `/admin/feedback` pages, the API's `/feedback` routes, the Discord feedback webhook (`DISCORD_FEEDBACK_WEBHOOK_URL`, and the `searchlight.png` avatar it posted with) and the shared feedback types.
- The map menu's Feedback button is now "Report a bug / suggest a feature", which opens [GitHub Issues](https://github.com/Jetlag-Europa/Searchlight/issues/new/choose) in a new tab. The tutorial's help line links there too, instead of the upstream JetLagHideAndSeek issues.
- The `20261016000000_drop_feedback` migration drops the `Feedback`, `FeedbackVote` and `FeedbackImage` tables and everything in them. Export them before deploying if you want to keep them.

## Docker images from main only (2026-10-16)

- The "Docker images" workflow runs only on pushes to `main` and manual runs on `main`. Pull requests and other branches no longer build images.

## Game creation for game devs (2026-10-16)

- The game creation skill (`/skills/create-game.md`) covers the usual starting point: a Discord announcement linking a rules Google Doc and a Google My Map. Section 1.1 explains how to download both, which fields come from where, and how to map the rules' feature table to question layers and kinds. It also covers common My Maps problems: mixed POI layers, placeholder names, regions drawn as several shapes and drawn zone circles. The game is copied as drawn, with nothing added, simplified or derived.
- `game-tools.mjs` gains `myMapsKmlUrl()`, `googleDocTextUrl()`, `decodeText()`, `mergeByName()`, `groupBy()` and `circleRadius()`. `normalize()` decodes CDATA and entities in kept strings and takes a `name` option to read names from another property.
- The guide and `docs/ADDING_GAMES.md` explain who can upload: a Discord role with `games.create`/`games.edit`, granted on `/admin` → **Manage Roles**. Home Games uploads are admin-only. The radar section matches the single Add Radius button.
- The import dialog links to the guide.

## Simpler setup and deployment (2026-10-16)

- Development is `cp .env.example .env`, four Discord/session values, `pnpm install`, `pnpm dev`. `pnpm dev` starts Postgres (`docker-compose.dev.yml`), builds and watches the shared package, and runs the API (migrating and creating servers first) and the web app. The web app reads `PUBLIC_API_BASE` from the root `.env`; `apps/web/.env` is gone. The API's `prisma`, `seed` and `seed:test` scripts read the root `.env` too.
- `docker-compose.yml` is the whole stack, pulling the CI images from GHCR or building them with the same names. Overlays add the way in: `docker-compose.cloudflared.yml` (production, was `docker-compose.vps.yml`) or `docker-compose.backend.yml` (API on a host port, now an overlay too). A server picks one with `COMPOSE_FILE` in `.env` and names its stack with `COMPOSE_PROJECT_NAME`, so `docker compose` needs no flags there. The API's `DATABASE_URL` is built from `POSTGRES_PASSWORD`.
- `infra/deploy-vps.sh` is removed: a deploy is `git pull`, `docker compose pull`, `docker compose up -d` (or `up -d --build`). `docker-compose.yml` refuses to run without `COMPOSE_PROJECT_NAME`. `infra/backup.sh` follows `.env` too.
- The e2e stack is `searchlight-test` and needs no `.env.test`.
- `README.md` (replacing `SETUP.md`), `DEPLOY.md` and `docs/TESTING.md` (replacing `TESTING_PLAN.md`) are rewritten for the current setup.

## Question layers for Brno, Brussels and OLD Luxembourg (2026-10-15)

- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 were converted with no question layers, so they offered no matching, measuring or tentacle questions; before the conversion these came from live OpenStreetMap lookups and bundled files. They now carry their own layers:
  - Brno 2026: its pre-conversion POI file (`brno-poi-v2.kml`): Museum, Airport, Park, Hospital, Library, Theme Park, Zoo, Golf Course, Cinema, Body of Water (measuring only, was `brno-water`) and its 29 districts (matching only, was `brno-district`).
  - Brussels 2026: Belgium 01.08's Airport, Museum, Cinema, Golf Course, Theme Park, Zoo, Consulate, Library, Hospital and High-Speed Rail layers, keeping each site that is the nearest of its kind somewhere in the play area or within 25 km of it.
  - OLD Luxembourg 2026: Luxembourg 2-3 October's layers for the same play area, without its stop-distance and Castle or Fort questions. Its four hospitals are the ones the old `lux-hospitals` question used.
- Point layers where only one site is ever the nearest are measuring only (Brno's and Brussels' airports).

## Deployment: CI-built images and cleanup (2026-10-15)

- A "Docker images" GitHub Actions workflow builds the `api` and `web` images for `linux/amd64` and `linux/arm64` (natively, one runner per platform) on every push to `main` and pushes them to GHCR as multi-platform `ghcr.io/jetlag-europa/searchlight-{api,web}`, tagged `sha-<commit>` and `latest`. Pull requests build them without pushing.
- `infra/deploy-vps.sh` pulls the images of the checked-out commit instead of building on the server (`--build` keeps the build-from-source path) and removes unused images older than a week. The server needs a one-time `docker login ghcr.io` and a clone that tracks `Jetlag-Europa/Searchlight` (see `DEPLOY.md`).
- `DEPLOY.md` is the one deployment guide (production and Discord redirects), without machine-specific details. `docs/VPS_Setup.md` is folded into it and the completed migration plan `docs/VPS_MIGRATION.md` is removed.
- Removed the outdated Mac mini setups: the production and dev stacks (`docker-compose.prod.yml`, `docker-compose.dev.yml`, `infra/deploy-prod.sh`, `infra/deploy-dev.sh`, `.env.dev.example`, the API's `seed:dev`), their hostnames in the web app's site URL and social meta tags, and the remaining references in docs and comments. API tests default to the local Postgres on port 5433.
- Removed the GitHub Pages workflow (it only ran on `master`, which this repo doesn't have) and the `TUNNEL_TOKEN` placeholder. `infra/backup.sh` writes to `backups/` next to the clone by default, so its cron line needs no overrides.

## Master integration and review fixes (2026-10-13)

Games and data
- Rebase onto master and bring its later games into the JSON format: Greater Manchester 19-09, North London 26-09 (with its 55 council-listed parks) and Stockholm 19-09. Rotterdam 12-09's municipality-border measuring was already ported. Master's legacy assets, per-game modules and generator scripts are removed. Not carried over: Greater Manchester's library questions (answered live by Overpass, no bundled data) and North London's station-name length (no JSON equivalent).
- Fix Brno 2026, Brussels 2026 and OLD Luxembourg 2026, whose converted play areas were `[lat, lng]` boxes that put every hiding zone outside the map; they use the OSM boundaries they loaded before the conversion.
- Normalize every preloaded definition to the authoring guide: decoded names (no CDATA), unique feature IDs, singular Title Case layer names ("Same Ward", "Nearest Golf Course"), single-site layers measuring only, one feature per named line, 6-decimal positions, and lighter Belgium/Milan region layers. Each zone's answers are unchanged.
- Duplicate layer names are a validation error, and compiled datasets are keyed by layer position, so layers whose names slug alike can't read each other's data.

Server
- The database is reset with this release: legacy sessions are not migrated, the `convert:legacy-sessions` command is gone, and every session must be pinned to a game revision.
- Access: creating or upgrading a session needs the game's server membership and role gate; a session only exposes its pinned revision. Server membership is recorded explicitly instead of inferred from any cached role lookup.
- Imports: authenticate before reading the body, serialize concurrent imports, never rewrite a stored revision (re-importing older content re-activates its revision), constrain game IDs to slugs, and keep preloading the other files when one fails. Container start only creates missing servers, so revoked role mappings stay revoked.
- Imports to an unregistered server report `SERVER_NOT_FOUND` instead of a permission error. When a game is updated while a session upgrade waits for the session lock, the new revision's access check runs after the lock is released (it can call Discord), and the upgrade retries.
- Auth diagnostics: `apps/api/scripts/auth-walls.sh` groups 401s by client and time window, since the page-load correlation header is not adopted.

Sync
- Loading or switching sessions can no longer save one session's questions into another, and restoring a session keeps edits that haven't reached the server.
- Failed sends retry with backoff while online; remote question changes that land just after our own are applied; flushes run on page hide and tab switch, without keepalive on session switch.
- Closed event streams reconnect from the last applied event; sessions the server reports gone (403/404) are forgotten along with their cached data, while transient errors keep them. A revision upgrade is published only after its board loads. Storage access is guarded everywhere for privacy modes.
- The echo of our own question save no longer undoes newer local edits, and a loading session stays read-only until it is reconciled with the server.

Geometry
- Nearest-line matching builds its partition once per layer in the worker (seconds to minutes per marker move before, now milliseconds after the first).
- Tentacles use the geodesic radius circle, so a hider just inside the radius isn't eliminated; hider-mode measuring uses the same geodetic distances as the map.
- Measuring buffers only the features that can reach the map, with a tolerance scaled to the distance, a smaller cache, and stale worker jobs skipped.
- A refresh that reused geometry a newer marker position superseded starts over instead of reporting "No solutions found".
- Remove the unused POI override layer and operators; free play rejects game-only question IDs; unpinned game loads always fetch the latest definition.

Interface and tools
- Radars start at the game's declared radii (Add Question offers one button per radius, the card offers them as quick picks), and matching/measuring/tentacles add a custom question when the game has no layer for them. Export Game JSON in the map drawer exports the revision being played. Sessions still open when the game catalog can't be fetched, the free-play boundary is never fetched while a session's game loads, and the revision banner shows a reactivated older revision as current. The import preview honours the root `unit`, shows radars as off when omitted, shows the thermometer, and lists only servers the user can import to.
- `check-game.mjs` also flags undecoded (CDATA/entity) names, repeated feature IDs, region layers no zone lies in, out-of-range bounds, numeric tiers and plural layer names, and gains `--strict`. `pnpm verify:preloaded-games` now fails on file name/ID mismatches and on the strict checks. `game-tools.mjs` skips CSV rows without coordinates, coerces numeric KML radii, and throws on missing input or mixed-family layers.
- The web app passes its ESLint rules.
- Correct the setup, deployment, testing and authoring docs (required bot token, admin IDs, test database, preloading on boot, production on the VPS).

## Games declare all their questions (2026-10-12)

- A game offers only what its definition declares. Radar and thermometer are now opt-in (`radars: true | [radii]`, `thermometer: true`); every preloaded game already sets both, so none changes.
- No OpenStreetMap/Overpass fallback inside a game: generic question types (pasted, from the map's context menu, or picked in a card's type list) are rejected or hidden; only the game's compiled questions and player-drawn custom questions remain. Tentacle locations come only from the game's layers.
- Rewrite the game creation skill (`/skills/create-game.md`) against the actual runtime, and add `game-tools.mjs` (KML/GeoJSON/CSV/OSM conversion and normalization) and `check-game.mjs` (validator-equivalent errors, play-quality warnings, and the generated question list). Point `docs/ADDING_GAMES.md` at it and drop its obsolete Overpass-fallback guidance.

## Luxembourg 2–3 October and load toast (2026-10-01)

- Add the Luxembourg 2–3 October 2026 game. Simplify its canton, former-district and international-border geometry (~11 m tolerance) so measuring stays responsive, and drop matching from its single-site layers (amusement park, aquarium, airport), which always answered "same".
- Stop the spurious "At least one place type must be selected" toast on session load: hiding-zone initialization now waits for an in-flight game switch instead of treating its transient empty selection as an error.

## Gameplay save fixes (2026-09-25)

- Keep gameplay saves debounced, persist each queued snapshot before network dispatch, and serialize live saves with reconnect replay so failed writes cannot roll back newer answers or settings.
- Restore hider/planning state from a fresh session snapshot after replay. Use physical POI identity when filtering legacy matching answers inside a hiding zone.
- Keep the revision notice compact and out of map controls, with confirmation and a plain loading/error state. Resolve revision upgrades under the session lock.

## JSON game session and geometry correctness (2026-09-23)

- Keep matching and tentacle answers tied to physical POI locations even when imported features reuse IDs; repair clustered-point Voronoi partitions and competing-line previews.
- Measure region-boundary answers against each candidate's own region using the same ArcGIS geodetic metric for the answer and buffer, including candidates outside all regions. Offload hiding-zone intersection filtering and coalesce obsolete refreshes.
- Preserve unsent edits on session changes, replay commit-ordered paginated events, close revoked SSE streams, and persist content with its event before acknowledging writes.
- Bound game/session caches and location searches; prevent stale map layers, imports, and question-card edits from overwriting newer state. Keep independent loading operations from unlocking controls prematurely.
- Keep offline queues and snapshots tied to their verified account; make duplicate and failed PATCH saves retryable, and prevent a create/delete race from resurrecting annotations.

## JSON game planning and performance fixes (2026-09-22)

- Share compiled question geometry between planning and evaluation: restore matching/measuring outlines, line-based matching previews, and clipped tentacle partitions.
- Cache derived geometry by compiled dataset and position, reuse in-flight work across answer changes, and bound position-cache retention. Run buffering and compiled map clipping in a module worker.
- Reuse standalone question regions for the combined map instead of evaluating every question twice. Invalidate obsolete map and hiding-zone refreshes, discard stale results, and react directly to planning-mode changes.
- Deduplicate game-definition loads by game/revision/session, prevent sidebar activation feedback, and keep failed game switches from using previous-game data. Guard session reconciliation against obsolete responses.
- Handle empty remaining areas, disabled previews/zone filters, and degenerate Voronoi inputs; preserve the previous complete map when a geometry calculation fails.

## Upstream integration (2026-09-11)

- Add Rotterdam 12-09 as a self-contained preloaded JSON definition on JetLag BNL, with nine NS stations for matching/measuring and a dedicated municipal boundary network for nearest-boundary measuring. Keep Exter Rotterdam unchanged; no legacy game wiring or assets are restored.
- Preserve the shipped 155 hiding spots at 300 m. Upstream September commit descriptions still say 206, but an earlier map revision replaced those spots. Decode source display names correctly in the new definition.
- Restore the active session after tab storage loss using a durable, tab-preferred pointer. Guard storage getters and methods, and preserve explicit leave behavior across reloads.
- Log server-side authentication failure reasons and browser request metadata without cookie values or referrers. Do not adopt upstream's global fetch wrapper or page-load correlation patch.

## Searchlight naming (2026-09-11)

- Standardize workspace packages on `@searchlight/*` and the test-only browser hook on `window.__searchlight`.
- Use Searchlight in log prefixes, the Overpass User-Agent, and product/setup documentation.
- Preserve existing `taibled-*` browser storage keys, PostgreSQL database/role defaults, deployment paths, and Compose project/volume names. Existing sessions, offline edits, and deployments do not require a naming migration.
- Keep existing local environment values and deployed directory names; a new local clone may be named `Searchlight`.

## JSON game runtime cleanup (2026-09-07)

- Remove definition type aliases, the `gameId` JSON input alias, game sentinels, redundant caches, and retired platform dataset declarations.
- Create and update games only through JSON import; require pinned definitions for new sessions and forks. Unconverted sessions do not fall back to the current definition.
- Remove fuzzy bundled-game POI aliases, the old base64 hiding-zone URL reader, the historical browser-storage migration, and obsolete Brno boundary seeding.
- Legacy sessions are not migrated: the database is reset when this ships, so sessions created before game revisions existed are dropped rather than converted.
- Update the game creation skill and published schemas; reject unknown root and feature-layer properties.

## Game definition review fixes (2026-09-07)

- Protect current and historical definitions with authentication, game visibility, and shared-session access checks; reject cross-server game updates.
- Serve definitions from the database only. Pin session loading and fork snapshots to their selected revision.
- Preserve station radii, units, and tiers; clear stale stations when changing games.
- Accept embedded GeoJSON only, reject MultiPoint and malformed geometry, and validate generated question identifiers.
- Honor disabled radars, keep invalid upload previews usable, and publish valid draft-07 schemas.
- Add snapshot revision columns without backfilling legacy data. Existing broken sessions and snapshots are not repaired.

## Phase 2 — Server registration + role mapping + permissions (2026-05-21)

Adds the permission layer: four JetLag Discord servers seeded into the DB,
membership caching with 5-minute TTL, role-to-permission mapping via the
admin UI, and a `requirePermission` middleware ready for Phase 3 to gate
game and session routes. Nothing new is gated yet — the machinery exists
and is verified, but all routes remain open until Phase 3.

### What landed

**`packages/shared`**
- New interfaces: `Server`, `ServerWithPermissions`, `ServersResponse`,
  `DiscordRole`, `RolePermissionEntry`, `ServerRolesResponse`.

**`apps/api`** — Prisma schema additions
- `Server` — Discord guild metadata. Four JetLag servers seeded via
  `prisma/seed.ts` (UK, EU, BNL, DE).
- `ServerMembershipCache` — `(userId, serverId)` composite PK; stores
  cached Discord role IDs with `cachedAt` timestamp, TTL 5 minutes.
- `RolePermission` — `(serverId, discordRoleId, permission)` unique triple;
  maps Discord roles to internal permission strings.

**`apps/api`** — new library modules
- `src/lib/session.ts` — extracts cookie-to-user session resolution used
  by `GET /me` and all new routes. Replaces inline duplication.
- `src/lib/permissions.ts` — `getUserPermissions(userId, serverId, accessToken,
  forceRefresh?)`: checks `ServerMembershipCache`, falls back to
  `GET /users/@me/guilds/{id}/member` on cache miss/expiry, returns a `Set<string>`
  of permission strings. `forceRefresh=true` bypasses the cache (used by writes).
- `src/lib/require-permission.ts` — `requirePermission(permission, getServerId,
  forceRefresh?)`: Fastify `preHandler` factory; resolves session, checks guild
  membership and role permissions, throws 403 on failure.

**`apps/api`** — Discord client extensions
- `discord.getGuildMember(guildId, accessToken)` — `GET /users/@me/guilds/{id}/member`
  (user OAuth token, `guilds.members.read` scope); returns `null` on 404 (not a member).
- `discord.getGuild(guildId, botToken)` — `GET /guilds/{id}` (bot token); returns
  guild metadata including the full `roles[]` array with names and colours.

**`apps/api`** — new routes (`GET/POST/DELETE /servers`)
- `GET /servers` — lists all seeded servers with the authed user's permission
  set for each (uses 5-min cache; first call per server hits Discord).
- `GET /servers/:serverId/roles` — lists Discord roles (with names when
  `DISCORD_BOT_TOKEN` is set) and current `RolePermission` mappings for that
  server. Requires `server.admin`.
- `POST /servers/:serverId/roles` — adds a `{ discordRoleId, permission }` mapping.
  Requires `server.admin`; force-refreshes membership cache.
- `DELETE /servers/:serverId/roles/:discordRoleId/permissions/:permission` — removes
  a mapping. Requires `server.admin`; force-refreshes membership cache.

**`apps/web`** — admin UI
- `src/components/AdminPanel.tsx` — React component: fetches server list, shows
  each server's roles as a table with permission checkboxes. Only servers where
  the user holds `server.admin` show the management panel; others say "No admin
  access". Role colour swatches from Discord role data.
- `src/pages/admin.astro` — new page at `/admin`, auth-gated by the same
  `AuthGuard` overlay pattern as `/map`.

**`.env.example`** — `DISCORD_BOT_TOKEN` documented (optional; enables role
name display in the admin UI; role IDs shown as fallback when absent).

### Bootstrap steps (run once on the server)

```bash
# 1. Create the migration (requires DB running)
pnpm --filter api exec prisma migrate dev --name phase-2-servers-roles-permissions

# 2. Seed servers + initial role permissions
#    Seeds: four JetLag servers + JetLag UK role 1383202208799129731 → server.admin
pnpm --filter api exec prisma db seed
```

After that, use `/admin` to manage all further mappings via the UI.

## Phase 1 — Backend skeleton + Discord OAuth + user model (2026-05-21)

Adds the Node backend, Discord login, server-side sessions, and an auth-gated
map view. The frontend entry point is now a landing page; the map lives at `/map`
and requires a valid session to render.

### What landed

**`packages/shared`**
- Exports `User` and `MeResponse` TypeScript interfaces, consumed by both
  `apps/api` (route typing) and `apps/web` (fetch response typing).

**`apps/api`** — new Fastify 5 backend
- Fastify with TypeBox type provider, Pino structured JSON logging.
- `@fastify/cors` locked to `FRONTEND_ORIGIN`, `credentials: true`.
- `@fastify/cookie` with signed cookies (`SESSION_COOKIE_SECRET`).
- `GET /health` → `{ ok: true }`.
- Prisma 6 schema: `User` (keyed by Discord ID) and `AuthSession`
  (256-bit random token, 30-day fixed expiry, indexed on `userId` + `expiresAt`).
- Discord OAuth via `arctic` v3: `identify`, `guilds`, `guilds.members.read` scopes
  (all three requested now to avoid re-prompting users in Phase 2).
- `GET /auth/discord/login` — generates state, sets state cookie, redirects to Discord.
- `GET /auth/discord/callback` — validates state, exchanges code, upserts User,
  creates AuthSession, sets signed session cookie, redirects to frontend `/map`.
- `POST /auth/logout` — strict `X-CSRF: 1` header check (any other value → 403);
  deletes session row, clears cookie, returns 204.
- `GET /me` — returns `MeResponse` for authed users, 401 otherwise.
- Rate-limited Discord client (`src/lib/discord-client.ts`): global 50 req/sec
  token bucket + per-route sub-buckets; 429 handling with max 3 retries; WARN
  log on rate-limit hits. Single export for Phase 1: `discord.getCurrentUser`.
  All Discord calls must go through this module.

**`apps/web`** — frontend changes
- Landing page at `/`: "Log in with Discord" button → `${PUBLIC_API_BASE}/auth/discord/login`.
- Map page at `/map`: identical to the previous `/` map, plus:
  - Static auth overlay (visible immediately, no JS required) prevents flash of unauthed content.
  - `AuthGuard` (React, client-only): fetches `/me` on mount; 401 → redirect to `/`;
    200 → removes overlay, runs localStorage wipe, renders user chip.
  - `UserChip`: top-right corner; shows avatar + display name + logout button.
    Logout POSTs to `/auth/logout` with `X-CSRF: 1` then redirects to `/`.
  - localStorage wipe: on first authed load, deletes all `jetlag-*`, `annot-*`,
    and `current-game-id` keys. Guarded by `taibled-wiped: '1'` sentinel. No UI mention.
- `PUBLIC_API_BASE` env var baked in at build time.

**Infrastructure**
- `docker-compose.yml`: `postgres:16` (named volume, healthcheck), `api`
  (runs `prisma migrate deploy` on boot), `web` (`nginx:alpine`, no Node runtime).
  All services on internal network; host ports bound to `127.0.0.1` only.
  `postgres` exposes no host port.
- `apps/api/Dockerfile`: multi-stage (Node 20-slim builder → Node 20-alpine runner).
- `apps/web/Dockerfile`: multi-stage (Node 20-slim builder → nginx:alpine runner).
  `PUBLIC_API_BASE` passed as build ARG.
- `apps/web/nginx.conf`: SPA fallback, `no-cache` for HTML/SW/manifest,
  `immutable` for `/_astro/*` hashed assets.
- `infra/backup.sh`: nightly `pg_dump` via `docker compose exec`, gzip,
  30-day retention, encryption-at-rest TODO.
- `.env.example`: documents all 9 env vars.
- `DEPLOY.md`: M1 setup, Discord redirect URI registration, NPM proxy config,
  cron line for backups.

### Validation library ADR

TypeBox (`@fastify/type-provider-typebox`) chosen for backend route schemas.
See `apps/api/README.md` for the full two-line ADR.

---

## Phase 0 — pnpm workspace restructure (2026-05-21)

Converts the repo from a flat Astro project to a pnpm workspace layout
in preparation for the Node backend added in Phase 1.

### Changes

- **`apps/web/`** — Astro frontend relocated here from the repo root via
  `git mv`; full git history preserved on all files. Package renamed to
  `@taibled/web`. `tsconfig.json` now extends root `tsconfig.base.json`
  in addition to `astro/tsconfigs/strict`.
- **`apps/api/`** — placeholder `@taibled/api` package. Contains a stub
  `src/index.ts` and a NodeNext TypeScript config. Fastify, Prisma, and
  auth wired in Phase 1.
- **`packages/shared/`** — placeholder `@taibled/shared` package with an
  empty `src/index.ts` and a declaration-emitting TypeScript config.
  Populated in Phase 1+.
- **Root `package.json`** — `private: true`, `packageManager: pnpm@11.1.3`,
  `pnpm dev` / `pnpm build` convenience scripts.
- **`pnpm-workspace.yaml`** — declares `apps/*` and `packages/*`; includes
  `allowBuilds` for `esbuild`, `sharp`, and
  `@vaadin/vaadin-usage-statistics` so `pnpm install` is non-interactive.
- **`tsconfig.base.json`** — shared strict TypeScript settings extended by
  all packages.
- **`README.md`** — replaced with workspace orientation doc.
- **`.gitignore`** — extended to cover `apps/*/dist` and `packages/*/dist`.

### Acceptance criteria verified

1. `pnpm install` at root — clean (1173 packages, no substantive peer-dep errors).
2. `pnpm --filter web build` — `1 page(s) built`, no errors.
3. `pnpm --filter api build` — emits `apps/api/dist/index.js`.
4. `pnpm --filter shared build` — emits `packages/shared/dist/index.js` + `.d.ts`.
5. `git log --follow` on moved files shows full pre-restructure history.
6. Browser verification (criterion 2 from spec) — pending manual test by operator.
