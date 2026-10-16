# Dev environment setup

A start-to-finish guide for getting Searchlight running locally on a fresh
machine. It takes you from `git clone` to logging into the app in your browser.
Postgres runs in Docker; the frontend and backend run directly on your machine
for fast hot-reload.

> This guide is for **local development**. Production deployment is documented
> in [`DEPLOY.md`](DEPLOY.md). You don't need any of that for local work.

---

## 1. What this is

Searchlight is a JetLag Hide & Seek map planner. It's a pnpm monorepo:

| Path              | What it is                                   |
| ----------------- | -------------------------------------------- |
| `apps/web`        | Astro + React frontend (the map app)         |
| `apps/api`        | Fastify + Prisma backend (auth, games, data) |
| `packages/shared` | Shared types and the game definition schema, validator and checksum |
| `games/preloaded` | The bundled games, one JSON definition each (imported by the API on start) |

Data lives in PostgreSQL. Login is via Discord OAuth.

**How you'll run it locally:** Postgres in Docker (port 5433), and the web
(`localhost:4321`) and API (`localhost:3000`) servers on your host via pnpm.

---

## 2. Prerequisites

Install these first:

- **Docker Desktop** (running) — used for Postgres.
- **Node.js** — any version **below 25** (the repo sets `"engines": { "node": "<25" }`).
  Node 20 or 22 LTS is a safe choice.
- **pnpm 11.1.3** — enable via corepack (ships with Node):
  ```bash
  corepack enable
  corepack prepare pnpm@11.1.3 --activate
  ```
  (Or `npm install -g pnpm@11.1.3`.)
- **git**, and `openssl` (preinstalled on macOS/Linux) for generating a secret.

---

## 3. Clone & install

```bash
git clone <repo-url> Searchlight
cd Searchlight
pnpm install
```

`pnpm install` also generates the Prisma client automatically (via the api's
`postinstall`).

---

## 4. Configure `.env`

For a fresh checkout, copy the template to the repo-root `.env`:

```bash
cp .env.example .env
```

For an existing checkout, keep your configured `.env` values. Searchlight
branding does not migrate stored data or deployment identifiers; see the
[naming compatibility note](DEPLOY.md#naming-compatibility).

Then edit `.env`. Here's what to set for local dev:

| Variable                | Value for local dev                                              |
| ----------------------- | ---------------------------------------------------------------- |
| `POSTGRES_USER`         | Leave as `taibled`.                                              |
| `POSTGRES_PASSWORD`     | Set to anything, e.g. `dev_password`.                            |
| `DATABASE_URL`          | **Change the host/port to `localhost:5433`** — see below.        |
| `DISCORD_CLIENT_ID`     | Fill in — see step 5.                                            |
| `DISCORD_CLIENT_SECRET` | Fill in — see step 5.                                            |
| `DISCORD_REDIRECT_URI`  | Leave as `http://localhost:3000/auth/discord/callback`.         |
| `SESSION_COOKIE_SECRET` | Generate one: `openssl rand -hex 32`, paste the output.         |
| `SESSION_COOKIE_DOMAIN` | Leave blank.                                                     |
| `FRONTEND_ORIGIN`       | **Set to `http://localhost:4321`** (the Vite web port).         |
| `PUBLIC_API_BASE`       | Leave as `http://localhost:3000`.                               |
| `DISCORD_BOT_TOKEN`     | **Required** — the API refuses to start without it. See step 5.  |
| `ADMIN_DISCORD_IDS`     | Your own Discord user ID (comma-separate several) — see below.   |
| `NODE_ENV`              | Set to `development` (the template ships `production`).          |

Two changes from the template matter — get these right or things break:

- **`DATABASE_URL` → `localhost:5433`.** The template ships
  `postgresql://taibled:change_me@postgres:5432/taibled`. The host `postgres`
  only resolves *inside* Docker. Since your API and the migrate/seed commands run
  on your host, point at the port Docker exposes to your machine:
  ```
  DATABASE_URL=postgresql://taibled:dev_password@localhost:5433/taibled
  ```
  (Use whatever you set for `POSTGRES_PASSWORD`.)
- **`FRONTEND_ORIGIN` → `http://localhost:4321`.** The API's CORS allowlist is
  exactly this origin. The web dev server runs on `4321`, so if this stays at
  `8080` the browser's API calls get blocked by CORS.

Games belong to Discord servers, and the API only shows a server's games to its
members (checked with the bot, which must be in that server). Your local bot is
normally not in the JetLag servers, so set `ADMIN_DISCORD_IDS` to your own
Discord user ID (Discord → Settings → Advanced → Developer Mode, then right-click
your name → Copy User ID). Admins skip the membership and role checks, see every
game and may import games.

---

## 5. Discord OAuth credentials

You need a Discord application so login works. Two options:

### Option A — Make your own app (recommended)

1. Go to <https://discord.com/developers/applications> → **New Application**.
2. Open **OAuth2**. Copy the **Client ID** and **Client Secret** into
   `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` in your `.env`.
3. Under **OAuth2 → Redirects**, add exactly:
   ```
   http://localhost:3000/auth/discord/callback
   ```
   It must match `DISCORD_REDIRECT_URI` character-for-character.
4. Under **Bot**, create a bot and copy its token into `DISCORD_BOT_TOKEN`.
   The API needs it at start-up: server membership, roles and role names are all
   read with the bot, and only for servers the bot has joined.

### Option B — Use Jules's app

If you'd rather not create one, ask Jules for the `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET` and `DISCORD_BOT_TOKEN` and paste them in. Note: the
`http://localhost:3000/auth/discord/callback` redirect above must already be
registered on that app — confirm with Jules.

---

## 6. Start Postgres

From the repo root:

```bash
docker compose up -d postgres
```

This starts Postgres in Docker, exposed on `localhost:5433`. (The plain
`docker compose` command auto-loads `docker-compose.override.yml`, which is what
maps that port for local dev.)

Check it's healthy:

```bash
docker compose ps
```

---

## 7. First run: create tables and seed data

Run once (and again only if you wipe the DB). From `apps/api`:

```bash
cd apps/api
export DATABASE_URL="$(grep '^DATABASE_URL=' ../../.env | cut -d= -f2-)"
npx prisma migrate deploy
npx tsx prisma/seed.ts
cd ../..
```

Prisma and the seed don't read the repo-root `.env` themselves (only the API's
`dev` script does), hence the `export`; with `DATABASE_URL` pointing at
`localhost:5433` from step 4 they'll connect. The seed creates the JetLag servers
and their role mappings. Games are not seeded: the API imports every
`games/preloaded/*.game.json` each time it starts (see `docs/ADDING_GAMES.md`).

