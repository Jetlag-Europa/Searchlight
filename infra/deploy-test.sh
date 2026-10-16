#!/usr/bin/env bash
# Build and start the isolated e2e stack (docker-compose.test.yml), then seed the
# Playwright fixtures. Safe to re-run. Needs the dev .env (for the Discord
# values the API requires) and `pnpm install`. See docs/TESTING.md.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

export POSTGRES_PASSWORD=test
compose() {
  docker compose -p searchlight-test -f docker-compose.yml -f docker-compose.test.yml "$@"
}

compose up -d --build --wait

# The API container has migrated, created the servers and imported the games;
# the fixtures need tsx, so they are seeded from the host.
DATABASE_URL="postgresql://taibled:${POSTGRES_PASSWORD}@127.0.0.1:5435/taibled" \
  pnpm --filter @searchlight/api seed:test

echo
echo "Test stack ready: web http://127.0.0.1:8280, api http://127.0.0.1:3200"
echo "Run the specs:    pnpm --filter @searchlight/web test:e2e"
echo "Tear down:        docker compose -p searchlight-test down -v"
