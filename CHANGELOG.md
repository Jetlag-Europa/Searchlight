# Changelog

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
