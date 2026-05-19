#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Outpost restore — restore from a backup tarball.
# Usage: scripts/restore.sh <path-to-backup.tar.gz>
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

BACKUP="${1:?Usage: scripts/restore.sh <path-to-backup.tar.gz>}"
[ -f "$BACKUP" ] || { echo "Backup file not found: ${BACKUP}" >&2; exit 1; }

echo "This will:"
echo "  * Stop Outpost"
echo "  * Replace .env, hosts.yaml, app/builtin_providers/"
echo "  * Replace Redis dump.rdb"
echo "  * Restart Outpost"
printf "Continue? [y/N] "
read -r ans
case "${ans:-N}" in
  [Yy]) : ;;
  *) echo "Aborted."; exit 0 ;;
esac

echo "Stopping stack..."
docker compose down

TMP=$(mktemp -d)
echo "Extracting ${BACKUP} ..."
tar xzf "$BACKUP" -C "$TMP"

# ── Restore config files ──────────────────────────────────────────────────────
[ -f "${TMP}/.env" ]       && cp "${TMP}/.env" ./.env       && echo "Restored .env"
[ -f "${TMP}/hosts.yaml" ] && cp "${TMP}/hosts.yaml" ./hosts.yaml && echo "Restored hosts.yaml"
if [ -d "${TMP}/app/builtin_providers" ]; then
  cp -r "${TMP}/app/builtin_providers/." ./app/builtin_providers/
  echo "Restored app/builtin_providers/"
elif [ -d "${TMP}/builtin_providers" ]; then
  # Older backup format where the directory was at the tarball root
  cp -r "${TMP}/builtin_providers/." ./app/builtin_providers/
  echo "Restored app/builtin_providers/ (from legacy backup layout)"
fi

# ── Restore Redis dump ────────────────────────────────────────────────────────
if [ -f "${TMP}/dump.rdb" ]; then
  echo "Restoring Redis data..."
  # Bring Redis up alone first so we can copy the dump in
  docker compose up -d redis
  sleep 2
  docker compose cp "${TMP}/dump.rdb" redis:/data/dump.rdb
  docker compose restart redis
  echo "Redis data restored."
else
  echo "No Redis dump found in backup; skipping Redis restore."
fi

# ── Bring full stack back up ──────────────────────────────────────────────────
MODE=$(grep -E '^OUTPOST_MODE=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
MODE="${MODE:-internal}"

echo "Starting stack (mode: ${MODE})..."
if [ "$MODE" = "public" ]; then
  docker compose -f docker-compose.yml -f docker-compose.public.yml up -d
else
  docker compose up -d
fi

rm -rf "$TMP"
echo "Restore complete."
