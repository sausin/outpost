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

# ── Re-attach stdin to the TTY ──────────────────────────────────────────────
# When this script is invoked via `curl ... | bash`, stdin is the script
# source itself — so any `read` would consume script bytes (not user input)
# and immediately return empty, silently accepting every default. Reopening
# stdin from /dev/tty fixes this. If no TTY is available (e.g. truly
# headless / cron), bail out with a clear path forward.
if [ ! -t 0 ]; then
  # Probe in a subshell so failure doesn't tear down the parent and so any
  # bash error message about the missing device is silenced by the redirect.
  if ! ( : </dev/tty ) 2>/dev/null; then
    die "No TTY available for interactive prompts. Re-run from a clone:
  git clone https://github.com/sausin/outpost.git
  cd outpost && ./scripts/install.sh"
  fi
  exec </dev/tty
fi

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
printf "%s Outpost is running.\n" "$(green "OK")"
printf "\n"
printf "  Endpoint:   %s\n" "$(bold "$ENDPOINT")"
printf "  Docs:       %s/docs\n" "$ENDPOINT"
printf "  Health:     %s/healthz\n" "$ENDPOINT"
printf "  Providers:  %s/providers\n" "$ENDPOINT"
printf "\n"

# ── Provider configuration guidance ─────────────────────────────────────────
printf "%s\n" "$(bold "Configure your providers")"
printf "\n"
printf "Outpost ships four provider definitions. Edit the YAML files to switch\n"
printf "providers on, and set the matching env vars in .env. Both files reload\n"
printf "without an image rebuild (the volumes are bind-mounted).\n"
printf "\n"
printf "  %-10s %-9s %s\n" "$(bold "Provider")" "$(bold "Enabled")" "$(bold "Required env vars to set in .env")"
printf "  %-10s %-9s %s\n" "--------" "-------" "--------------------------------"
printf "  %-10s %-9s %s\n" "groww"   "yes"  "GROWW_API_KEY + GROWW_API_SECRET"
printf "  %-10s %-9s %s\n" "upstox"  "yes"  "UPSTOX_ACCESS_TOKEN (operator-supplied OAuth token)"
printf "  %-10s %-9s %s\n" "stripe"  "no"   "STRIPE_SECRET_KEY (and set enabled: true in stripe.yaml)"
printf "  %-10s %-9s %s\n" "openai"  "no"   "OPENAI_API_KEY (and set enabled: true in openai.yaml)"
printf "\n"
printf "Files to edit:\n"
printf "  * %s\n" "$(bold "./.env")"
printf "      Set provider credentials. Walk through the file; entries are documented inline."
printf "\n"
printf "  * %s\n" "$(bold "./app/builtin_providers/<name>.yaml")"
printf "      Flip enabled: true for stripe / openai or any custom provider you add."
printf "\n"
printf "  * %s\n" "$(bold "./hosts.yaml")"
printf "      Add a CIDR for whichever host(s) your agent will connect from. The"
printf "\n      default already permits 127.0.0.1 for local testing."
printf "\n"
printf "Then:\n"
printf "  %s   restart proxy so env-var changes load (volume-mounted YAMLs reload live)\n" "$(bold "docker compose restart proxy")"
printf "\n"
printf "%s Groww and Upstox require a fixed source IP whitelisted on their developer\n" "$(bold "Heads up:")"
printf "  dashboard. If your install is on a public VPS, whitelist that VPS's IP.\n"
printf "  If you deployed to Cloudflare Workers, those two providers won't work —\n"
printf "  use the Docker / VPS path for them. See the Limitations section in README.\n"
printf "\n"

# ── Optional: interactive provider setup ────────────────────────────────────
if [ -t 1 ]; then
  _YELLOW='\033[0;33m'
else
  _YELLOW=''
fi
yellow() { printf "${_YELLOW}%s${_RESET}" "$*"; }

