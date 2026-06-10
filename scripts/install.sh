#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Outpost installer
# Usage: curl -fsSL https://raw.githubusercontent.com/sausin/outpost/main/scripts/install.sh | bash
#        or: ./scripts/install.sh  (from a clone)
# ---------------------------------------------------------------------------

# ── Debug mode ──────────────────────────────────────────────────────────────
if [ "${OUTPOST_DEBUG:-0}" = "1" ]; then
  set -x
fi

# ── ANSI helpers ────────────────────────────────────────────────────────────
# Only emit color codes when stdout is a terminal
if [ -t 1 ]; then
  _BOLD='\033[1m'
  _DIM='\033[2m'
  _GREEN='\033[0;32m'
  _RED='\033[0;31m'
  _RESET='\033[0m'
else
  _BOLD='' _DIM='' _GREEN='' _RED='' _RESET=''
fi

bold()  { printf "${_BOLD}%s${_RESET}" "$*"; }
dim()   { printf "${_DIM}%s${_RESET}" "$*"; }
green() { printf "${_GREEN}%s${_RESET}" "$*"; }
red()   { printf "${_RED}%s${_RESET}" "$*"; }

# ── Error handler ────────────────────────────────────────────────────────────
die() {
  printf "\n%s %s\n" "$(red "Install failed:")" "$*" >&2
  printf "%s\n" "$(dim "Run with OUTPOST_DEBUG=1 for verbose output")" >&2
  exit 1
}

# ── Banner ───────────────────────────────────────────────────────────────────
printf "\n"
printf "%s\n" "$(bold "Outpost") $(dim "-- the edge sidecar for AI agents")"
printf "\n"

# ── 1. Environment checks ────────────────────────────────────────────────────
# Bash version >= 4
BASH_MAJOR="${BASH_VERSINFO[0]:-0}"
if [ "$BASH_MAJOR" -lt 4 ]; then
  printf "%s\n" "$(dim "Warning: bash < 4 detected (${BASH_VERSION:-unknown}). Continuing anyway, but some features may behave unexpectedly.")"
fi

# docker
if ! command -v docker >/dev/null 2>&1; then
  die "docker not found. Install Docker: https://docs.docker.com/get-docker/"
fi

# docker compose v2
if ! docker compose version >/dev/null 2>&1; then
  die "Docker Compose v2 not found. Upgrade Docker Desktop or install the compose plugin: https://docs.docker.com/compose/install/"
fi

# curl or wget (for health-check later)
if ! command -v curl >/dev/null 2>&1 && ! command -v wget >/dev/null 2>&1; then
  die "Neither curl nor wget found. Install one to continue."
fi

# Prefer curl for health checks; fall back to wget
if command -v curl >/dev/null 2>&1; then
  _HTTP_GET='curl -fsSL'
else
  _HTTP_GET='wget -qO-'
fi

# ── 2. Detect repo presence ──────────────────────────────────────────────────
INSTALL_FROM_CWD=0
if [ -f "./pyproject.toml" ] && grep -q 'name = "outpost"' ./pyproject.toml 2>/dev/null; then
  INSTALL_FROM_CWD=1
fi

if [ "$INSTALL_FROM_CWD" = "0" ]; then
  # curl-pipe-bash path: need to clone
  DEFAULT_DIR="$HOME/outpost"
  printf "Install directory [%s]: " "$(bold "$DEFAULT_DIR")"
  read -r USER_DIR
  INSTALL_DIR="${USER_DIR:-$DEFAULT_DIR}"

  if [ -d "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
    printf "Directory %s already exists and is non-empty.\n" "$(bold "$INSTALL_DIR")"
    printf "  [1] Overwrite (re-clone into it)\n"
    printf "  [2] Enter a different directory\n"
    printf "  [3] Abort\n"
    printf "Select [1-3, default 3]: "
    read -r DIR_CHOICE
    case "${DIR_CHOICE:-3}" in
      1)
        rm -rf "$INSTALL_DIR"
        ;;
      2)
        printf "New install directory: "
        read -r INSTALL_DIR
        [ -n "$INSTALL_DIR" ] || die "No directory entered."
        ;;
      3|*)
        printf "Aborted.\n"
        exit 0
        ;;
    esac
  fi

  printf "\nCloning Outpost into %s ...\n" "$(bold "$INSTALL_DIR")"
  git clone https://github.com/sausin/outpost.git "$INSTALL_DIR" \
    || die "git clone failed. Check the URL and your network connection."
  cd "$INSTALL_DIR"
