#!/usr/bin/env bash
# Deploy or update the stack described by .env (COMPOSE_FILE). See DEPLOY.md.
#
#   infra/deploy.sh           pull the images CI built for the checked-out commit
#   infra/deploy.sh --build   build the images from this checkout instead
#
# SEARCHLIGHT_IMAGE_TAG=<tag> pulls another tag, e.g. latest or an older sha-.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! grep -q '^COMPOSE_PROJECT_NAME=' .env 2>/dev/null; then
  echo "Set COMPOSE_PROJECT_NAME in .env (see .env.prod.example) first." >&2
  exit 1
fi

if [[ "${1:-}" == "--build" ]]; then
  docker compose up -d --build --remove-orphans
else
  export SEARCHLIGHT_IMAGE_TAG="${SEARCHLIGHT_IMAGE_TAG:-sha-$(git rev-parse --short=7 HEAD)}"
  # Only our images: postgres and cloudflared keep the versions they run.
  images=$(docker compose config --services | grep -xE 'api|web')
  echo "Pulling ${images//$'\n'/, } at ${SEARCHLIGHT_IMAGE_TAG}..."
  # shellcheck disable=SC2086
  if ! docker compose pull $images; then
    echo "Pull failed. Has CI finished building this commit, and is this host logged in to ghcr.io?" >&2
    echo "Build here instead with: infra/deploy.sh --build" >&2
    exit 1
  fi
  docker compose up -d --no-build --remove-orphans
fi

# Drop images no container uses that are over a week old; a rollback pulls
# them again.
docker image prune -af --filter "until=168h" >/dev/null \
  || echo "Warning: pruning old images failed; the deploy itself succeeded." >&2

docker compose ps
