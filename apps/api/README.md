# @searchlight/api

Fastify + Prisma backend:

- Discord OAuth login and cookie sessions (`/auth`, `/me`)
- Discord servers, membership and role-based permissions (`/servers`), looked up with the bot token
- The game catalog (`/games`): JSON game definitions stored as revisions, with import, export and access checks, and game links that let whoever holds one start sessions (`/game-links`)
- Game sessions pinned to a game revision, with their questions, strokes and hider state, and the links that join or copy them (`/sessions`, `/links`)
- Live sync: a server-sent event stream per session with ordered replay (`/sessions/:id/stream`, `/sessions/:id/events`)
- Link previews for chat apps: a page and map image per game link (`/og`)

Routes validate with TypeBox (`@fastify/type-provider-typebox`). The game
definition schema and validator live in `packages/shared`, shared with the web
app.

Setup is in the [root README](../../README.md); configuration is the root
`.env` (see `.env.example`).

## Scripts

`dev`, `prisma`, `seed` and `seed:test` read the root `.env`; variables already
set in the environment win.

| Script | What it does |
| --- | --- |
| `dev` | Apply migrations, create missing Discord servers, then run with hot reload |
| `prisma <args>` | The Prisma CLI, e.g. `prisma migrate dev --name <change>` |
| `seed` | Create the Discord servers and default role mappings, resetting server names and restoring revoked mappings (`--missing-only`: only add missing servers) |
| `seed:test` | e2e fixtures: the test user and a session on South Limburg 2026 |
| `test` | Route tests against a real, migrated Postgres |
| `validate-game [<id>]` | The game definition validator on `games/preloaded/<id>.game.json`, or on every bundled game |
| `seed:prod` | The compiled `seed` inside the Docker image |