fi

# ── 3a. Implementation choice ────────────────────────────────────────────────
printf "\n"
printf "Which Outpost runtime image?\n"
printf "  1) Python  -- mature, full plugin support, what most users want\n"
printf "  2) TypeScript -- Cloudflare-Workers-compatible Node runtime\n"
printf "Select [1-2, default 1]: "
read -r IMPL_CHOICE
IMPL_CHOICE="${IMPL_CHOICE:-1}"

case "$IMPL_CHOICE" in
  2) OUTPOST_IMPL="ts" ;;
  *) OUTPOST_IMPL="python" ;;
esac

# ── 3b. Mode selection ───────────────────────────────────────────────────────
printf "\n"
printf "How will Outpost be reached?\n"
printf "  1) Internal only      -- sidecar on same network as your agent (no HTTPS)\n"
printf "  2) Public via domain  -- Caddy + Let's Encrypt auto-HTTPS\n"
printf "Select [1-2, default 1]: "
read -r MODE_CHOICE
MODE_CHOICE="${MODE_CHOICE:-1}"

OUTPOST_MODE="internal"
DOMAIN=""
ACME_EMAIL=""

if [ "$MODE_CHOICE" = "2" ]; then
  OUTPOST_MODE="public"

  # Prompt for domain
  while true; do
    printf "Domain (e.g. outpost.example.com): "
    read -r DOMAIN
    # Must contain a dot, no scheme, no path
    if printf '%s' "$DOMAIN" | grep -qE '^[^/: ]+\.[^/: ]+$'; then
      break
    else
      printf "%s\n" "$(red "Invalid domain — enter a hostname without http:// or path (e.g. outpost.example.com)")"
    fi
  done

  # Prompt for ACME email
  while true; do
    printf "Email for Let's Encrypt notifications: "
    read -r ACME_EMAIL
    if printf '%s' "$ACME_EMAIL" | grep -q '@'; then
      break
    else
      printf "%s\n" "$(red "Invalid email — must contain @")"
    fi
  done
fi

# ── 4. Provider acknowledgment ───────────────────────────────────────────────
printf "\n"
printf "Outpost ships built-in providers (groww, upstox, stripe, openai).\n"
printf "You can enable/configure these later by editing app/builtin_providers/*.yaml\n"
printf "and setting credentials in .env. Continue? [Y/n] "
read -r PROV_CHOICE
case "${PROV_CHOICE:-Y}" in
  [Nn]*) printf "Aborted.\n"; exit 0 ;;
esac

# ── 5. Write .env ────────────────────────────────────────────────────────────
if [ -f ".env" ]; then
  printf "\n.env already exists.\n"
  printf "  [1] Keep existing (skip)\n"
  printf "  [2] Overwrite with .env.example\n"
  printf "  [3] Merge — add missing keys only\n"
  printf "Select [1-3, default 1]: "
  read -r ENV_CHOICE
  ENV_CHOICE="${ENV_CHOICE:-1}"
else
  ENV_CHOICE="2"
fi

case "$ENV_CHOICE" in
  2)
    cp .env.example .env
    ;;
  3)
    # Add keys from .env.example that are not already in .env
    while IFS= read -r line; do
      # Skip comments and blanks
      case "$line" in
        '#'*|'') continue ;;
      esac
      KEY="${line%%=*}"
      if ! grep -qE "^${KEY}=" .env 2>/dev/null; then
        printf '%s\n' "$line" >> .env
      fi
    done < .env.example
    ;;
  1|*)
    : # keep existing
    ;;