---

## 8. Run the app

Two terminals, both from the repo root:

```bash
# Terminal 1 — API (Fastify, hot-reload)
pnpm --filter api dev        # → http://localhost:3000

# Terminal 2 — Web (Astro/Vite, hot-reload)
pnpm --filter web dev        # → http://localhost:4321
```

The API dev script loads `.env` automatically. Open
<http://localhost:4321> and log in with Discord.

Quick health check for the API:

```bash
curl http://localhost:3000/health        # → {"ok":true}
```

Both servers hot-reload on file changes — no rebuild needed.

---

## 9. Running tests

```bash
pnpm --filter web exec vitest run       # web unit tests (`pnpm --filter web test` starts watch mode)
pnpm --filter @searchlight/shared test  # game definition schema, validator, checksum
pnpm verify:preloaded-games             # every games/preloaded definition: validator + strict data checks
pnpm check:game-schema                  # published JSON schema matches the TypeBox schema

# API tests need a migrated Postgres; they create and remove their own rows.
# Without DATABASE_URL they use postgresql://taibled:devpassword@localhost:5433/taibled.
DATABASE_URL=postgresql://taibled:dev_password@localhost:5433/taibled pnpm --filter api test
```

---

## 10. Stopping & resetting

- **Stop Postgres (keeps your data):**
  ```bash
  docker compose down
  ```
- **Wipe the database** (start fresh):
  ```bash
  docker compose down -v
  ```
  > **⚠️ `-v` deletes the Postgres volume and all data.** After a wipe, bring
  > Postgres back up (step 6) and re-run migrate + seed (step 7).

---

## 11. Troubleshooting

- **`Can't reach database at postgres:5432`.** Your `.env` `DATABASE_URL` still
  points at the Docker-internal host. Change it to
  `postgresql://taibled:<pw>@localhost:5433/taibled`.
- **`Environment variable not found: DATABASE_URL`** from `prisma` or the seed.
  Export it first, as in step 7.
- **API calls fail with a CORS error in the browser console.** `FRONTEND_ORIGIN`
  in `.env` must be `http://localhost:4321` (the web dev port). Restart the API
  after changing it.
- **Discord login fails with a redirect / `invalid_grant` error.** The redirect
  URI in your Discord app doesn't exactly match `DISCORD_REDIRECT_URI`
  (`http://localhost:3000/auth/discord/callback`). They must be identical.
- **Port already in use (5433 / 3000 / 4321).** Something else is using the port.
  Stop it, or check `docker compose ps` for a previously-started stack.
- **API exits with `Missing required env var: …`.** The API needs
  `DATABASE_URL`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`,
  `DISCORD_REDIRECT_URI`, `SESSION_COOKIE_SECRET`, `FRONTEND_ORIGIN` and
  `DISCORD_BOT_TOKEN`.
- **A server's games don't load (403 from `/games`).** Your bot can't confirm
  you're a member of that Discord server. Set `ADMIN_DISCORD_IDS` (step 4) and
  restart the API.
- **`pnpm` not found / wrong version.** Re-run
  `corepack prepare pnpm@11.1.3 --activate`.
