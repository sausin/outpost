# syntax=docker/dockerfile:1.7
#
# Outpost — TypeScript / Node runtime image.
# Build from the REPO ROOT so we can bundle the shared builtin_providers/ YAMLs.
#
#   docker build -f app/ts/Dockerfile -t outpost-ts .
#
# Multi-stage: builder compiles TS to ESM JS via tsup, runtime is a minimal
# alpine image with only production deps + the bundled output.

# ─── Stage 1: build ────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /build

# Lockfile-first copy → dependency layer cached across source-only changes.
COPY app/ts/package.json app/ts/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --ignore-scripts

COPY app/ts/tsconfig.json ./
COPY app/ts/src ./src
RUN npx tsup src/adapter/node.ts \
      --format esm \
      --outDir dist \
      --out-extension .js \
      --dts false \
      --no-splitting

# Production-only dependencies into a clean node_modules we'll ship.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev

# ─── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:22-alpine

# tini → clean PID 1 signal handling.
# ca-certificates → TLS to upstream APIs.
# Pinned UID/GID 10001 so Kubernetes runAsNonRoot + runAsUser: 10001 work.
RUN apk add --no-cache tini ca-certificates && \
    addgroup -g 10001 outpost && \
    adduser -D -u 10001 -G outpost -h /app -s /sbin/nologin outpost

WORKDIR /app

COPY --from=builder --chown=outpost:outpost /build/dist ./dist
COPY --from=builder --chown=outpost:outpost /build/node_modules ./node_modules
COPY --from=builder --chown=outpost:outpost /build/package.json ./package.json

# Vendored YAML provider definitions — shared with the Python image.
COPY --chown=outpost:outpost app/builtin_providers ./builtin_providers

ENV NODE_ENV=production \
    PROVIDERS_DIR=/app/builtin_providers

USER outpost
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8080/healthz || exit 1

LABEL org.opencontainers.image.title="Outpost (TypeScript)" \
      org.opencontainers.image.description="The edge sidecar for AI agents — TypeScript/Node runtime, also deployable to Cloudflare Workers" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sausin/outpost" \
      org.opencontainers.image.documentation="https://github.com/sausin/outpost#readme"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/node.js"]
