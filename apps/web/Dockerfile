# Build stage
FROM node:20-slim AS builder
RUN npm install -g pnpm@11.1.3
WORKDIR /app

# Copy workspace manifests first for layer-cached installs
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/tsconfig.json apps/web/astro.config.mjs ./apps/web/
COPY apps/web/tailwind.config.mjs apps/web/components.json ./apps/web/
COPY packages/shared/package.json packages/shared/tsconfig.json ./packages/shared/

RUN pnpm install --frozen-lockfile

# Build shared types first, then the web app
COPY packages/shared/src ./packages/shared/src
RUN pnpm --filter shared build

COPY apps/web/src ./apps/web/src
COPY apps/web/public ./apps/web/public

# PUBLIC_API_BASE must be set at build time (baked into the static output)
ARG PUBLIC_API_BASE
ENV PUBLIC_API_BASE=${PUBLIC_API_BASE}

RUN pnpm --filter web build

# Runtime stage — nginx:alpine serving the static output
FROM nginx:alpine AS runner
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
