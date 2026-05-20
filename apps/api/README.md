# @taibled/api

Fastify backend for TaibledFork. Provides Discord OAuth, session management, and the `/me` endpoint.

## ADR: Schema validation

TypeBox (`@fastify/type-provider-typebox`) was chosen over Zod for backend route validation.
Reason: it is the official Fastify type provider, integrates natively at the framework level with no bridging package, and gives compile-time + runtime request/response safety in one step. The frontend continues to use Zod (its own concern); `packages/shared` exposes plain TypeScript interfaces that both sides consume without a runtime schema library.

## Development

```bash
# From repo root
pnpm --filter api dev
```

Requires a running Postgres instance and a `.env` file at the repo root. See `.env.example`.

## Environment variables

See `.env.example` at the repo root for the full list.
