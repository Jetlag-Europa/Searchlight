# Dev environment setup

A start-to-finish guide for getting TaibledFork running locally on a fresh
machine. It takes you from `git clone` to logging into the app in your browser.
Postgres runs in Docker; the frontend and backend run directly on your machine
for fast hot-reload.

> This guide is for **local development**. The repo also contains `startup.txt`
> and `DEPLOY.md` — those describe the maintainer's dev/prod **server** deploys
> (with `lucifersserver.com` URLs and `--project-name` flags) and the
> `docker-compose.dev.yml` / `docker-compose.prod.yml` files. You don't need any
> of that for local work; ignore them.

---

## 1. What this is

TaibledFork is a JetLag Hide & Seek map planner. It's a pnpm monorepo:

| Path              | What it is                                   |
| ----------------- | -------------------------------------------- |
| `apps/web`        | Astro + React frontend (the map app)         |
| `apps/api`        | Fastify + Prisma backend (auth, games, data) |
| `packages/shared` | TypeScript types shared by both              |

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
git clone <repo-url> TaibledFork
cd TaibledFork
pnpm install
```

`pnpm install` also generates the Prisma client automatically (via the api's
`postinstall`).

---

## 4. Configure `.env`

There's one `.env` file at the repo root. Copy the template:

```bash
cp .env.example .env
```

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
| `DISCORD_BOT_TOKEN`     | Optional — leave blank (only adds role-name display in admin UI). |
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
4. (Optional) Under **Bot**, create a bot and copy its token into
   `DISCORD_BOT_TOKEN` if you want role names shown in the admin UI. Not needed
   for login.

### Option B — Use Jules's app

If you'd rather not create one, ask Jules for the `DISCORD_CLIENT_ID` and
`DISCORD_CLIENT_SECRET` and paste them in. Note: the
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
npx prisma migrate deploy
npx tsx prisma/seed.ts
cd ../..
```

These read `DATABASE_URL` from your `.env`, so as long as you set it to
`localhost:5433` in step 4 they'll connect. The seed creates the JetLag servers
and the bundled games (Paris, Bucharest, South Limburg, Espace Mittelland,
Luxembourg, Exter Rotterdam, etc.).

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
pnpm --filter web test
pnpm --filter api test
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
- **API calls fail with a CORS error in the browser console.** `FRONTEND_ORIGIN`
  in `.env` must be `http://localhost:4321` (the web dev port). Restart the API
  after changing it.
- **Discord login fails with a redirect / `invalid_grant` error.** The redirect
  URI in your Discord app doesn't exactly match `DISCORD_REDIRECT_URI`
  (`http://localhost:3000/auth/discord/callback`). They must be identical.
- **Port already in use (5433 / 3000 / 4321).** Something else is using the port.
  Stop it, or check `docker compose ps` for a previously-started stack.
- **`pnpm` not found / wrong version.** Re-run
  `corepack prepare pnpm@11.1.3 --activate`.
