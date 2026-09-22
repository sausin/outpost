/**
 * Node.js entrypoint.
 *
 * Constructs Redis-backed storage, seeds the config volume on first boot, loads
 * providers from the providers directory, reads hosts.yaml, builds AppDeps,
 * mounts the Hono app, and serves over HTTP. With OUTPOST_CONFIG_WATCH on (the
 * default) it then keeps watching the config files and swaps in a fresh
 * AppDeps whenever they change — no restart needed after editing a YAML.
 *
 * Boot is deliberately forgiving: a missing provider, an unreachable Redis or
 * a read-only config mount all degrade to a running proxy that reports itself
 * healthy on /healthz. App catalogs mark a deploy failed when the container
 * never goes healthy, and "no credentials configured yet" is the normal state
 * of a freshly installed Outpost — not a failure. The one fatal case at boot
 * is a hosts.yaml that cannot be applied (parse error, or a PSK env var it
 * names is unset): silently running with the wrong access policy is worse than
 * not running. On a *reload* the same failure keeps the previous policy and is
 * reported on the dashboard instead.
 */

import { readFile } from "node:fs/promises";

import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";

import { buildAppDeps } from "../bootstrap.ts";
import { seedConfig } from "../config/seed.ts";
import { watchConfig } from "../config/watch.ts";
import { makeNodeClientIpResolver } from "../core/client_ip.ts";
import { envFlag, envFromNode, parseTrustedProxies } from "../core/env.ts";
import type { ConfigProblem } from "../core/types.ts";
import { buildApp } from "../index.ts";
import type { AppDeps } from "../index.ts";
import { makeFilePluginLoader } from "../plugins/file_loader.ts";
import { loadProvidersFromDir } from "../providers/loader.ts";
import type { StatusSource, StorageHealth } from "../status.ts";
import { RedisCache } from "../storage/cache_redis.ts";
import { RedisRateLimit } from "../storage/rate_limit_redis.ts";
import { createRedisClient, RedisStorage } from "../storage/redis.ts";

/** Strip credentials from a connection URL before it reaches a log or page. */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = "***";
    return u.toString();
  } catch {
    return "(unparseable url)";
  }
}

