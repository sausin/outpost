# Outpost

> **The edge sidecar for AI agents.** Put any REST API behind a hardened
> proxy with **3 lines of YAML** — auth injection, rate limits, response
> caching, idempotency, and host-based access control. The agent never
> touches a secret.

<p>
  <a href="https://github.com/sausin/outpost/actions/workflows/ci.yml"><img src="https://github.com/sausin/outpost/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/sausin/outpost/releases"><img src="https://img.shields.io/github/v/release/sausin/outpost?include_prereleases&sort=semver" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="License: MIT"></a>
  <a href="https://github.com/sausin/outpost/blob/main/CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs welcome"></a>
</p>

<p>
  <a href="https://github.com/sausin/outpost/pkgs/container/outpost-python"><img src="https://img.shields.io/badge/ghcr.io-sausin%2Foutpost--python-3776AB?logo=docker&logoColor=white" alt="GHCR: Python image"></a>
  <a href="https://github.com/sausin/outpost/pkgs/container/outpost-ts"><img src="https://img.shields.io/badge/ghcr.io-sausin%2Foutpost--ts-F7DF1E?logo=docker&logoColor=black" alt="GHCR: TypeScript image"></a>
  <img src="https://img.shields.io/badge/python-3.12+-3776AB?logo=python&logoColor=white" alt="Python 3.12+">
  <img src="https://img.shields.io/badge/node-22+-339933?logo=node.js&logoColor=white" alt="Node 22+">
  <img src="https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white" alt="Runs on Cloudflare Workers">
</p>

> **Two runtimes, one YAML.** Outpost ships in two implementations from the same
> repo: a **Python** runtime (FastAPI + Redis, mature, full plugin escape hatch)
> and a **TypeScript** runtime (Hono + Redis/KV, deployable to Node *and*
> Cloudflare Workers). Same provider YAMLs, same forwarding rules, same auth
> modules, same security model. Pick whichever fits your deploy target.

---

## Why Outpost

Every AI agent needs API keys — Stripe, OpenAI, Anthropic, brokerage tokens,
internal service credentials. Today those keys sit in the agent's environment
or worse, its prompt context. One prompt injection, one log leak, one stack
trace shipped to a SaaS error tracker, and they're gone.

**Outpost holds the keys for you.** Your agent makes plain HTTP calls to
`localhost`. The sidecar:

- **Injects the right auth header** from a vetted secret store
- **Allowlists or denies paths** declaratively, per upstream
- **Shapes rate limits** to match what each upstream actually publishes
- **Caches responses** with per-endpoint TTLs you control
- **Gates "sensitive" calls** (writes, trades, deletes) behind a source-IP policy
- **Honors upstream 429s** with cooldowns across all workers

The agent never sees a token, can't reach an endpoint you haven't allowed,
and is rate-limit-shaped before it ever touches the upstream.

## The 3-line provider

```yaml
# stripe.yaml
name: stripe
base_url: https://api.stripe.com
auth: {type: bearer_static, env: STRIPE_SECRET_KEY}
```

Drop it in `app/builtin_providers/`, restart, and:

```bash
curl -H "X-Provider: stripe" http://localhost:8080/v1/customers
# → forwards to api.stripe.com/v1/customers with Authorization: Bearer $STRIPE_SECRET_KEY
```

That's the whole interaction model. Same path on the proxy, same path on
the upstream, auth handled. **The same YAML works on both runtimes** —
Python and TypeScript read the identical schema, dispatch the identical
auth modules, and produce the identical request to the upstream.

## Install in one command

```bash
curl -fsSL https://raw.githubusercontent.com/sausin/outpost/main/scripts/install.sh | bash
```

Or from a clone:

```bash
git clone https://github.com/sausin/outpost.git
cd outpost && make install
```

The installer asks **three** questions:

