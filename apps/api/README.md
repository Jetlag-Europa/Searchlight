# @searchlight/api

Fastify + Prisma backend for Searchlight:

- Discord OAuth login and cookie sessions (`/auth`, `/me`)
- Discord servers, membership and role-based permissions (`/servers`); membership and roles are looked up with the bot token
- The game catalog (`/games`): JSON game definitions stored as revisions, with import (`POST /games/import`), export and access checks
- Game sessions pinned to a game revision, their questions, strokes and hider state, invites and share links (`/sessions`, `/links`)
- Live sync: a server-sent event stream per session (`/sessions/:id/stream`) with ordered replay (`/sessions/:id/events`, `/sessions/:id/events/cursor`)
- Feedback (`/feedback`), and an Overpass proxy plus OSM boundary lookups for free play without a game (`/boundaries`, `/overpass`)

On every start it imports each `games/preloaded/*.game.json` (see [`docs/ADDING_GAMES.md`](../../docs/ADDING_GAMES.md)).

## ADR: Schema validation

TypeBox (`@fastify/type-provider-typebox`) was chosen over Zod for backend route validation.
Reason: it is the official Fastify type provider, integrates natively at the framework level with no bridging package, and gives compile-time + runtime request/response safety in one step. The frontend uses Zod for its question state. `packages/shared` holds the types both sides share and the game definition format: its TypeBox schema, validator and canonical checksum, used by this API (import, preload) and by the web app (import preview, compiler).

## Development

```bash
# From repo root
pnpm --filter api dev
```

Requires a running Postgres instance and a `.env` file at the repo root; see [`SETUP.md`](../../SETUP.md) and `.env.example`.

## Tests

The tests run against a real, migrated Postgres database (they create and delete their own rows). `DATABASE_URL` defaults to `postgresql://taibled:devpassword@localhost:5433/taibled` (the local Postgres from `docker-compose.override.yml`); point it at your database otherwise:

```bash
DATABASE_URL=postgresql://taibled:<password>@localhost:5433/taibled pnpm --filter api test
```

## Scripts

| Script | What it does |
| --- | --- |
| `dev` | API with hot reload, reading `../../.env` |
| `seed` / `seed:prod` | Create the Discord servers and default role mappings, resetting server names and restoring revoked default mappings (`seed:prod` runs the compiled seed in the image) |
| `seed:test` | e2e fixtures: the test user and a session on South Limburg 2026 (run after the API has preloaded games) |
| `validate-game <id>` | Server validator on `games/preloaded/<id>.game.json` |

## Environment variables

See `.env.example` at the repo root for the full list.
