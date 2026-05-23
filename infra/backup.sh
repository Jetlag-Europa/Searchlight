#!/usr/bin/env bash
# Nightly Postgres backup for WriteMap PRODUCTION stack.
# Run via cron on the Mac mini — see DEPLOY.md for the cron line.
#
# TODO: encryption at rest is not implemented.
# See PLAN.md "Open questions → backup retention and whether to encrypt
# backups at rest". Until resolved, backups are unencrypted gzip.

set -euo pipefail

BACKUP_DIR="/Users/juleswitold/Dev/WriteMap/backups"
COMPOSE_DIR="/Users/juleswitold/Dev/WriteMap/TaibledFork"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
FILENAME="writemap-${TIMESTAMP}.sql.gz"
RETENTION_DAYS=30

mkdir -p "${BACKUP_DIR}"

# Dump via the running Compose postgres service (no host port needed)
docker compose \
  --project-name writemap \
  -f "${COMPOSE_DIR}/docker-compose.yml" \
  exec -T postgres \
  pg_dump -U "${POSTGRES_USER:-taibled}" taibled \
  | gzip > "${BACKUP_DIR}/${FILENAME}"

echo "Backup written: ${BACKUP_DIR}/${FILENAME}"

# 30-day retention: delete dumps older than RETENTION_DAYS
find "${BACKUP_DIR}" -maxdepth 1 -name "writemap-*.sql.gz" \
  -mtime "+${RETENTION_DAYS}" -delete

echo "Retention: removed files older than ${RETENTION_DAYS} days"
