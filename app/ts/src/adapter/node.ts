/**
 * Node.js entrypoint.
 *
 * Constructs Redis-backed storage, loads providers from PROVIDERS_DIR on disk,
 * reads hosts.yaml, builds AppDeps, mounts the Hono app, and serves over HTTP.
 */

import { readFile } from "node:fs/promises";

import { serve } from "@hono/node-server";

import { buildAppDeps } from "../bootstrap.ts";
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

  const tokenStorage = new RedisStorage(redis);
  const cache = new RedisCache(redis);
  const rateLimits = new RedisRateLimit(redis);

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

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(
      `Outpost (Node) listening on http://localhost:${info.port} — providers: ${[...deps.providers.keys()].join(", ") || "(none)"}`,
    );
  });
}

main().catch((err) => {
  console.error(`[node] Fatal: ${err}`);
  process.exit(1);
});
