#!/usr/bin/env bash
# Nightly Postgres backup of the PRODUCTION stack (project `writemap`): a gzipped
# pg_dump through the running postgres container, kept for 30 days. Dumps are
# not encrypted. Cron line and restore steps: DEPLOY.md → Backups.
#
# Dumps go to backups/ next to the repo clone (/srv/WriteMap/backups on the
# VPS). Override with WRITEMAP_BACKUP_DIR, and the clone with
# WRITEMAP_COMPOSE_DIR.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${WRITEMAP_COMPOSE_DIR:-$(dirname "${SCRIPT_DIR}")}"
BACKUP_DIR="${WRITEMAP_BACKUP_DIR:-$(dirname "${COMPOSE_DIR}")/backups}"
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
