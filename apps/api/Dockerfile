# Build stage
FROM node:22-slim AS builder
RUN npm install -g pnpm@11.1.3
WORKDIR /app

# Copy workspace manifests first for layer-cached installs
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# Build shared types first, then the API
COPY packages/shared/src ./packages/shared/src
RUN pnpm --filter shared build

COPY apps/api/src ./apps/api/src
COPY apps/api/tsconfig.seed.json ./apps/api/
RUN pnpm --filter api build
# The seed is compiled too: the runtime stage installs prod deps only, so tsx
# isn't there to run prisma/seed.ts directly. Needed to register new bundled
# games (see docs/ADDING_GAMES.md) — migrations alone do not create game rows.
RUN pnpm --filter api build:seed

# Runtime stage — only production deps + compiled output
FROM node:22-alpine AS runner
RUN npm install -g pnpm@11.1.3
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/

RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/dist-seed ./apps/api/dist-seed
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Run migrations then start the API
CMD sh -c "pnpm --filter api exec prisma migrate deploy && node apps/api/dist/index.js"
