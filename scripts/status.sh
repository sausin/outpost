#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Outpost status — container status + health snapshot.
# Run from the project root or anywhere; script resolves the path.
# ---------------------------------------------------------------------------

cd "$(dirname "$0")/.."

MODE=$(grep -E '^OUTPOST_MODE=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
MODE="${MODE:-internal}"

echo "=== Container status ==="
docker compose ps
echo ""

# Determine health check URL
if [ "$MODE" = "public" ]; then
  DOMAIN=$(grep -E '^DOMAIN=' .env 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  if [ -n "$DOMAIN" ]; then
    HEALTHZ_URL="https://${DOMAIN}/healthz"
  else
    HEALTHZ_URL="http://localhost:8080/healthz"
  fi
else
  HEALTHZ_URL="http://localhost:8080/healthz"
fi

echo "=== Health check (${HEALTHZ_URL}) ==="
if curl -fsSL "$HEALTHZ_URL" >/dev/null 2>&1; then
  echo "Health: healthy"
  curl -s "$HEALTHZ_URL" | sed 's/^/  /'
  echo ""
else
  echo "Health: unreachable at ${HEALTHZ_URL}"
fi
