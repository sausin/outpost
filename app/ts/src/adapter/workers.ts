/**
 * Cloudflare Workers entrypoint.
 *
 * Provider YAMLs and hosts.yaml are bundled at build time via wrangler's
 * `[[rules]] type = "Text"` rule (configured in wrangler.toml).  KV namespaces
 * for tokens / rate-limit state / response cache are bound from wrangler.toml.
 *
 * The full AppDeps is constructed lazily on first request and cached in
 * module-level state — Workers preserves module scope across requests within
 * the same isolate, so the bootstrap cost is paid once per cold start.
 */

import grokoYaml from "../../builtin_providers/groww.yaml";
import openaiYaml from "../../builtin_providers/openai.yaml";
import stripeYaml from "../../builtin_providers/stripe.yaml";
import upstoxYaml from "../../builtin_providers/upstox.yaml";
import hostsYaml from "../../hosts.yaml";

import { buildAppDeps } from "../bootstrap.ts";
import { envFromWorkers } from "../core/env.ts";
import { buildApp } from "../index.ts";
import type { AppDeps } from "../index.ts";
import { loadProvidersFromYamls } from "../providers/loader.ts";
import { KvCache } from "../storage/cache_kv.ts";
import { KvRateLimit } from "../storage/rate_limit_kv.ts";
import { KvStorage } from "../storage/kv.ts";

/**
 * Workers env bindings declared in wrangler.toml.
 * KV namespaces must be created before deploy (`wrangler kv namespace create …`).
 */
interface WorkerEnv {
  TOKENS: KVNamespace;
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
  DEFAULT_PROVIDER?: string;
  HOSTS_CONFIG_PATH?: string;
  PROVIDERS_DIR?: string;
  PROXY_PORT?: string;
  LOG_LEVEL?: string;
  // Provider credentials (STRIPE_SECRET_KEY, OPENAI_API_KEY, …) live here too.
  [key: string]: unknown;
}

// Module-level cache so bootstrap runs once per isolate cold-start.
let depsPromise: Promise<AppDeps> | null = null;

async function bootstrap(workerEnv: WorkerEnv): Promise<AppDeps> {
  const env = envFromWorkers(workerEnv);
  const tokenStorage = new KvStorage(workerEnv.TOKENS);
  const cache = new KvCache(workerEnv.CACHE);
  const rateLimits = new KvRateLimit(workerEnv.RATE_LIMIT);

  const { providers: defs } = await loadProvidersFromYamls([
    { name: "groww.yaml", content: grokoYaml },
    { name: "upstox.yaml", content: upstoxYaml },
    { name: "stripe.yaml", content: stripeYaml },
    { name: "openai.yaml", content: openaiYaml },
  ]);

  return buildAppDeps({
    env,
    defs,
    hostsYaml,
    tokenStorage,
    cache,
    rateLimits,
  });
}

export default {
  async fetch(
    request: Request,
    workerEnv: WorkerEnv,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (!depsPromise) {
      depsPromise = bootstrap(workerEnv);
    }
    const deps = await depsPromise;
    const app = buildApp(deps);
    return app.fetch(request, workerEnv, ctx);
  },
};
