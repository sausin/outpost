# Manual install & local development

The [README](../README.md) covers the recommended one-command install via
`make install` / `curl … | bash`. This file documents the lower-level paths
for operators who prefer to wire things up themselves or for contributors
hacking on the code.

## Manual Docker install (no installer wizard)

If you've cloned the repo and want to skip the interactive installer:

```bash
cp .env.example .env       # fill in credentials for the providers you want
docker compose up -d       # internal mode, binds :8080 on the host
curl -H "X-Provider: groww" http://localhost:8080/v1/holdings
```

This is the same stack the installer's "internal mode" produces, minus the
guided prompts. Equivalent to picking option 1 in `make install`.

To enable public-internet mode with Caddy + auto-HTTPS manually:

```bash
echo "DOMAIN=outpost.example.com"        >> .env
echo "ACME_EMAIL=ops@example.com"        >> .env
echo "OUTPOST_MODE=public"               >> .env
docker compose -f docker-compose.yml -f docker-compose.public.yml up -d
```

Caddy will provision a Let's Encrypt certificate automatically on first
request. DNS for `DOMAIN` must point at the host before the cert can be
issued.

## Local development without Docker

Outpost is a regular Python project managed by [uv](https://docs.astral.sh/uv/).
You need Redis running somewhere (`brew install redis` / `apt install redis`
/ or just `docker run -p 6379:6379 redis:7-alpine`).

```bash
uv sync                                              # install runtime + dev deps from uv.lock
cp .env.example .env
uv run uvicorn app.python.main:app --host 0.0.0.0 --port 8080 --workers 2
```

The `uv sync` step also installs the dev tools (ruff, pyright, pytest).

## Lint, format, type-check

```bash
uv run ruff check app/ outpost_cli/      # static lint
uv run ruff format app/ outpost_cli/     # apply formatting
uv run pyright app/ outpost_cli/         # type-check
```

CI should run all three with `--check` / no-fix flags as appropriate.

## Building the Docker image directly

```bash
docker build -t outpost:dev .
docker run --rm -p 8080:8080 --env-file .env outpost:dev
```

The build uses BuildKit and a uv cache mount — first build pulls wheels,
subsequent rebuilds with only source changes finish in seconds.

## Inspecting the running stack

```bash
docker compose ps                    # container status
docker compose logs -f proxy         # tail proxy logs
docker compose exec redis redis-cli  # interactive redis shell
```

Useful Redis keys to inspect:
- `groww:token`, `upstox:token` — cached upstream access tokens
- `cache:<provider>:<method>:<path>:<qhash>` — response cache entries
- `idem:<provider>:<idempotency-key>` — idempotency cache
- `rl:<provider>:<category>:<window_ms>` — rate-limit bucket state
- `rl:cooldown:<provider>:<category>` — upstream-429 cool-down marker

## Switching auth flows for a provider

Each provider's YAML in `app/builtin_providers/` contains the active auth
block plus commented alternatives. For example, `groww.yaml` defaults to
the API-key + secret checksum flow, with TOTP and manual-access-token
alternatives commented inline. Switch by uncommenting the desired block
and commenting the others, then restart the proxy.

## Generating a new provider YAML interactively

```bash
uv sync --extra cli
uv run outpost add-provider
```

The wizard walks through basics, auth, forwarding mode, rate limits, and
default headers — see the README's "Adding a provider" section.

## Resetting state

To wipe all cached tokens / rate-limit state / idempotency keys:

```bash
docker compose exec redis redis-cli FLUSHDB
```

The proxy will re-mint tokens on the next request. Do not do this in
production during active trading hours — outstanding idempotency keys
will be lost.
