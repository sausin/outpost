/**
 * Environment abstraction — same API for both runtimes:
 *   Workers: env bindings passed from the fetch handler
 *   Node:    process.env read at construction time
 *
 * Naming: the canonical knobs are `OUTPOST_*`-prefixed so they never collide
 * with an orchestrator's own vars (TrueNAS, Kubernetes and friends inject a
 * fair number of unprefixed names into every container). The pre-0.4 names
 * (`PROXY_PORT`, `PROVIDERS_DIR`, `HOSTS_CONFIG_PATH`) are still honoured as
 * fallbacks so existing deployments keep working untouched.
 */

export interface AppEnv {
  // String env vars
  DEFAULT_PROVIDER: string;
  PROVIDERS_DIR: string;
  HOSTS_CONFIG_PATH: string;
  PROXY_PORT: string;
  BIND_ADDRESS: string;
  LOG_LEVEL: string;

  // Workers: KV bindings; Node: undefined (Redis used instead in Phase 4)
  TOKENS?: KVNamespace;
  RATE_LIMIT?: KVNamespace;
  IDEMPOTENCY?: KVNamespace;

  // Free-form passthrough for provider credentials (STRIPE_SECRET_KEY, etc.)
  [key: string]: unknown;
}

/** First non-empty string among `names`, else `fallback`. */
function pick(
  source: Record<string, unknown>,
  names: string[],
  fallback: string,
): string {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

function build(source: Record<string, unknown>): AppEnv {
  return {
    // Spread FIRST so the resolved fields below always win: a legacy
    // `PROVIDERS_DIR` left over in the environment must not shadow the
    // `OUTPOST_PROVIDERS_DIR` that took precedence during resolution.
    ...source,

    DEFAULT_PROVIDER: pick(source, ["OUTPOST_DEFAULT_PROVIDER", "DEFAULT_PROVIDER"], ""), // prettier-ignore
    PROVIDERS_DIR: pick(source, ["OUTPOST_PROVIDERS_DIR", "PROVIDERS_DIR"], "./builtin_providers"), // prettier-ignore
    HOSTS_CONFIG_PATH: pick(source, ["OUTPOST_HOSTS_FILE", "HOSTS_CONFIG_PATH"], "./hosts.yaml"), // prettier-ignore
    PROXY_PORT: pick(source, ["OUTPOST_PORT", "PROXY_PORT"], "8080"),
    // 0.0.0.0 rather than localhost: inside a container the proxy must be
    // reachable from the outside, and sibling containers resolve us by name.
    BIND_ADDRESS: pick(source, ["OUTPOST_BIND_ADDRESS", "PROXY_HOST"], "0.0.0.0"), // prettier-ignore
    LOG_LEVEL: pick(source, ["OUTPOST_LOG_LEVEL", "LOG_LEVEL"], "info"),
  };
}

export function envFromNode(): AppEnv {
  return build(process.env as Record<string, unknown>);
}

export function envFromWorkers(workerEnv: unknown): AppEnv {
  return build((workerEnv ?? {}) as Record<string, unknown>);
}
