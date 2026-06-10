# Outpost — TypeScript runtime (Phase 1 scaffolding)

A TypeScript port of the [Outpost](../README.md) HTTP sidecar, targeting two runtimes from the same codebase:

- **Cloudflare Workers** via [Hono](https://hono.dev/)
- **Node.js** (Docker, `node:22-alpine`)

> **Status: Phase 1 — scaffolding only.** Types, interfaces, and utility stubs are wired up. The proxy logic (auth injection, rate-limiting, caching) arrives in Phases 2–5. For a working implementation, see the Python code in `../app/`.

## Quick start

### Cloudflare Workers (dev mode)

```bash
npm install
npm run dev        # wrangler dev — hot-reload on :8787
```

> If wrangler prompts for login, run `npx wrangler login` once.

### Node.js

```bash
npm install
npm run dev:node   # tsx src/adapter/node.ts — listens on $PROXY_PORT (default 8080)
```

### Type-check + lint

```bash
npm run typecheck       # tsc --noEmit
npm run format:check    # prettier --check src/
```

## Structure

```
src/
├── index.ts              # shared Hono app (Workers + Node mount this)
├── adapter/
│   ├── workers.ts        # Cloudflare Workers fetch handler
│   └── node.ts           # Node.js HTTP server bootstrap
├── core/
│   ├── types.ts          # AuthContext, AuthResult, RouteRule, ClassifiedRoute
│   ├── errors.ts         # error envelope + CODES
│   ├── pathmatch.ts      # glob → regex (mirrors app/core/pathmatch.py)
│   ├── hosts.ts          # HostResolver + HostPolicy (mirrors app/core/hosts.py)
│   └── env.ts            # env abstraction (process.env / Workers bindings)
├── providers/
│   ├── schema.ts         # zod schemas (mirrors app/providers/schema.py)
│   ├── loader.ts         # STUB: scan/load YAML providers
│   └── provider.ts       # STUB: GenericProvider class
└── auth/
    ├── types.ts          # AuthModule interface
    └── registry.ts       # STUB: resolve(typeName) → AuthModule
```

## Provider YAMLs

The canonical YAML files live in `../app/builtin_providers/`. The `builtin_providers/` path in this directory is a symlink pointing there, so both runtimes read from the same source:

- Workers: bundled at build time by wrangler/tsup
- Node: read from disk at runtime via the symlink

## Phase roadmap

| Phase | Scope |
|-------|-------|
| 1 | Scaffolding, types, stubs (this PR) |
| 2 | Proxy request pipeline (broker resolve → forward) |
| 3 | Auth modules (bearer\_static, bearer\_redis, …) |
| 4 | KV-backed rate-limiter, cache, idempotency |
| 5 | Workers deploy, Docker image, CI |