esac

# Ensure OUTPOST_MODE + OUTPOST_IMPL are set in .env
for kv in "OUTPOST_MODE=${OUTPOST_MODE}" "OUTPOST_IMPL=${OUTPOST_IMPL}"; do
  KEY="${kv%%=*}"
  VAL="${kv#*=}"
  if grep -qE "^${KEY}=" .env 2>/dev/null; then
    sed -i "s/^${KEY}=.*/${KEY}=${VAL}/" .env
  else
    printf '%s=%s\n' "$KEY" "$VAL" >> .env
  fi
done

if [ "$OUTPOST_MODE" = "public" ]; then
  for kv in "DOMAIN=${DOMAIN}" "ACME_EMAIL=${ACME_EMAIL}"; do
    KEY="${kv%%=*}"
    VAL="${kv#*=}"
    if grep -qE "^${KEY}=" .env 2>/dev/null; then
      sed -i "s/^${KEY}=.*/${KEY}=${VAL}/" .env
    else
      printf '%s=%s\n' "$KEY" "$VAL" >> .env
    fi
  done
fi

# ── 6. Pull images ───────────────────────────────────────────────────────────
printf "\n"
printf "%s\n" "$(bold "Pulling images...")"
if [ "$OUTPOST_MODE" = "public" ]; then
  docker compose -f docker-compose.yml -f docker-compose.public.yml pull
else
  docker compose pull
fi

# ── 7. Bring stack up ────────────────────────────────────────────────────────
printf "\n"
printf "%s\n" "$(bold "Starting Outpost...")"
if [ "$OUTPOST_MODE" = "public" ]; then
  docker compose -f docker-compose.yml -f docker-compose.public.yml up -d
else
  docker compose up -d
fi

# ── 8. Wait for readiness ────────────────────────────────────────────────────
printf "\n"
printf "Waiting for Outpost to become ready"

if [ "$OUTPOST_MODE" = "public" ]; then
  HEALTHZ_URL="https://${DOMAIN}/healthz"
  MAX_ATTEMPTS=90
else
  HEALTHZ_URL="http://localhost:8080/healthz"
  MAX_ATTEMPTS=30
fi

ATTEMPT=0
READY=0
while [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
  if $_HTTP_GET "$HEALTHZ_URL" >/dev/null 2>&1; then
    READY=1
    break
  fi
  printf "."
  sleep 1
  ATTEMPT=$((ATTEMPT + 1))
done

printf "\n"

if [ "$READY" = "0" ]; then
  printf "\n%s\n" "$(red "Outpost did not become healthy in time. Last proxy logs:")"
  docker compose logs --tail=20 proxy >&2 || true
  die "Health check timed out after ${MAX_ATTEMPTS}s at ${HEALTHZ_URL}"
fi

# ── 9. Done summary ──────────────────────────────────────────────────────────
if [ "$OUTPOST_MODE" = "public" ]; then
  ENDPOINT="https://${DOMAIN}"
else
  ENDPOINT="http://localhost:8080"
fi

printf "\n"
printf "%s Outpost is running.\n" "$(green "✓")"
printf "\n"
printf "  Endpoint:   %s\n" "$(bold "$ENDPOINT")"
printf "  Docs:       %s/docs\n" "$ENDPOINT"
printf "  Health:     %s/healthz\n" "$ENDPOINT"
printf "  Providers:  %s/providers\n" "$ENDPOINT"
printf "\n"
printf "Next steps:\n"
printf "  * Edit .env to set your provider credentials\n"
printf "  * Edit hosts.yaml to allowlist your agent's source IP\n"
printf "  * make logs    -- tail proxy logs\n"
printf "  * make status  -- container status + health\n"
printf "  * make update  -- pull and restart\n"
printf "  * make backup  -- snapshot Redis + config\n"
printf "\n"
