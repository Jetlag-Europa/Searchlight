#!/usr/bin/env bash
# Deploy or update the PRODUCTION stack on the Mac mini.
# Run from /srv/WriteMap/TaibledFork/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/.."

docker compose \
  --project-name writemap \
  -f "${COMPOSE_DIR}/docker-compose.yml" \
  up -d --build

echo "Production stack updated."
docker compose --project-name writemap ps
