# Build stage
FROM node:20-slim AS builder
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
RUN pnpm --filter api build

# Runtime stage — only production deps + compiled output
FROM node:20-alpine AS runner
RUN npm install -g pnpm@11.1.3
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/tsconfig.json ./apps/api/
COPY apps/api/prisma ./apps/api/prisma
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/

RUN pnpm install --frozen-lockfile --prod

# Copy compiled output from builder
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist

# Run migrations then start the API
CMD sh -c "pnpm --filter api exec prisma migrate deploy && node apps/api/dist/index.js"
