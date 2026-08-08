# Outpost on TrueNAS

Outpost is available in the **community train** of the TrueNAS Apps catalog. This
page covers what the app installs, how the installation form maps onto Outpost's
configuration, and how to add providers once it is running.

If you are not on TrueNAS, see the [README](../README.md) — everything here also
applies to any Docker host, the form fields are just environment variables and
bind mounts.

---

## What the app does

Outpost sits between your AI agents and the APIs they need to call. Agents send
their request to Outpost with an `X-Provider` header; Outpost attaches the
credential for that provider, enforces which paths and hosts are allowed,
rate-limits, caches, and forwards the call upstream.

The point is what does *not* happen: **the agent never sees the credential.** A
prompt-injected agent can only make the calls your provider YAML and host policy
permit, and it cannot exfiltrate a token it was never given.

The TrueNAS app deploys two containers:

| Container        | What it is                                                       |
| ---------------- | ---------------------------------------------------------------- |
| `outpost`        | The proxy itself (`ghcr.io/sausin/outpost-ts`, Node runtime)       |
| `outpost-redis`  | Sibling Valkey/Redis used for token storage, rate limits, caching |

A third short-lived container (`outpost-perms`) checks the permissions on the
config dataset before the app starts, and exits.

---

## Installation form → what it actually sets

### App Configuration

| Form field                           | Effect                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Redis Password**                   | Password for the sibling Redis. Outpost receives it as `REDIS_URL=redis://default:<password>@outpost-redis:6379`. |
| **Default Provider**                 | `OUTPOST_DEFAULT_PROVIDER`. Optional — when set, requests without an `X-Provider` header use it.      |
| **Additional Environment Variables** | Free-form `name`/`value` pairs. **This is where provider credentials go** (`GITHUB_TOKEN`, `STRIPE_SECRET_KEY`, …) and where you set the per-host PSKs referenced by `auth_token_env`. |

### User and Group

| Form field   | Effect                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| **User ID**  | `user:` in the generated compose. Defaults to `568` (the TrueNAS `apps` user). |
| **Group ID** | Same, for the group.                                                          |

Outpost runs correctly as any non-root uid:gid — it chowns nothing at startup
and writes nothing outside the config dataset and `/tmp`.

### Network

| Form field    | Effect                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| **Web Port**  | Published host port, and `OUTPOST_PORT` inside the container. Default `30099`.    |

Outpost binds `0.0.0.0` inside the container (`OUTPOST_BIND_ADDRESS`).

### Storage

| Form field            | Effect                                                                            |
| --------------------- | ----------------------------------------------------------------------------------- |
| **Outpost Config Storage** | Mounted at `/config`. Holds `hosts.yaml` and `providers/`. Defaults to an ixVolume dataset. |
| **Redis Data Storage**     | Mounted at `/data` in the Redis container.                                       |

Inside the container this maps to:

```
/config/hosts.yaml       ← OUTPOST_HOSTS_FILE
/config/providers/       ← OUTPOST_PROVIDERS_DIR
```

On first boot with an empty dataset, Outpost writes a commented starter
`hosts.yaml` (loopback only) and a disabled `providers/example.yaml` so there is
something to edit rather than an empty directory. Neither file is ever
overwritten afterwards.

---

## Every environment variable

| Variable                 | Default              | Purpose                                                  |
| ------------------------ | -------------------- | -------------------------------------------------------- |
| `OUTPOST_PORT`           | `8080`               | Listen port                                              |
| `OUTPOST_BIND_ADDRESS`   | `0.0.0.0`            | Listen address                                           |
| `OUTPOST_PROVIDERS_DIR`  | `/config/providers`  | Directory scanned for `*.yaml` / `*.yml` provider defs   |
| `OUTPOST_HOSTS_FILE`     | `/config/hosts.yaml` | Host access policy                                       |
| `OUTPOST_DEFAULT_PROVIDER` | *(unset)*          | Provider used when the request carries no `X-Provider`   |
| `OUTPOST_SEED_CONFIG`    | *(unset)*            | Set to `false` to disable first-boot config seeding      |
| `REDIS_URL`              | `redis://localhost:6379/0` | Redis connection string                            |
| `OUTPOST_LOG_LEVEL`      | `info`               | Log verbosity                                            |
| *provider credentials*   | —                    | Plain env vars named by your provider YAMLs              |

