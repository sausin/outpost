#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Outpost backup — snapshot Redis RDB + config files into a tarball.
# Usage: scripts/backup.sh [output-path]
#   Default output: ./backups/outpost-YYYYMMDD-HHMMSS.tar.gz
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

TS=$(date +%Y%m%d-%H%M%S)
OUT="${1:-./backups/outpost-${TS}.tar.gz}"
mkdir -p "$(dirname "$OUT")"

echo "Starting backup to ${OUT} ..."

# ── 1. Flush Redis to disk (BGSAVE is async; wait for completion) ───────────
REDIS_RUNNING=0
if docker compose ps redis 2>/dev/null | grep -q "running\|Up"; then
  REDIS_RUNNING=1
fi

DUMP_AVAILABLE=0
TMP=$(mktemp -d)

if [ "$REDIS_RUNNING" = "1" ]; then
  echo "Triggering Redis BGSAVE..."
  # Record the current LASTSAVE timestamp before we trigger
  LAST_SAVE=$(docker compose exec -T redis redis-cli LASTSAVE 2>/dev/null | tr -d '\r\n' || echo "0")

  docker compose exec -T redis redis-cli BGSAVE >/dev/null 2>&1 || true

  # Wait up to 30s for the BGSAVE to finish (LASTSAVE timestamp changes)
  for _ in $(seq 1 30); do
    NEW_SAVE=$(docker compose exec -T redis redis-cli LASTSAVE 2>/dev/null | tr -d '\r\n' || echo "0")
    if [ "$NEW_SAVE" != "$LAST_SAVE" ]; then
      break
    fi
    sleep 1
  done

  # Locate the Redis data volume (named volume attached at /data)
  REDIS_CID=$(docker compose ps -q redis 2>/dev/null || true)
  VOLUME_NAME=""
  if [ -n "$REDIS_CID" ]; then
    VOLUME_NAME=$(docker inspect "$REDIS_CID" \
      --format='{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Name }}{{ end }}{{ end }}' \
      2>/dev/null || true)
  fi

  if [ -n "$VOLUME_NAME" ]; then
    echo "Copying dump.rdb from volume ${VOLUME_NAME} ..."
    docker run --rm \
      -v "${VOLUME_NAME}:/redis:ro" \
      -v "${TMP}:/out" \
      alpine sh -c "cp /redis/dump.rdb /out/dump.rdb 2>/dev/null || true"
    [ -f "${TMP}/dump.rdb" ] && DUMP_AVAILABLE=1
  else
    echo "Warning: could not locate a named Docker volume for Redis /data. Redis dump will be skipped." >&2
  fi
else
  echo "Warning: Redis container is not running. Redis dump will be skipped." >&2
fi

# ── 2. Build tarball ─────────────────────────────────────────────────────────
# We build the tar in pieces so we can conditionally include the dump.
TAR_ARGS=()
if [ "$DUMP_AVAILABLE" = "1" ]; then
  TAR_ARGS+=("-C" "$TMP" "dump.rdb")
fi

# Config files (all relative to project root)
CONF_FILES=()
[ -f ".env" ]       && CONF_FILES+=(".env")
[ -f "hosts.yaml" ] && CONF_FILES+=("hosts.yaml")
[ -d "app/builtin_providers" ] && CONF_FILES+=("app/builtin_providers")

if [ "${#CONF_FILES[@]}" -gt 0 ] || [ "${#TAR_ARGS[@]}" -gt 0 ]; then
  tar czf "$OUT" \
    "${TAR_ARGS[@]+"${TAR_ARGS[@]}"}" \
    -C "$(pwd)" "${CONF_FILES[@]+"${CONF_FILES[@]}"}"
else
  echo "Warning: nothing to back up (no .env, hosts.yaml, providers dir, or Redis dump)." >&2
  rm -rf "$TMP"
  exit 1
fi

rm -rf "$TMP"

SIZE=$(du -h "$OUT" 2>/dev/null | cut -f1 || echo "?")
echo "Backed up to ${OUT} (${SIZE})"
