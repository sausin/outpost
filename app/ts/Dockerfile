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

# Do NOT pass --ignore-scripts here: esbuild (used by tsup, our bundler) ships
# its native binary via a postinstall script. Skip that and tsup fails at
# build-time with an unhelpful CJS loader stack trace. Build container is
# sealed, lockfile pins every dep — this is safe.
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY app/ts/tsconfig.json ./
COPY app/ts/src ./src

# workers.ts imports YAMLs via "../../builtin_providers/*.yaml" and
# "../../hosts.yaml" (relative to src/adapter/). Locally those paths
# resolve through symlinks in app/ts/; inside the build context they
# don't exist unless we drop the real files at /build/.  tsup walks the
# whole project graph (not just node.ts's import closure), so esbuild
# must be able to RESOLVE these files even though the Node bundle then
# tree-shakes them out — verified locally: zero YAML strings end up in
# dist/node.js.
COPY app/builtin_providers ./builtin_providers
COPY hosts.yaml ./hosts.yaml

# tsup 8.x: --format esm emits .js when package.json has type=module.
# --no-splitting keeps everything in one file; we don't generate .d.ts.
# --loader .yaml=text teaches esbuild how to handle workers.ts's YAML
# imports (text-bundling, mirrors wrangler's behavior).
# Two entrypoints — the server and the standalone container healthcheck —
# built in separate passes: tsup derives outDir structure from the common
# parent of its entrypoints, so bundling both at once would bury the server at
# dist/adapter/node.js. One entry per pass keeps dist/ flat.
RUN npx tsup src/adapter/node.ts \
      --format esm \
      --outDir dist \
      --target node22 \
      --no-splitting \
      --loader .yaml=text && \
    npx tsup src/healthcheck.ts \
      --format esm \
      --outDir dist \
      --target node22 \
      --no-splitting \
      --loader .yaml=text

# Production-only dependencies into a clean node_modules we'll ship.
# Runtime doesn't bundle anything, so --ignore-scripts is safe here.
RUN --mount=type=cache,target=/root/.npm \
    npm prune --omit=dev --ignore-scripts

# ─── Stage 2: runtime ──────────────────────────────────────────────────
FROM node:22-alpine

# tini → clean PID 1 signal handling.
# ca-certificates → TLS to upstream APIs.
# UID/GID 10001 is only the DEFAULT. The image runs correctly under any
# uid:gid the orchestrator picks (TrueNAS uses 568:568, OpenShift assigns a
# random high UID): nothing is chowned at startup, nothing outside the config
# volume and /tmp is written to, and every shipped file is world-readable.
RUN apk add --no-cache tini ca-certificates && \
    addgroup -g 10001 outpost && \
    adduser -D -u 10001 -G outpost -h /app -s /sbin/nologin outpost

WORKDIR /app

COPY --from=builder /build/dist ./dist
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/package.json ./package.json

# Reference copies of the vendored provider definitions and the upstream
# hosts.yaml. NOT loaded by default (the config volume at /config is), but
# handy to copy from: `docker cp`, or point OUTPOST_PROVIDERS_DIR here to run
# with the built-ins.
COPY app/builtin_providers /etc/outpost/providers
COPY hosts.yaml /etc/outpost/hosts.yaml

# Config volume. 0777 because the uid that will own the mounted dataset is not
# known at build time and we refuse to chown at startup — on any real deploy a
# volume is mounted over this and the host's permissions take over. Contents
# are config the operator writes, never secrets (those are env vars).
RUN mkdir -p /config/providers && \
    chmod -R 0777 /config && \
    chmod -R a+rX /app /etc/outpost

ENV NODE_ENV=production \
    OUTPOST_PORT=8080 \
    OUTPOST_BIND_ADDRESS=0.0.0.0 \
    OUTPOST_PROVIDERS_DIR=/config/providers \
    OUTPOST_HOSTS_FILE=/config/hosts.yaml

USER 10001:10001
EXPOSE 8080

# Built-in healthcheck: no curl/wget dependency, honours OUTPOST_PORT, and
# exits 0/1 off GET /healthz. App catalogs that run their own probe inside the
# container can invoke the same command: `node dist/healthcheck.js`.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "dist/healthcheck.js"]

LABEL org.opencontainers.image.title="Outpost (TypeScript)" \
      org.opencontainers.image.description="The edge sidecar for AI agents — TypeScript/Node runtime, also deployable to Cloudflare Workers" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/sausin/outpost" \
      org.opencontainers.image.documentation="https://github.com/sausin/outpost#readme"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/node.js"]
