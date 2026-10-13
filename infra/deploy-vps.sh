#!/usr/bin/env bash
# Deploy or update the PRODUCTION stack on the VPS (Cloudflare Tunnel, no ports).
# Run from the repo root of the VPS clone.
#
# By default, pulls the api and web images CI built for the checked-out commit
# (ghcr.io/…/searchlight-{api,web}:sha-<commit>, see
# .github/workflows/docker-images.yml), so `git pull` first and wait for the
# commit's "Docker images" run to finish. SEARCHLIGHT_IMAGE_TAG=<tag> deploys
# another tag (e.g. latest).
#
#   --build   build the images from this checkout on the VPS instead
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${SCRIPT_DIR}/.."

compose() {
  docker compose \
    --project-name writemap \
    -f "${COMPOSE_DIR}/docker-compose.yml" \
    -f "${COMPOSE_DIR}/docker-compose.vps.yml" \
    "$@"
}

if [[ "${1:-}" == "--build" ]]; then
  compose up -d --build
else
  export SEARCHLIGHT_IMAGE_TAG="${SEARCHLIGHT_IMAGE_TAG:-sha-$(git -C "${COMPOSE_DIR}" rev-parse HEAD | cut -c1-7)}"
  echo "Pulling api and web images tagged ${SEARCHLIGHT_IMAGE_TAG}..."
  if ! compose pull api web; then
    echo "Pull failed. Has CI finished building this commit, and is the VPS logged in to ghcr.io?" >&2
    echo "Deploy from source instead with: bash infra/deploy-vps.sh --build" >&2
    exit 1
  fi
  compose up -d --no-build
fi

echo "VPS production stack updated."
docker compose --project-name writemap ps

# Game definitions in games/preloaded/ are automatically preloaded by the api
# container on boot.
