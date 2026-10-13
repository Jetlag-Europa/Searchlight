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

# Game definitions in games/preloaded/ are automatically preloaded by the api
# container on boot.
