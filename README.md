# Searchlight

A map planner for Jet Lag: The Game's Hide and Seek. Players log in with
Discord, pick a game, and share live sessions in which every answered question
eliminates part of the map.

| Path | What it is |
| --- | --- |
| `apps/web` | Astro + React frontend (the map) |
| `apps/api` | Fastify + Prisma backend: auth, games, sessions, live sync |
| `packages/shared` | Types and the game definition schema, validator and checksum |
| `games/preloaded` | The bundled games, one JSON definition each, imported by the API on start |

Running it on a server: [`DEPLOY.md`](DEPLOY.md). Adding a game:
[`docs/ADDING_GAMES.md`](docs/ADDING_GAMES.md). Tests:
[`docs/TESTING.md`](docs/TESTING.md).

## Development

You need Docker (running), Node 22 and pnpm (`corepack enable` installs the
version the repo pins).

**1. A Discord application.** Login and server membership go through Discord.
At <https://discord.com/developers/applications> create an application, then:

- **OAuth2:** copy the Client ID and Client Secret, and add the redirect
  `http://localhost:3000/auth/discord/callback`.
- **Bot:** reset and copy the token. The API reads server membership and roles
  with it, so it only sees servers the bot has joined.

**2. Configure.**

```bash
cp .env.example .env
```

Fill in the Discord values, a `SESSION_COOKIE_SECRET` (`openssl rand -hex 32`)
and your own Discord user ID in `ADMIN_DISCORD_IDS` (Discord → Settings →
Advanced → Developer Mode, then right-click your name → Copy User ID). Admins
see every game even when your bot isn't in the game's server. The rest of the
file already matches the dev setup.

**3. Run.**

```bash
pnpm install
pnpm dev
```

`pnpm dev` starts Postgres in Docker (`docker-compose.dev.yml`, on
`localhost:5433`), then runs everything with hot reload: the shared package,
the API on <http://localhost:3000> (it applies migrations and creates the
Discord servers first) and the web app on <http://localhost:4321>. Open the
web app and log in.

The API imports `games/preloaded/*.game.json` when it starts, so restart
`pnpm dev` after editing a game.

### Everyday commands

```bash
pnpm --filter @searchlight/api prisma migrate dev --name <change>  # new migration after editing schema.prisma
pnpm --filter @searchlight/api seed                                # reset server names and default role mappings
docker compose -f docker-compose.dev.yml down                      # stop Postgres
docker compose -f docker-compose.dev.yml down -v                   # ...and delete the database
```

The API scripts read the root `.env`; so does the web app (for `PUBLIC_API_BASE`).

### When something doesn't work

- **CORS errors in the browser:** `FRONTEND_ORIGIN` must be exactly
  `http://localhost:4321`.
- **Discord login fails (`invalid_grant`, redirect error):** the redirect in
  your Discord application must equal `DISCORD_REDIRECT_URI` character for
  character.
- **A game list is empty or `/games` returns 403:** the bot isn't in that
  Discord server. Put your user ID in `ADMIN_DISCORD_IDS` and restart.
- **`Missing required env var`:** a value in `.env` is still empty.
