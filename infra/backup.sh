#!/usr/bin/env bash
# Gzipped pg_dump of the running stack's database, kept for 30 days. Dumps are
# not encrypted. Written to ../backups next to the clone unless BACKUP_DIR is
# set. Cron line and restore: DEPLOY.md → Backups.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

BACKUP_DIR="${BACKUP_DIR:-$(dirname "$PWD")/backups}"
FILE="${BACKUP_DIR}/searchlight-$(date +%Y%m%d-%H%M%S).sql.gz"
mkdir -p "${BACKUP_DIR}"

docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' \
  | gzip > "${FILE}" || { rm -f "${FILE}"; exit 1; }
echo "Backup written: ${FILE}"

find "${BACKUP_DIR}" -maxdepth 1 -name '*.sql.gz' -mtime +30 -delete
