# syntax=docker/dockerfile:1.7
#
# Multi-stage build using uv for fast, reproducible installs.
# Stage 1 builds a sealed /opt/venv with only runtime deps (no dev tools).
# Stage 2 is a minimal runtime image that copies the prepared venv.

# ─── Stage 1: build ────────────────────────────────────────────────────
FROM python:3.12-alpine AS builder

# uv ships musl-compatible static binaries; copy the binary out of the
# official image rather than installing via pip.
COPY --from=ghcr.io/astral-sh/uv:0.5.0 /uv /usr/local/bin/uv

# ca-certificates needed for TLS to PyPI / GitHub during dependency fetch.
RUN apk add --no-cache ca-certificates

WORKDIR /build

ENV UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    VIRTUAL_ENV=/opt/venv

# Bind-mount pyproject.toml + uv.lock (read-only, build-time only — never
# end up in any layer) and a persistent BuildKit cache for uv's wheel store.
# Rebuilds when only source changes hit the cache and finish in seconds.
# UV_PROJECT_ENVIRONMENT forces uv to populate /opt/venv (otherwise uv detects
# the project and silently creates a sibling .venv we'd never copy).
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-dev --no-install-project

# ─── Stage 2: runtime ──────────────────────────────────────────────────
FROM python:3.12-alpine

# tini → clean PID 1 signal handling.
# ca-certificates → TLS to any upstream API.
# Pinned UID/GID 10001 so Kubernetes runAsNonRoot + runAsUser: 10001 work
# without discovery; outside the SYS_UID range so it never collides with
# Alpine system accounts.
RUN apk add --no-cache tini ca-certificates && \
    addgroup -g 10001 app && \
    adduser -D -u 10001 -G app -h /app -s /sbin/nologin app

WORKDIR /app

# Copy the prepared virtualenv from the builder stage.
COPY --from=builder /opt/venv /opt/venv

ENV PATH="/opt/venv/bin:$PATH" \
    VIRTUAL_ENV=/opt/venv \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Application code + the vendored built-in provider YAMLs.
COPY --chown=app:app app ./app
COPY --chown=app:app hosts.yaml .

# Built-in YAMLs live at /app/app/builtin_providers; pin the path explicitly
# so the default (./builtin_providers, relative to WORKDIR) resolves correctly.
ENV PROVIDERS_DIR=/app/app/builtin_providers

USER app
EXPOSE 8080

# wget is provided by busybox in the alpine base — no extra package needed.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

# OCI image labels — shown on registry pages (GHCR, Docker Hub, etc.)
LABEL org.opencontainers.image.title="Outpost" \
      org.opencontainers.image.description="The edge sidecar for AI agents — auth-injecting HTTP proxy" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sausin/outpost" \
      org.opencontainers.image.documentation="https://github.com/sausin/outpost#readme"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["uvicorn", "app.python.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "2"]
