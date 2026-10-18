# Changelog

## Docs for a public repo (2026-10-18)

- `DEPLOY.md` clones the repo over HTTPS (a read-only deploy key still works for SSH) and needs `docker login ghcr.io` only while the GHCR packages are private.
- `SECURITY.md` asks for vulnerabilities to be reported privately on the repo's Security tab, not in public issues.

## Game stats for server admins (2026-10-17)

- The games page shows how much each game is played to anyone with `server.admin` on its server: sessions live now and their connected players, sessions active in the last 24 hours and 7 days (created or with an event in that window), sessions, players and questions in total, and when it was last played. The numbers come from `GET /games/stats?serverId=`, which returns counts only.
- "Live now" counts open live-sync connections to this API process, so it starts at 0 after the API restarts.
- The games page also lists servers where someone holds only `server.admin`.

## The server picker lists only your servers (2026-10-17)

- The session picker lists the Discord servers you're in, plus Home Games; servers you aren't in used to show up with an empty game list. A server you aren't in still shows up while you have sessions there (e.g. from a game or join link), without "+ New session".
- Such sessions open without reading the server's game catalog, and are labelled with their game's name.
- `GET /servers` marks those servers `isMember: false`. Admins (`ADMIN_DISCORD_IDS`) still see every server. Servers you weren't in are re-checked every 10 minutes, so a server you just joined shows up within 10 minutes.

## Tests run on pull requests (2026-10-17)