The pre-0.4 names `PROXY_PORT`, `PROXY_HOST`, `PROVIDERS_DIR`,
`HOSTS_CONFIG_PATH` and `DEFAULT_PROVIDER` are still read as fallbacks, so
existing deployments keep working. When both are set, the `OUTPOST_*` name wins.

---

## Adding a provider

1. **Get to the dataset.** The config dataset is at
   `/mnt/<pool>/ix-apps/app_mounts/outpost/config` (or wherever you pointed the
   Storage field). Reach it over SMB/NFS if you have shared it, or from
   **System → Shell**.

2. **Drop in a YAML.** A provider can be three lines:

   ```yaml
   name: github
   base_url: https://api.github.com
   auth: { type: bearer_static, env: GITHUB_TOKEN }
   ```

   Save it as `providers/github.yaml`. Every `*.yaml` in that directory is
   loaded; `enabled: false` skips one without deleting it.

3. **Set the credential.** In the TrueNAS UI: **Edit** the app → **Additional
   Environment Variables** → add `GITHUB_TOKEN` with your token as the value.

4. **Restart the app.** Provider YAMLs are read once at startup.

5. **Check it took.** The portal link opens Swagger UI at `/docs`; `GET
   /providers` lists everything that loaded. A provider whose credential is
   missing is logged and skipped — the proxy still starts with the rest.

Point your agent at `http://<truenas-ip>:<port>` and set `X-Provider: github` on
its requests. The path is forwarded verbatim, so
`GET /repos/foo/bar` becomes `GET https://api.github.com/repos/foo/bar` with the
`Authorization` header filled in.

See the [README](../README.md) for the full provider schema: allowlist mode,
per-route caching, rate-limit windows, OAuth2, HMAC signing and the rest.

---

## Security

**Read this before you expose the port to anything other than localhost.**

`hosts.yaml` is the access control list. An IP that matches no entry gets a
`403`, so the seeded loopback-only policy is safe by default — and useless as
soon as your agents run on another machine. When you widen it:

1. **Add a pre-shared key to every non-loopback host.** IP allowlisting alone is
   weak on a flat LAN (anything that can spoof or occupy an IP gets your
   credentials' capabilities). Give the host entry an `auth_token_env`:

   ```yaml
   hosts:
     - id: lan-agent
       cidrs: ["192.168.1.0/24"]
       can_call_sensitive: false
       auth_token_env: LAN_AGENT_TOKEN
   ```

   Generate the token with `openssl rand -hex 32`, set `LAN_AGENT_TOKEN` as an
   additional environment variable, and have the agent send it as
   `X-Outpost-Auth: <token>`. Outpost strips the header before forwarding.

2. **Use allowlist mode for those providers.** `forwarding.mode: allowlist`
   forwards only the routes you list, instead of everything the upstream
   exposes:

   ```yaml
   forwarding:
     mode: allowlist
     allow:
       - { method: GET, pattern: "/repos/**", cache_ttl: 60 }
       - { method: POST, pattern: "/repos/*/issues", sensitive: true }
   ```

3. **Keep `can_call_sensitive: false`** for every host that does not genuinely
   need to perform writes. Writes are treated as sensitive by default.

4. **Do not publish the port to the internet without TLS in front.** Put it
   behind a reverse proxy that terminates HTTPS — the PSK is a bearer token and
   travels in a header.

Credentials themselves live only in the app's environment variables, never in
the config dataset.

---

## Troubleshooting

**App deploys but shows unhealthy.** `/healthz` returns 200 as soon as the
process is up, including with zero providers configured, so an unhealthy app
means the process is not listening — check the container logs for a YAML parse
error in `hosts.yaml`, or a missing env var named by a host's `auth_token_env`
(that one is fatal by design).

**Provider missing from `/providers`.** Either `enabled: false`, or its auth
module failed to construct. The log line says which: `[bootstrap] Failed to
build provider 'x': ...` — almost always an unset credential env var.

**Agent gets `403 PROXY_HOST_DENIED`.** Its source IP does not match any CIDR in
`hosts.yaml`. Note that Outpost sees the container-network source address unless
you run a reverse proxy that sets `X-Forwarded-For`.

**Agent gets `401 PROXY_AUTH_REQUIRED`.** The matched host has an
`auth_token_env` and the request had no matching `X-Outpost-Auth` header.
