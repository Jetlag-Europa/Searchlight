#!/usr/bin/env bash
# Deploy or update the DEV stack on the Mac mini.
# Run from /srv/WriteMap-Dev/TaibledFork/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/.."

docker compose \
  --project-name writemap-dev \
  -f "${COMPOSE_DIR}/docker-compose.yml" \
  -f "${COMPOSE_DIR}/docker-compose.dev.yml" \
  up -d --build

echo "Dev stack updated."
docker compose --project-name writemap-dev ps