- A "Tests" workflow runs on every pull request and push to `main`: it builds the workspace and runs the shared, web and API unit tests (the API's against a Postgres service), `pnpm verify:preloaded-games` and `pnpm check:game-schema`. The Playwright e2e tests still run by hand.

## Sessions are shared by link only (2026-10-17)

- Inviting a specific user is gone; a session's creator shares it with links. **Invites** makes, copies and revokes join links, and **Share a copy** does the same for links that give each person their own private copy. The user search, the pending lists and the incoming-invites badge are removed.
- The new-session form no longer asks for Private or Shared: a session becomes shared when its creator makes a join link. `POST /sessions` defaults `visibility` to `private`.
- The API drops `GET /users/search`, which let any logged-in user list every user, the invite routes (`/sessions/pending-invites`, `/sessions/invites/:id/accept` and `/decline`, `/sessions/:id/invites`) and `GET /sessions/:id/participants` (`GET /sessions/:id` still lists participants).
- `PATCH /sessions/:id` returns the session's revision fields too, so an update can no longer load the wrong game revision or hide the revision banner.
- The join page says why a link couldn't be redeemed, a creator opening their own join link is taken to the session, and kicking someone who isn't in the session answers 404 instead of 500.
- The `20261017020000_drop_invites` migration drops the `Invite` and `InviteSnapshot` tables, pending invites included. Players who accepted an invite stay in the session.

## Security hardening (2026-10-17)

- Hiding-zone and station names from a game definition are shown as text. Leaflet rendered them as HTML, so an imported game could run script in every player's browser.
- `POST /games/import` refuses a user who can't import on any server with a 403 before reading the body, which can be up to 50 MB.
- Server errors (5xx) answer "Internal Server Error" instead of the error's message, which could carry database details; the full error is logged. Client errors (4xx) keep their messages. Out-of-range integers (a question `ordinal`, an events `after`, a revision number) get a 400 or 404 instead of a database error.
- The API refuses to start with `ENABLE_TEST_AUTH=1` when `NODE_ENV` is `production`.
- The web server, and `public/_headers` on Cloudflare, send `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY`.

## Curses that resize the hiding zones (2026-10-17)

- Add Question → **Resize Hiding Zones (Curse)** adds a card with a multiplier (×1.5 and ×0.5 are one tap; any positive number can be typed) that shows the zone radius from then on.
- The question list runs in the order things happened: questions below a curse are checked against the resized zones, questions above it against the size they were asked at. A curse added late can be moved to where it was cast with **Earlier** and **Later**.
- Curses multiply, a hidden curse counts as ×1, and the map and the zone sidebar show the current size. Polygon zones keep their own area.
- A curse is stored in the question list as `{"id": "zone-size", "data": {"multiplier": 1.5}}`. Clients from before this release hide it, and drop it if they then save the list.

## Pens erase with their eraser button (2026-10-17)

- In Pen Mode, a pen's eraser end or barrel button erases, whatever tool is chosen; letting go returns to that tool. Hold the button as the pen touches down, since Windows reports it only then. The barrel button's right-click no longer opens the map menu.
- In Pen Mode, the right and middle mouse buttons no longer draw.

## Dev login on preview deployments (2026-10-17)

- With `DEV_LOGIN_TOKEN` set (at least 32 characters), the API adds `/auth/dev-login`, which logs in as any Discord user ID without Discord, so testers and agents can act as specific users on PR previews. Without the token the routes don't exist; prod never sets it. See `docs/TESTING.md`.

## Measuring questions show your distance (2026-10-17)

- A measuring question's card shows the seeker's distance to what it measures to, naming the nearest one when the game names them ("Your distance: 1.243 km to Brussels Airport"). In hider mode it also shows the hider's, so the automatic Closer/Further answer can be checked.

## Slow question results say they are calculating (2026-10-17)

- When the questions' results take longer than half a second, a "Calculating…" pill shows under the Live indicator until the eliminated area and the remaining hiding zones are done.

## Question names (2026-10-17)

- Every question card has a Name field, so a question can be called "Airport radar" instead of "Radius 2". The name shows on the card, also when collapsed, and on its map marker's hover, and syncs with the session. It travels in the question's JSON as `data.name` (at most 60 characters).

## Region-boundary questions cover the whole play area (2026-10-17)

- Where a game's regions don't cover its play area (Belgium's provinces along the French border, at sea and between provinces), distance-to-region-boundary questions treated those strips as infinitely far from any boundary, so they always survived "Hider Further" and were always eliminated by "Hider Closer". Such points are now measured to the nearest region's boundary, for the seeker, the hider's answer and the map alike.
- The eliminated area no longer leaves hairline slivers along the seams between regions, and is worked out in the geometry worker.

## Free play is removed (2026-10-17)

- Every session plays a JSON-defined game; free play, inherited from JetLagHideAndSeek, is gone. Questions and hiding zones never query OpenStreetMap/Overpass (the coordinate fields' place search still uses Photon).
- When a session's game can't be loaded (offline, a server error, no access), a "Game not loaded" banner offers Retry and Change session. The board and drawing tools keep working, but Add Question, the map's Add items and hider mode wait for the game, and no question is evaluated meanwhile.
- Removed with it: the place picker (and "Clear Questions & Cache"), drawing a play area with the polygon tool (it still draws custom questions), "Exclude Country", Copy/Paste Hiding Zone and `?hzc=`/`?pb=` links, the tutorial, the hidden Share button and the Pastebin settings.
- Hiding zones come only from the game. The zone sidebar no longer looks up stations in OpenStreetMap, imports station lists or merges duplicate stations, and shows the game's hiding-zone radius instead of an editable one. A game's Polygon and MultiPolygon hiding zones are drawn and eliminated as areas.
- The old built-in question types are gone (airports, major cities, McDonald's and 7-Eleven, train stations and lines, OSM zones, high-speed rail, international borders, the built-in tentacles, and the variants and hiding-zone filters they drove). Stored questions of these types are hidden, and dropped the next time the session's questions are saved.
- Switching a matching or measuring question to a custom type starts blank; only Custom Points to Custom Zone can still copy the seeker's cell. Custom questions with nothing drawn yet eliminate nothing instead of breaking the map, and clearing a radar or tentacle radius keeps the last value.
- The map frames each game when it loads and, after a reload, shows the game it last framed (or the world) until then. Changing the Default Unit no longer changes the hiding-zone radius unit, and hider mode starts at the game's centre. A failed session switch no longer leaves the previous session's game on the board, and the session picker can be closed (Back to board, or Escape) while a board is showing. Browser caches and settings of the removed features are cleared.
- The API drops `POST /overpass` and `/boundaries`, and the `20261017010000_drop_boundary_cache` migration drops the `BoundaryCache` table. `OVERPASS_URL`, `OVERPASS_CF_ACCESS_CLIENT_ID` and `OVERPASS_CF_ACCESS_CLIENT_SECRET` are no longer read; remove them from a server's `.env`. The e2e stack has no Overpass stub.

## Hider mode turns off again (2026-10-17)

- Turning hider mode off saved the hider's position as 0, 0, so hider mode came straight back on there, also after a reload. `PATCH /sessions/:id` now stores a `null` position as null, and the `20261017003000_clear_zero_hider_positions` migration clears the 0, 0 positions already saved.

## Unlisted games and game links (2026-10-17)

- A game can be unlisted: it isn't offered when creating a session, and its sessions start only from a game link, for everyone. Its server's game managers (`games.create`, `games.edit`, `games.delete` or `server.admin`) still see it on `/games` and alone may read its definitions. A game can be imported unlisted (the import dialog's **Unlisted** box, or `POST /games/import?unlisted=true`) and switched on `/games` with **Make unlisted**/**Make listed**; re-importing keeps the setting.
- A game link (`/play?token=…`) starts sessions of one game, listed or unlisted, without server membership or the game's role gate. Links don't expire; they end only when revoked. Game managers make, copy and revoke them on `/games` → **Links**. Sessions started from a link keep working after it is revoked, and can be upgraded to newer revisions while it is active.
- The session picker has a cog that opens `/games` for users with `games.create`, `games.edit` or `games.delete` on any server.
- The `20261017000000_unlisted_games_and_game_links` migration adds `Game.unlisted`, the `GameLink` table and `GameSession.gameLinkId`.

## Kilometres by default (2026-10-16)

- Users who haven't picked a Default Unit get kilometres instead of miles, and new thermometers start 5 km apart. A saved unit is kept.

## Production URLs (2026-10-16)

- The game definition schema's `$id`, every preloaded game's `$schema`, `docs/ADDING_GAMES.md` and the game creation skill point at `searchlight.jetlageuropa.org` instead of the retired `sl-dev.jl-e.org`.

## Bug reports and feature requests on GitHub Issues (2026-10-16)

- In-app feedback is removed: the `/feedback` and `/admin/feedback` pages, the API's `/feedback` routes and the Discord feedback webhook (`DISCORD_FEEDBACK_WEBHOOK_URL`). The map menu's "Report a bug / suggest a feature" opens [GitHub Issues](https://github.com/Jetlag-Europa/Searchlight/issues/new/choose) instead.
- The `20261016000000_drop_feedback` migration drops the `Feedback`, `FeedbackVote` and `FeedbackImage` tables and everything in them.

## Docker images from main only (2026-10-16)

- The "Docker images" workflow runs only on pushes to `main` and manual runs on `main`. Pull requests and other branches no longer build images.

## Game creation for game devs (2026-10-16)

- The game creation skill (`/skills/create-game.md`) starts from the usual source: a Discord announcement linking a rules Google Doc and a Google My Map. It explains how to download both, map the rules' feature table to question layers, and handle common My Maps problems (mixed POI layers, placeholder names, regions drawn as several shapes, drawn zone circles). The game is copied as drawn, with nothing added or derived.
- `game-tools.mjs` gains `myMapsKmlUrl()`, `googleDocTextUrl()`, `decodeText()`, `mergeByName()`, `groupBy()` and `circleRadius()`; `normalize()` decodes CDATA and entities and takes a `name` option.
- The guide and `docs/ADDING_GAMES.md` explain who can upload: a Discord role with `games.create`/`games.edit`, granted on `/admin` → **Manage Roles**; Home Games uploads are admin-only. The import dialog links to the guide.

## Simpler setup and deployment (2026-10-16)

- Development is `cp .env.example .env`, four Discord/session values, `pnpm install`, `pnpm dev`. `pnpm dev` starts Postgres (`docker-compose.dev.yml`), builds and watches the shared package, and runs the API and the web app. Everything reads the root `.env`; `apps/web/.env` is gone.
- `docker-compose.yml` is the whole stack, pulling the CI images or building them. Overlays add the way in: `docker-compose.cloudflared.yml` (production, was `docker-compose.vps.yml`) or `docker-compose.backend.yml` (API on a host port). A server picks one with `COMPOSE_FILE` in `.env` and names its stack with `COMPOSE_PROJECT_NAME`, which is required. The API's `DATABASE_URL` is built from `POSTGRES_PASSWORD`.
- `infra/deploy-vps.sh` is removed: a deploy is `git pull`, `docker compose pull`, `docker compose up -d` (or `up -d --build`). `infra/backup.sh` follows `.env` too. The e2e stack is `searchlight-test` and needs no `.env.test`.
- `README.md` (replacing `SETUP.md`), `DEPLOY.md` and `docs/TESTING.md` (replacing `TESTING_PLAN.md`) are rewritten for the current setup.

## Question layers for Brno, Brussels and OLD Luxembourg (2026-10-15)

- Brno 2026, Brussels 2026 and OLD Luxembourg 2026 were converted with no question layers, so they offered no matching, measuring or tentacle questions. They now carry their own:
  - Brno 2026: its pre-conversion POI file (`brno-poi-v2.kml`): Museum, Airport, Park, Hospital, Library, Theme Park, Zoo, Golf Course, Cinema, Body of Water (measuring only) and its 29 districts (matching only).
  - Brussels 2026: Belgium 01.08's Airport, Museum, Cinema, Golf Course, Theme Park, Zoo, Consulate, Library, Hospital and High-Speed Rail layers, keeping each site that is the nearest of its kind somewhere in the play area or within 25 km of it.
  - OLD Luxembourg 2026: Luxembourg 2-3 October's layers for the same play area, without its stop-distance and Castle or Fort questions.
- Point layers where only one site is ever the nearest are measuring only (Brno's and Brussels' airports).

## Deployment: CI-built images and cleanup (2026-10-15)

- A "Docker images" GitHub Actions workflow builds the `api` and `web` images for `linux/amd64` and `linux/arm64` (natively, one runner per platform) on every push to `main` and pushes them to GHCR as `ghcr.io/jetlag-europa/searchlight-{api,web}`, tagged `sha-<commit>` and `latest`. Servers pull them instead of building (`--build` still builds from source).
- `DEPLOY.md` is the one deployment guide; `docs/VPS_Setup.md` is folded into it and `docs/VPS_MIGRATION.md` is removed.
- Removed the outdated Mac mini production and dev stacks, their scripts and hostnames, and the GitHub Pages workflow (it only ran on `master`, which this repo doesn't have). API tests default to the local Postgres on port 5433.

## Master integration and review fixes (2026-10-13)

Games and data
- Rebase onto master and bring its later games into the JSON format: Greater Manchester 19-09, North London 26-09 (with its 55 council-listed parks) and Stockholm 19-09. Master's legacy assets, per-game modules and generator scripts are removed. Not carried over: Greater Manchester's library questions (answered live by Overpass, no bundled data) and North London's station-name length (no JSON equivalent).
- Fix Brno 2026, Brussels 2026 and OLD Luxembourg 2026, whose converted play areas were `[lat, lng]` boxes that put every hiding zone outside the map.
- Normalize every preloaded definition to the authoring guide: decoded names, unique feature IDs, singular Title Case layer names, single-site layers measuring only, one feature per named line, 6-decimal positions, and lighter Belgium/Milan region layers. Each zone's answers are unchanged.
- Duplicate layer names are a validation error, and compiled datasets are keyed by layer position, so layers whose names slug alike can't read each other's data.

Server
- The database is reset with this release: legacy sessions are not migrated, and every session must be pinned to a game revision.
- Access: creating or upgrading a session needs the game's server membership and role gate; a session only exposes its pinned revision. Server membership is recorded explicitly instead of inferred from any cached role lookup.
- Imports: authenticate before reading the body, serialize concurrent imports, never rewrite a stored revision (re-importing older content re-activates its revision), constrain game IDs to slugs, and keep preloading the other files when one fails. Container start only creates missing servers, so revoked role mappings stay revoked. Imports to an unregistered server report `SERVER_NOT_FOUND`.
- `apps/api/scripts/auth-walls.sh` groups 401s by client and time window.

Sync
- Loading or switching sessions can no longer save one session's questions into another, and restoring a session keeps edits that haven't reached the server.
- Failed sends retry with backoff while online; remote question changes that land just after our own are applied; flushes run on page hide and tab switch.
- Closed event streams reconnect from the last applied event; sessions the server reports gone (403/404) are forgotten along with their cached data, while transient errors keep them. Storage access is guarded everywhere for privacy modes.
- The echo of our own question save no longer undoes newer local edits, and a loading session stays read-only until it is reconciled with the server.

Geometry
- Nearest-line matching builds its partition once per layer in the worker (milliseconds per marker move after the first, instead of seconds to minutes).
- Tentacles use the geodesic radius circle, so a hider just inside the radius isn't eliminated; hider-mode measuring uses the same geodetic distances as the map.
- Measuring buffers only the features that can reach the map, with a tolerance scaled to the distance, and skips stale worker jobs.
- A refresh that reused geometry a newer marker position superseded starts over instead of reporting "No solutions found".

Interface and tools
- Radars start at the game's declared radii, and matching/measuring/tentacles add a custom question when the game has no layer for them. Export Game JSON exports the revision being played. The import preview honours the root `unit`, shows radars as off when omitted, shows the thermometer, and lists only servers the user can import to.
- `check-game.mjs` flags undecoded names, repeated feature IDs, region layers no zone lies in, out-of-range bounds, numeric tiers and plural layer names, and gains `--strict`. `pnpm verify:preloaded-games` fails on file name/ID mismatches and on the strict checks.
- The web app passes its ESLint rules.

## Games declare all their questions (2026-10-12)

- A game offers only what its definition declares. Radar and thermometer are now opt-in (`radars: true | [radii]`, `thermometer: true`); every preloaded game already sets both.
- No OpenStreetMap/Overpass fallback inside a game: only the game's compiled questions and player-drawn custom questions remain. Tentacle locations come only from the game's layers.
- The game creation skill (`/skills/create-game.md`) is rewritten against the actual runtime, with `game-tools.mjs` (KML/GeoJSON/CSV/OSM conversion and normalization) and `check-game.mjs` (validation, play-quality warnings and the generated question list).

## Luxembourg 2–3 October and load toast (2026-10-01)

- Add the Luxembourg 2–3 October 2026 game, with its canton, former-district and international-border geometry simplified (~11 m tolerance) so measuring stays responsive, and without matching on its single-site layers, which always answered "same".
- No more spurious "At least one place type must be selected" toast on session load.

## Gameplay save fixes (2026-09-25)

- Gameplay saves are debounced, each queued snapshot is persisted before it is sent, and live saves are serialized with reconnect replay, so failed writes can't roll back newer answers or settings.
- Hider and planning state are restored from a fresh session snapshot after replay.
- The revision notice is compact and out of the map controls, asks for confirmation, and upgrades under the session lock.

## JSON game session and geometry correctness (2026-09-23)

- Matching and tentacle answers stay tied to physical POI locations even when imported features reuse IDs; clustered-point Voronoi partitions and competing-line previews are repaired.
- Region-boundary answers are measured against each candidate's own region with the same geodetic metric for the answer and the buffer. Hiding-zone intersection filtering runs off the main thread.
- Unsent edits survive session changes, paginated events replay in commit order, revoked SSE streams close, and content is persisted with its event before a write is acknowledged.
- Offline queues and snapshots stay tied to their account, duplicate and failed PATCH saves can be retried, and a create/delete race can't resurrect annotations. Stale map layers, imports and card edits can't overwrite newer state.

## JSON game planning and performance fixes (2026-09-22)

- Planning and evaluation share compiled question geometry, restoring matching/measuring outlines, line-based matching previews and clipped tentacle partitions.
- Derived geometry is cached by dataset and position and reused across answer changes; buffering and map clipping run in a module worker. The combined map reuses each question's region instead of evaluating every question twice.
- Obsolete map and hiding-zone refreshes are discarded, game-definition loads are deduplicated, and a failed game switch doesn't use the previous game's data.
- Empty remaining areas, disabled previews and degenerate Voronoi inputs are handled; a failed geometry calculation keeps the previous map.

## Upstream integration (2026-09-11)

- Add Rotterdam 12-09 as a preloaded JSON game on JetLag BNL, with nine NS stations for matching/measuring and a municipal boundary network for nearest-boundary measuring, keeping its shipped 155 hiding spots at 300 m.
- The active session is restored after tab storage loss, and an explicit leave survives reloads.
- Server-side authentication failures are logged with their reason and request metadata, without cookie values or referrers.

## Searchlight naming (2026-09-11)

- Workspace packages are `@searchlight/*`, and the test-only browser hook is `window.__searchlight`. Logs, the Overpass User-Agent and the docs say Searchlight.
- Existing `taibled-*` browser storage keys, database names, deployment paths and Compose project and volume names are unchanged, so nothing needs migrating.

## JSON game runtime cleanup (2026-09-07)

- Games are created and updated only through JSON import, and new sessions and forks need a pinned definition. Legacy sessions are not converted; the database is reset when this ships.
- Removed definition type aliases, the `gameId` JSON input alias, game sentinels, redundant caches, fuzzy bundled-game POI aliases, the old base64 hiding-zone URL reader, the historical browser-storage migration and obsolete Brno boundary seeding.
- The game creation skill and published schemas are updated; unknown root and feature-layer properties are rejected.

## Game definition review fixes (2026-09-07)

- Current and historical definitions are protected by authentication, game visibility and shared-session access checks; cross-server game updates are rejected.
- Definitions are served from the database only, and session loading and fork snapshots are pinned to their revision.
- Station radii, units and tiers are preserved, and stale stations are cleared when changing games.
- Only embedded GeoJSON is accepted; MultiPoint and malformed geometry are rejected, and generated question identifiers are validated. Disabled radars are honoured, and the published schemas are valid draft-07.

## Phase 2: servers, roles and permissions (2026-05-21)

- Discord servers are stored in the database, with cached memberships and role-to-permission mappings that users with `server.admin` manage on `/admin`.
- `GET /servers` lists the servers with the user's permissions on each; `/servers/:serverId/roles` lists and edits a server's mappings. `DISCORD_BOT_TOKEN` lets the admin UI show role names.

## Phase 1: backend and Discord login (2026-05-21)

- A Fastify 5 API with Prisma and Postgres: Discord OAuth login, server-side sessions in a signed cookie, `POST /auth/logout` (requires `X-CSRF: 1`), `GET /me` and `GET /health`. Discord calls go through one rate-limited client.
- The landing page logs in with Discord; the map moved to `/map` and needs a login.
- Docker Compose runs Postgres, the API (migrating on boot) and the web app on nginx; `infra/backup.sh` makes nightly `pg_dump`s.

## Phase 0: pnpm workspace (2026-05-21)

- The repo is a pnpm workspace: the Astro frontend moved to `apps/web` with its history, next to the new `apps/api` and `packages/shared`.
