#!/usr/bin/env bash
# Bring up the isolated e2e stack (`writemap-test`), then seed base data + the
# deterministic e2e fixtures. Idempotent — safe to re-run.
#
# Requires a .env (base secrets) and .env.test (test overrides; see
# .env.test.example) in the repo root. Seeding runs from the HOST against the
# published test DB port (the runtime API image has no tsx), like seed:dev.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/.."
cd "${COMPOSE_DIR}"

if [[ ! -f .env.test ]]; then
  echo "Missing .env.test — copy .env.test.example to .env.test first." >&2
  exit 1
fi

docker compose \
  --project-name writemap-test \
  -f docker-compose.yml \
  -f docker-compose.test.yml \
  up -d --build

# Wait until the API is up (migrate deploy runs before it listens, so a healthy
# /health implies the schema is migrated).
echo "Waiting for the test API to come up..."
until curl -sf http://localhost:3200/health >/dev/null 2>&1; do sleep 1; done

# Seed from the host against the published test DB (5435).
PG_USER="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2- || echo taibled)"
PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' .env | cut -d= -f2- || echo devpassword)"
TEST_DB_URL="postgresql://${PG_USER:-taibled}:${PG_PASS:-devpassword}@localhost:5435/taibled"

echo "Seeding base data + e2e fixtures..."
DATABASE_URL="$TEST_DB_URL" pnpm --filter api seed
DATABASE_URL="$TEST_DB_URL" pnpm --filter api seed:test

echo
echo "Test stack ready:"
echo "  web     http://localhost:8280"
echo "  api     http://localhost:3200"
echo "  pg      localhost:5435"
docker compose --project-name writemap-test ps
