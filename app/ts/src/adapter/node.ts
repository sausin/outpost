/**
 * Node.js entrypoint.
 *
 * Constructs Redis-backed storage, seeds the config volume on first boot, loads
 * providers from the providers directory, reads hosts.yaml, builds AppDeps,
 * mounts the Hono app, and serves over HTTP.
 *
 * Boot is deliberately forgiving: a missing provider, an unreachable Redis or
 * a read-only config mount all degrade to a running proxy that reports itself
 * healthy on /healthz. App catalogs mark a deploy failed when the container
 * never goes healthy, and "no credentials configured yet" is the normal state
 * of a freshly installed Outpost — not a failure.
 */

import { readFile } from "node:fs/promises";

import { serve } from "@hono/node-server";

import { buildAppDeps } from "../bootstrap.ts";
import { seedConfig } from "../config/seed.ts";
import { envFromNode } from "../core/env.ts";
import { buildApp } from "../index.ts";
import { loadProvidersFromDir } from "../providers/loader.ts";
import { RedisCache } from "../storage/cache_redis.ts";
import { RedisRateLimit } from "../storage/rate_limit_redis.ts";
import { createRedisClient, RedisStorage } from "../storage/redis.ts";

async function main(): Promise<void> {
  const env = envFromNode();
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
      `[node] Redis (${redisUrl}) not reachable — retrying in the background: ${err.message}`,
    );
  });

  const tokenStorage = new RedisStorage(redis);
  const cache = new RedisCache(redis);
  const rateLimits = new RedisRateLimit(redis);

  await seedConfig({
    providersDir: env.PROVIDERS_DIR,
    hostsFile: env.HOSTS_CONFIG_PATH,
  });

  const { providers: defs } = await loadProvidersFromDir(env.PROVIDERS_DIR);

  let hostsYaml = "hosts: []";
  try {
    hostsYaml = await readFile(env.HOSTS_CONFIG_PATH, "utf8");
  } catch (err) {
    console.warn(
      `[node] hosts.yaml at ${env.HOSTS_CONFIG_PATH} not readable — defaulting to empty policy (every request will 403): ${err}`,
    );
  }

  const deps = await buildAppDeps({
    env,
    defs,
    hostsYaml,
    tokenStorage,
    cache,
    rateLimits,
  });

  const app = buildApp(deps);
  const port = Number(env.PROXY_PORT);
  const hostname = env.BIND_ADDRESS;

  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(
      `Outpost (Node) listening on http://${hostname}:${info.port} — providers: ${[...deps.providers.keys()].join(", ") || "(none)"}`,
    );
  });
}

main().catch((err) => {
  console.error(`[node] Fatal: ${err}`);
  process.exit(1);
});
