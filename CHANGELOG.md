# Changelog

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