printf "Configure providers interactively now? [y/N]: "
read -r _WIZ_CHOICE
case "${_WIZ_CHOICE:-N}" in
  [Yy]*)
    _CONFIGURED_PROVIDERS=""

    for _PROV in groww upstox stripe openai; do
      printf "\n--- %s ---\n" "$(bold "$_PROV")"

      case "$_PROV" in
        groww)
          printf "  Indian stockbroker; uses API key + secret (approval flow by default).\n"
          printf "  Dashboard: https://groww.in/user/profile/trading-apis\n"
          printf "  %s\n" "$(yellow "IMPORTANT: requires you to click \"Approve\" on the Groww dashboard once per day before tokens can be minted; also requires whitelisting your install's source IP.")"
          _DEFAULT_ON="Y"
          _PROV_VARS="GROWW_API_KEY GROWW_API_SECRET"
          ;;
        upstox)
          printf "  Indian stockbroker; uses operator-supplied OAuth access token (refreshed daily ~3:30 AM IST).\n"
          printf "  Dashboard: https://account.upstox.com/developer/apps\n"
          printf "  %s\n" "$(yellow "IMPORTANT: you must complete Upstox's OAuth flow daily and paste the resulting access token here; also requires source-IP whitelisting in the app config.")"
          _DEFAULT_ON="Y"
          _PROV_VARS="UPSTOX_ACCESS_TOKEN"
          ;;
        stripe)
          printf "  Stripe payments API; transparent mode (every path forwarded).\n"
          printf "  Dashboard: https://dashboard.stripe.com/apikeys\n"
          printf "  %s\n" "$(yellow "IMPORTANT: use a test-mode key (sk_test_...) for first try.")"
          _DEFAULT_ON="N"
          _PROV_VARS="STRIPE_SECRET_KEY"
          ;;
        openai)
          printf "  OpenAI API; transparent mode (every path forwarded).\n"
          printf "  Dashboard: https://platform.openai.com/api-keys\n"
          printf "  %s\n" "$(yellow "IMPORTANT: use a project-scoped key with the narrowest scopes you can — Outpost only proxies what the agent asks for.")"
          _DEFAULT_ON="N"
          _PROV_VARS="OPENAI_API_KEY"
          ;;
      esac

      if [ "$_DEFAULT_ON" = "Y" ]; then
        printf "Enable %s? [Y/n]: " "$_PROV"
      else
        printf "Enable %s? [y/N]: " "$_PROV"
      fi
      read -r _EN_CHOICE
      _EN_CHOICE="${_EN_CHOICE:-$_DEFAULT_ON}"

      case "$_EN_CHOICE" in
        [Yy]*) : ;;
        *)     printf "  Skipping %s.\n" "$_PROV"; continue ;;
      esac

      # Flip enabled: false → true for providers that ship disabled
      case "$_PROV" in
        stripe|openai)
          _YAML="app/builtin_providers/${_PROV}.yaml"
          if grep -q '^enabled: true' "$_YAML" 2>/dev/null; then
            printf "  %s already enabled in YAML.\n" "$_PROV"
          else
            sed -i 's|^enabled: false|enabled: true|' "$_YAML"
            printf "  %s\n" "$(green "Flipped ${_YAML}: enabled: false → enabled: true")"
          fi
          ;;
      esac

      # Collect credentials
      for _VAR in $_PROV_VARS; do
        _ATTEMPTS=0
        while true; do
          # Show masked existing value and offer to skip replacement
          _EXISTING=""
          if grep -qE "^${_VAR}=.+" .env 2>/dev/null; then
            _EXISTING=$(grep -E "^${_VAR}=" .env | head -1 | cut -d= -f2-)
            _MASKED="${_EXISTING:0:4}$(printf '%0.s*' $(seq 1 $((${#_EXISTING} - 4))))"
            printf "  %s is already set (%s). Replace? [y/N]: " "$_VAR" "$_MASKED"
            read -r _REPL
            case "${_REPL:-N}" in
              [Yy]*) : ;;
              *)     printf "  Keeping existing %s.\n" "$_VAR"; break ;;
            esac
          fi

          # Determine if silent read is needed
          case "$_VAR" in
            *SECRET*|*TOKEN*|*KEY*|*PASS*)
              printf "  %s (paste from dashboard — input hidden): " "$_VAR"
              read -rs _VAL
              printf "\n"
              ;;
            *)
              printf "  %s (paste from dashboard): " "$_VAR"
              read -r _VAL
              ;;
          esac

          if [ -z "$_VAL" ]; then
            _ATTEMPTS=$((_ATTEMPTS + 1))
            if [ "$_ATTEMPTS" -ge 3 ]; then
              printf "  %s\n" "$(yellow "3 empty attempts — skipping ${_VAR}. Proxy will return PROXY_AUTH_ERROR until set.")"
              break
            fi
            printf "  %s\n" "$(red "Value cannot be empty (attempt ${_ATTEMPTS}/3). Type \"skip\" to abort.")"
            continue
          fi

          if [ "$_VAL" = "skip" ]; then
            printf "  %s\n" "$(yellow "Skipping ${_VAR}. Proxy will return PROXY_AUTH_ERROR until set.")"
            break
          fi

          # Escape special chars for sed (using | as delimiter, escape | / & \)
          _ESCAPED=$(printf '%s' "$_VAL" | sed -e 's/[\\]/\\\\/g' -e 's/[|]/\\|/g' -e 's/[&]/\\&/g')
          if grep -qE "^${_VAR}=" .env 2>/dev/null; then
            sed -i "s|^${_VAR}=.*|${_VAR}=${_ESCAPED}|" .env
          else
            printf '%s=%s\n' "$_VAR" "$_VAL" >> .env
          fi
          printf "  %s\n" "$(green "Saved ${_VAR} to .env")"
          break
        done
      done

      # Track configured providers
      if [ -z "$_CONFIGURED_PROVIDERS" ]; then
        _CONFIGURED_PROVIDERS="$_PROV"
      else
        _CONFIGURED_PROVIDERS="${_CONFIGURED_PROVIDERS}, ${_PROV}"
      fi
    done

    if [ -n "$_CONFIGURED_PROVIDERS" ]; then
      printf "\n"
      printf "%s Configured providers: %s\n" "$(green "✓")" "$_CONFIGURED_PROVIDERS"
      printf "  Restarting proxy to apply credential changes...\n"
      docker compose restart proxy

      # Re-wait for healthz
      printf "  Waiting for proxy to become healthy again"
      _WIZ_ATTEMPT=0
      _WIZ_READY=0
      while [ "$_WIZ_ATTEMPT" -lt 30 ]; do
        if $_HTTP_GET "$HEALTHZ_URL" >/dev/null 2>&1; then
          _WIZ_READY=1
          break
        fi
        printf "."
        sleep 1
        _WIZ_ATTEMPT=$((_WIZ_ATTEMPT + 1))
      done
      printf "\n"
      if [ "$_WIZ_READY" = "1" ]; then
        printf "  %s\n" "$(green "Restart triggered; proxy is healthy again.")"
      else
        printf "  %s\n" "$(yellow "Proxy did not respond in 30 s — check: docker compose logs proxy")"
      fi
    else
      printf "\nNo providers were configured. Returning to summary.\n"
    fi
    ;;
  *)
    printf "  Skipping interactive setup. Edit %s and %s manually.\n" \
      "$(bold "./.env")" "$(bold "./app/builtin_providers/<name>.yaml")"
    ;;
esac
printf "\n"

# ── Lifecycle commands ──────────────────────────────────────────────────────
printf "%s\n" "$(bold "Day-2 operations")"
printf "  make logs        tail live proxy logs\n"
printf "  make status      container status + health check\n"
printf "  make update      pull latest images and restart\n"
printf "  make backup      snapshot Redis + config to ./backups/\n"
printf "  make restore BACKUP=<path>   restore from a backup tarball\n"
printf "\n"

# ── First request hint ──────────────────────────────────────────────────────
printf "%s\n" "$(bold "Try it")"
printf "  curl -H \"X-Provider: groww\" %s/v1/holdings/user\n" "$ENDPOINT"
printf "  curl -H \"X-Provider: upstox\" %s/v2/portfolio/long-term-holdings\n" "$ENDPOINT"
printf "\n"
printf "  (Both require credentials in .env. Without them you'll get a clear\n"
printf "   PROXY_AUTH_ERROR explaining what env var is missing.)\n"
printf "\n"