| Question | Choices |
|---|---|
| **Which runtime?** | `python` (default — mature, all features) or `ts` (Workers-compatible, also runs on Node) |
| **How will it be reached?** | `internal` (sidecar mode, `localhost:8080`, no TLS) or `public` (Caddy + Let's Encrypt auto-HTTPS) |
| **Provider acknowledgement** | confirms you'll set provider credentials in `.env` after install |

After install:

```bash
make status         # container status + health check
make logs           # tail live proxy logs
make update         # pull latest images and restart
make backup         # snapshot Redis + config to ./backups/
make restore BACKUP=./backups/outpost-<ts>.tar.gz
```

> **Manual install or hacking on the code?** See [`docs/MANUAL.md`](docs/MANUAL.md).

### Editing config without rebuilding

Both `hosts.yaml` and `app/builtin_providers/*.yaml` are **mounted from your
host at `/etc/outpost/hosts.yaml` and `/etc/outpost/providers/`**. Edit a
provider's `enabled:` flag, switch a Groww auth flow, tweak an allowlist,
add a new PSK to a host entry — all without an image rebuild:

```bash
$EDITOR app/builtin_providers/groww.yaml   # uncomment the flow you want
$EDITOR hosts.yaml                          # add auth_token_env to a host
docker compose restart proxy                # picks up the changes
```

The image bakes the same files in as fallbacks, so a raw `docker run`
without these mounts still boots with sensible defaults.

## Pull an image directly

```bash
# Python runtime (mature, full plugin escape hatch via Python classes)
docker pull ghcr.io/sausin/outpost-python:latest

# TypeScript runtime (also runs on Cloudflare Workers — see below)
docker pull ghcr.io/sausin/outpost-ts:latest
```

Both multi-arch (`linux/amd64`, `linux/arm64`). Both tagged with `latest`,
`v0.1`, `v0.1.0`, etc. Pick whichever language/runtime fits your stack —
the YAML config is identical.

## Deploy to Cloudflare Workers

The TypeScript runtime targets Workers natively. Once your KV namespaces
exist, deploy in one command:

```bash
cd app/ts
wrangler kv namespace create TOKENS
wrangler kv namespace create RATE_LIMIT
wrangler kv namespace create CACHE
# Paste returned IDs into wrangler.toml, then:
wrangler secret put STRIPE_SECRET_KEY    # repeat for each provider's credentials
wrangler deploy
```

Local development uses miniflare-simulated KV — no Cloudflare account needed:

```bash
cd app/ts
cp .dev.vars.example .dev.vars   # fill in test credentials
npm install
npx wrangler dev                 # http://localhost:8788
```

The Workers tier is free up to 100k requests/day, $5/mo above that.

## What ships with it

### 10 built-in auth modules

| Type | When to use |
|---|---|
| `none` | Public APIs |
| `bearer_static` | Long-lived API keys (Stripe, OpenAI, Anthropic) |
| `bearer_redis` | Operator-rotated tokens (OAuth flows, daily refreshes) |
| `api_key_header` | `X-API-Key`-style headers, any name |
| `api_key_query` | Legacy APIs with `?api_key=…` |
| `basic_auth` | `Authorization: Basic` (Twilio, SendGrid) |
| `hmac_signed` | HMAC-signed requests (Binance, Coinbase) |
| `oauth2_client_credentials` | Auto-mint + refresh OAuth tokens |
| `custom_headers` | Multi-header schemes |
| `plugin` | Drop-in Python class for anything exotic (TOTP, SigV4, …) |

### 4 vendored providers, more in PRs

| File | Upstream | Auth flow |
|---|---|---|
| `groww.yaml` | Groww Trading API (India) | Key + secret checksum mint *(plugin)* |
| `upstox.yaml` | Upstox API v2/v3 (India) | Operator-supplied OAuth token via `bearer_redis` |
| `stripe.yaml` | Stripe payments | `bearer_static` *(example, disabled by default)* |
| `openai.yaml` | OpenAI | `bearer_static` *(example, disabled by default)* |

### Two forwarding modes

- **Transparent** *(default)* — forward every request. All writes
  (POST / PUT / DELETE / PATCH) are flagged sensitive automatically.
  A single rate-limit bucket applies.
- **Allowlist** — only paths in the `allow:` block are forwarded; everything
  else is 404. Per-path category, cache TTL, sensitivity flag. This is what
  you want in front of a trading API.

## Security model

| Control | Where it lives |
|---|---|
| **Source-IP allowlist** | `hosts.yaml` — CIDR-mapped host policies; unknown IPs get 403 |
| **Per-host pre-shared key** | `auth_token_env: NAME` in `hosts.yaml`; agents send `X-Outpost-Auth: <token>`; mismatch → 401. Constant-time compare; opt-in per host (omit the field for trusted networks like localhost) |
| **`sensitive: true` gate** | Only hosts with `can_call_sensitive: true` may call sensitive endpoints |
| **Path deny list** | `forwarding.deny: [...]` — checked before allow rules |
| **Auth secrets** | Env / Redis / Workers KV — never seen by the agent |
| **Cooldown on upstream 429** | Redis-tracked across all workers — no thundering-herd retries |
| **Byte-transparent forwarding** | Upstream `Content-Type` and raw response bytes preserved end-to-end; the proxy isn't JSON-coerced. Binary, CSV, SSE-style responses pass through verbatim |
| **`X-Outpost-Auth` stripped before forwarding** | The PSK never leaks to the upstream API |
| **Container hardening** | Runs as UID 10001 (non-root), pinned outside SYS_UID range; runs `tini` as PID 1; ~32 MB Python / ~45 MB TS image, no compilers in the runtime layer |

### Defense-in-depth recipe for internet-facing deploys

1. **TLS at the edge** — `make install` with the Public mode picks up Caddy + Let's Encrypt automatically.
2. **Tighten `TRUSTED_PROXIES`** to your Caddy/load-balancer CIDR so `X-Forwarded-For` is only honored from it.
3. **Set `auth_token_env`** on every host except `localhost-dev`. Generate tokens with `openssl rand -hex 32`. Rotate by changing one env var.
4. **`can_call_sensitive: true`** only for hosts that genuinely place writes/trades; everyone else stays read-only.
5. **Allowlist mode** in production provider YAMLs — transparent mode is for dev/experiments.

## Real-world examples

### Stripe (3 lines, transparent mode)

```yaml
name: stripe
base_url: https://api.stripe.com
auth: {type: bearer_static, env: STRIPE_SECRET_KEY}
```

### OpenAI

```yaml
name: openai
base_url: https://api.openai.com
auth: {type: bearer_static, env: OPENAI_API_KEY}
forwarding:
  rate_limits:
    default: [{capacity: 50, window_ms: 1000}, {capacity: 500, window_ms: 60000}]
```

### Anthropic with a custom version header

```yaml
name: anthropic
base_url: https://api.anthropic.com
default_headers:
  anthropic-version: "2023-06-01"
auth:
  type: api_key_header
  env: ANTHROPIC_API_KEY
  header: x-api-key
```

### Binance with HMAC-signed requests

```yaml
name: binance
base_url: https://api.binance.com
auth:
  type: hmac_signed
  key_env: BINANCE_API_KEY
  secret_env: BINANCE_API_SECRET
  key_header: X-MBX-APIKEY
  signature_param: signature
  timestamp_param: timestamp
  digest: sha256
  payload: query
```

### Groww with auto-minted access tokens (plugin)

```yaml
name: groww
base_url: https://api.groww.in
auth:
  type: plugin
  # Each runtime resolves its own implementation; one file, both worlds.
  module: app.python.plugins.groww_approval_mint:GrowwApprovalMintAuth
  module_ts: plugins/groww_approval_mint.ts:GrowwApprovalMintAuth
  config:
    api_key_env: GROWW_API_KEY
    api_secret_env: GROWW_API_SECRET
    mint_path: /v1/token/api/access
```

## Architecture

```
                     ┌──────────────────────────────────────┐
                     │              Outpost                 │
                     │                                      │
   agent ──IP──▶  ┌──┴──┐    ┌─────────┐                    │
   (localhost)    │ HTTP │──▶│ provider│──▶ api.upstream.com
                  └──┬──┘    │  router │                    │
                     │       └────┬────┘                    │
                     │            ▼                         │
                     │       ┌─────────┐                    │
                     │       │  Redis  │  (tokens, cache,   │
                     │       └─────────┘   rate-limit,      │
                     │                     idempotency)     │
                     └──────────────────────────────────────┘
```

Request flow: **broker resolve → host policy → route classify →
sensitive gate → idempotency cache → response cache → rate-limit
acquire → auth inject → forward → upstream 429 handling →
token rejection → cache persist → return**.

Every step is observable via `X-Proxy-Cache`, `X-Proxy-Provider`
response headers and structured stdout logs.

## Choosing a runtime

Both runtimes implement the same protocol and consume identical YAMLs.
Pick by deploy target and feature needs:

| | Python (`outpost-python`) | TypeScript (`outpost-ts`) |
|---|---|---|
| **Runs on** | Docker (Linux/macOS host) | Docker, Cloudflare Workers |
| **Web framework** | FastAPI | Hono |
| **Storage** | Redis + Lua (atomic) | Redis + Lua (Node) or KV-optimistic (Workers) |
| **Rate limiting** | atomic multi-window | atomic on Node, eventually-consistent on Workers |
| **Plugin escape hatch** | full — any Python class | restricted to `src/plugins/` subtree (Workers can't dynamic-import outside the bundle) |
| **Cold start** | ~500 ms (uvicorn) | ~5 ms (Workers), ~200 ms (Node) |
| **Image size** | 32 MB | 45 MB |
| **Test coverage** | mature | 121 vitest tests, 100% pass rate |
| **Pick this if** | self-host on a VPS; need exotic auth plugins | want Cloudflare Workers free-tier deploy; want one language across runtime + CLI |

## How it compares to alternatives

| | Outpost | Nginx / Squid | Kong / Tyk | MCP servers |
|---|---|---|---|---|
| Auth injection from secret store | yes | bolt-on | yes (paid) | n/a (different protocol) |
| Per-host source-IP policy | yes | basic ACLs | yes | n/a |
| Declarative YAML, drop-in | yes | no | admin API | yes (different format) |
| Multi-window rate buckets | yes | no | yes (paid) | no |
| Built for AI agent sidecar | yes | no | no | yes |
| Free Cloudflare Workers deploy | yes (TS) | no | no | no |
| Footprint | 32–45 MB Docker | 5–50 MB | 100+ MB | varies |
| HTTP-native passthrough | yes | yes | yes | no (JSON-RPC) |

## Management endpoints

| Endpoint | Description |
|---|---|
| `GET /healthz` | Liveness probe; returns the list of registered providers |
| `GET /providers` | Registered providers with their base URLs |
| `GET /openapi.json` | OpenAPI 3.1 spec, dynamically generated |
| `GET /docs` | Swagger UI |

## Response headers

| Header | Values |
|---|---|
| `X-Proxy-Provider` | Provider name that handled the request |
| `X-Proxy-Cache` | `HIT`, `MISS`, `BYPASS`, `IDEMPOTENT-HIT` |
| `Retry-After` | Set on every 429 (proxy queue or upstream cooldown) |

## Idempotency

Add `Idempotency-Key: <uuid>` to any POST. Identical requests within 24 h
return the cached response without hitting the upstream. Keys are
broker-scoped so collisions across providers can't happen.

## Adding your own provider

Two paths:

**1. Use the interactive wizard:**

```bash
uv sync --extra cli
uv run outpost add-provider
```

Walks you through basics → auth (10 module types) → forwarding mode →
rate limits → headers. Previews the YAML with syntax highlighting, only
writes after confirmation.

**2. Write the YAML by hand** — see any vendored provider as a template.
For an auth scheme not covered by the 10 built-ins, implement the
`AuthModule` protocol in ~50 lines (Python *or* TypeScript) and reference it:

```yaml
auth:
  type: plugin
  module: my_pkg.my_mod:MyAuth             # Python runtime
  module_ts: plugins/my_mod.ts:MyAuth      # TypeScript runtime (optional)
```

If you only target one runtime, you can omit the other path.

## Roadmap

- [x] Multi-broker proxy with X-Provider routing
- [x] 10 declarative auth modules + plugin escape hatch
- [x] Transparent vs allowlist forwarding modes
- [x] Multi-window rate limits with upstream-429 cooldown
- [x] ONCE-style install + lifecycle Make targets
- [x] Multi-arch GHCR images (Python + TypeScript)
- [x] Cloudflare Workers TypeScript runtime (same YAML, edge deploy, free tier)
- [x] 121 vitest tests on the TS runtime (100% pass)
- [ ] Workers Durable Objects rate-limit backend (atomic multi-window on paid tier)
- [ ] `outpost upstox-login` helper for the OAuth dance
- [ ] WebSocket forwarding for streaming market data
- [ ] Prometheus metrics endpoint
- [ ] Pluggable secret backends (Vault, AWS Secrets Manager)
- [ ] TypeScript port of the `outpost add-provider` wizard

## Contributing

PRs welcome. CI runs the bar for both runtimes — your PR has to pass them
both before merge:

**Python**

```bash
uv run ruff check app/python outpost_cli
uv run ruff format --check app/python outpost_cli
uv run pyright app/python outpost_cli
```

**TypeScript** (from `app/ts/`)

```bash
npx tsc --noEmit
npx prettier --check src/ tests/
npm test
```

When adding things:

- **New providers**: drop a YAML in `app/builtin_providers/` with `enabled: false`
  so users opt in; document the auth flow in a comment block at the top.
- **New auth modules**: implement in BOTH runtimes — `app/python/auth/modules/`
  (Python) and `app/ts/src/auth/modules/` (TS) — and register in each
  runtime's auth registry.
- **New plugins**: same story, both `app/python/plugins/` and `app/ts/src/plugins/`;
  reference both paths from the YAML via `module:` and `module_ts:`.

See [`docs/MANUAL.md`](docs/MANUAL.md) for the local dev workflow.

## License

[MIT](LICENSE) — do what you want, ship it, fork it, sell it. Attribution
appreciated, not required.

---

<p align="center">
  <i>Built because agents need a place to keep their keys that isn't their context window.</i>
</p>
