# Changelog

## Deployment: CI-built images and cleanup (2026-10-15)

- A "Docker images" GitHub Actions workflow builds the `api` and `web` images for arm64 on every push to `main` and pushes them to GHCR as `ghcr.io/jetlag-europa/searchlight-{api,web}`, tagged `sha-<commit>` and `latest`. Pull requests build them without pushing.
- `infra/deploy-vps.sh` pulls the images of the checked-out commit instead of building on the VPS (`--build` keeps the build-from-source path) and removes unused images older than a week. The VPS needs a one-time `docker login ghcr.io` and a clone that tracks `Jetlag-Europa/Searchlight` (see `DEPLOY.md`).
- `DEPLOY.md` is the one deployment guide: production on the VPS (formerly `docs/VPS_Setup.md`), the Mac mini dev stack, and Discord redirects. The completed migration plan `docs/VPS_MIGRATION.md` is removed.
- Removed what nothing used any more: the Mac mini production stack (`docker-compose.prod.yml`, `infra/deploy-prod.sh`; production moved to the VPS in June and its data was reset in October), the GitHub Pages workflow (it only ran on `master`, which this repo doesn't have), and the `TUNNEL_TOKEN` placeholder.
- `infra/backup.sh` writes to `backups/` next to the clone by default instead of a Mac mini home directory, so its cron line needs no overrides.

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
