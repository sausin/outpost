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
  /**
   * Comma-separated IPs / CIDRs of reverse proxies whose forwarding headers
   * (X-Forwarded-For, CF-Connecting-IP, X-Real-IP) may be trusted.  Empty =
   * the socket peer is always the client.  Same semantics as the Python runtime.
   */
  TRUSTED_PROXIES: string;
  /**
   * Serve the status dashboard at /dashboard and its JSON at /api/overview.
   * "true" | "false"; defaults on. Neither page ever contains a secret value,
   * but they do show the host policy and credential env var NAMES.
   */
  DASHBOARD: string;
  /**
   * Re-read providers/ and hosts.yaml when they change on disk (Node only).
   * "true" | "false"; defaults on. Same idea as Traefik's file-provider watch.
   */
  CONFIG_WATCH: string;
  /** Release version baked into the image; "dev" when unset. */
  VERSION: string;

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
    TRUSTED_PROXIES: pick(source, ["OUTPOST_TRUSTED_PROXIES", "TRUSTED_PROXIES"], ""), // prettier-ignore
    DASHBOARD: pick(source, ["OUTPOST_DASHBOARD"], "true"),
    CONFIG_WATCH: pick(source, ["OUTPOST_CONFIG_WATCH"], "true"),
    VERSION: pick(source, ["OUTPOST_VERSION", "VERSION"], "dev"),
  };
}

/** Boolean env flag: anything but "false"/"0"/"no"/"off" (case-insensitive) is on. */
export function envFlag(raw: string | undefined | null): boolean {
  if (typeof raw !== "string") return true;
  return !["false", "0", "no", "off"].includes(raw.trim().toLowerCase());
}

/**
 * Split TRUSTED_PROXIES into its entries.  Whitespace-tolerant; empty items
 * dropped.  Validation of each IP / CIDR happens in ClientIpResolver.
 */
export function parseTrustedProxies(raw: string | undefined | null): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function envFromNode(): AppEnv {
  return build(process.env as Record<string, unknown>);
}

export function envFromWorkers(workerEnv: unknown): AppEnv {
  return build((workerEnv ?? {}) as Record<string, unknown>);
}
