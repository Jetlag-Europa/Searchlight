#!/usr/bin/env bash
# Deploy or update the PRODUCTION stack on the VPS (Cloudflare Tunnel, no ports).
# Run from the repo root of the VPS clone.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/.."

docker compose \
  --project-name writemap \
  -f "${COMPOSE_DIR}/docker-compose.yml" \
  -f "${COMPOSE_DIR}/docker-compose.vps.yml" \
  up -d --build

echo "VPS production stack updated."
docker compose --project-name writemap ps

# Game rows are NOT created by the deploy. The api container runs
# `prisma migrate deploy` on boot, which applies schema changes only — a new
# bundled game in GAME_REGISTRY needs the seed run explicitly, or it will show
# up in the web bundle and then fail to activate for lack of a Game row.
# The seed upserts by sentinelValue, so re-running it is safe and idempotent.
cat <<'EOF'

If this deploy added or changed a bundled game, register it now:

  docker compose --project-name writemap exec api sh -c 'cd /app/apps/api && pnpm seed:prod'

EOF
