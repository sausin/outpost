#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Outpost updater — pull latest images and restart the stack.
# Run from the project root (same directory as docker-compose.yml).
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

MODE=$(grep -E '^OUTPOST_MODE=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
MODE="${MODE:-internal}"

if [ "$MODE" = "public" ]; then
  COMPOSE_FILES="-f docker-compose.yml -f docker-compose.public.yml"
else
  COMPOSE_FILES="-f docker-compose.yml"
fi

echo "Pulling latest images..."
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES pull

echo "Restarting stack..."
# shellcheck disable=SC2086
docker compose $COMPOSE_FILES up -d --remove-orphans

echo "Pruning unused images..."
docker image prune -f

echo "Outpost updated."
