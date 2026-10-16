#!/usr/bin/env bash
# Build and start the isolated e2e stack (docker-compose.test.yml), then seed the
# Playwright fixtures. Safe to re-run. Needs the dev .env (for the Discord
# values the API requires) and `pnpm install`. See docs/TESTING.md.
#
#   infra/deploy-test.sh        start (or rebuild) and seed
#   infra/deploy-test.sh down   stop and delete the test database
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

export COMPOSE_PROJECT_NAME=searchlight-test
export COMPOSE_FILE=docker-compose.yml:docker-compose.test.yml
export POSTGRES_PASSWORD=test

if [[ "${1:-}" == "down" ]]; then
  exec docker compose down -v --remove-orphans
fi

docker compose up -d --build --wait --remove-orphans

# The API container has migrated, created the servers and imported the games;
# the fixtures need tsx, so they are seeded from the host.
DATABASE_URL="postgresql://taibled:${POSTGRES_PASSWORD}@127.0.0.1:5435/taibled" \
  pnpm --filter @searchlight/api seed:test

echo
echo "Test stack ready: web http://127.0.0.1:8280, api http://127.0.0.1:3200"
echo "Run the specs:    pnpm --filter @searchlight/web test:e2e"
echo "Tear down:        infra/deploy-test.sh down"