async function main(): Promise<void> {
  const env = envFromNode();
  const startedAt = Date.now();
  const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379/0";
  const redis = createRedisClient(redisUrl);

  // ioredis emits 'error' on every failed reconnect attempt. Unhandled, those
  // are fatal to the process; handled, the client keeps retrying in the
  // background while the proxy stays up and answers /healthz.  Throttled to
  // one line a minute — a Redis that stays down would otherwise produce a few
  // thousand identical lines an hour and bury everything else.
  let lastRedisErrorLog = 0;
  redis.on("error", (err: Error) => {
    const now = Date.now();
    if (now - lastRedisErrorLog < 60_000) return;
    lastRedisErrorLog = now;
    console.warn(
      `[node] Redis (${redactUrl(redisUrl)}) not reachable — retrying in the background: ${err.message}`,
    );
  });

  const tokenStorage = new RedisStorage(redis);
  const cache = new RedisCache(redis);
  const rateLimits = new RedisRateLimit(redis);

  await seedConfig({
    providersDir: env.PROVIDERS_DIR,
    hostsFile: env.HOSTS_CONFIG_PATH,
    pluginsDir: env.PLUGINS_DIR,
  });

  // `type: plugin` references the bundle does not know are imported from the
  // plugins directory at runtime — the escape hatch for the container image.
  const loadPlugin = makeFilePluginLoader({ dir: env.PLUGINS_DIR });

  const resolveClientIp = makeNodeClientIpResolver({
    env,
    socketAddress: (c) => getConnInfo(c).remote.address,
  });

  const dashboard = envFlag(env.DASHBOARD);
  const watch = envFlag(env.CONFIG_WATCH);

  // ── Status page inputs ────────────────────────────────────────────────────
  const storageHealth = async (): Promise<StorageHealth> => {
    const t0 = Date.now();
    try {
      await Promise.race([
        redis.ping(),
        new Promise<never>((_, reject) => {
          const t = setTimeout(
            () => reject(new Error("no reply within 1000 ms")),
            1000,
          );
          t.unref();
        }),
      ]);
      return { ok: true, detail: `Redis PONG in ${Date.now() - t0} ms` };
    } catch (err) {
      return {
        ok: false,
        detail: `Redis at ${redactUrl(redisUrl)}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  };

  const status: StatusSource = {
    version: env.VERSION,
    runtime: "node",
    startedAt,
    config: {
      providersDir: env.PROVIDERS_DIR,
      hostsFile: env.HOSTS_CONFIG_PATH,
      pluginsDir: env.PLUGINS_DIR,
      watch,
      reloads: 0,
      problems: [],
    },
    trustedProxies: parseTrustedProxies(env.TRUSTED_PROXIES),
    disabledProviders: [],
    credentialSet: (name) => {
      const v = process.env[name];
      return typeof v === "string" && v.length > 0;
    },
    storage: storageHealth,
  };

  // ── Config (re)loading ────────────────────────────────────────────────────
  interface Loaded {
    deps: AppDeps;
    problems: ConfigProblem[];
    disabled: Array<{ name: string; source: string }>;
  }

  const load = async (): Promise<Loaded> => {
    const loaded = await loadProvidersFromDir(env.PROVIDERS_DIR);
    const problems: ConfigProblem[] = [...loaded.problems];

    let hostsYaml = "hosts: []";
    try {
      hostsYaml = await readFile(env.HOSTS_CONFIG_PATH, "utf8");
    } catch (err) {
      const message = `hosts.yaml at ${env.HOSTS_CONFIG_PATH} not readable — defaulting to empty policy (every request will 403): ${err instanceof Error ? err.message : String(err)}`;
      console.warn(`[node] ${message}`);
      problems.push({
        scope: "hosts",
        source: env.HOSTS_CONFIG_PATH,
        message,
      });
    }

    const deps = await buildAppDeps({
      env,
      defs: loaded.providers,
      hostsYaml,
      tokenStorage,
      cache,
      rateLimits,
      resolveClientIp,
      loadPlugin,
    });
    return { deps, problems, disabled: loaded.disabled };
  };

  let current: AppDeps;
  const apply = (loaded: Loaded): void => {
    current = { ...loaded.deps, status, dashboard };
    status.config!.loadedAt = Date.now();
    status.config!.problems = loaded.problems;
    status.disabledProviders = loaded.disabled;
  };

  // First load: a hosts.yaml that cannot be applied is fatal (see header).
  apply(await load());

  const app = buildApp(() => current);

  if (watch) {
    watchConfig({
      providersDir: env.PROVIDERS_DIR,
      hostsFile: env.HOSTS_CONFIG_PATH,
      pluginsDir: env.PLUGINS_DIR,
      onChange: async () => {
        try {
          const loaded = await load();
          apply(loaded);
          status.config!.reloads = (status.config!.reloads ?? 0) + 1;
          const names = [...loaded.deps.providers.keys()].sort();
          console.info(
            `[config] Reloaded — providers: ${names.join(", ") || "(none)"}; hosts: ${loaded.deps.hosts.describe().length}; problems: ${loaded.problems.length + (loaded.deps.problems?.length ?? 0)}`,
          );
        } catch (err) {
          // Typically hosts.yaml: parse error or a PSK env var it names is
          // unset. The previous policy stays in force; the dashboard says why.
          const message = err instanceof Error ? err.message : String(err);
          console.error(
            `[config] Reload failed — keeping the previous configuration: ${message}`,
          );
          status.config!.problems = [
            {
              scope: "config",
              message: `Reload failed; running with the previous configuration until this is fixed: ${message}`,
            },
          ];
        }
      },
    });
  }

  const port = Number(env.PROXY_PORT);
  const hostname = env.BIND_ADDRESS;

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `Outpost ${env.VERSION} (Node) listening on http://${hostname}:${info.port} — providers: ${[...current.providers.keys()].join(", ") || "(none)"}` +
        (dashboard ? ` — dashboard at /dashboard` : "") +
        (watch ? ` — config reloads on change` : ""),
    );
  });
}

main().catch((err) => {
  console.error(`[node] Fatal: ${err}`);
  process.exit(1);
});
