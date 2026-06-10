/**
 * Environment abstraction — same API for both runtimes:
 *   Workers: env bindings passed from the fetch handler
 *   Node:    process.env read at construction time
 */

export interface AppEnv {
  // String env vars
  DEFAULT_PROVIDER: string;
  PROVIDERS_DIR: string;
  HOSTS_CONFIG_PATH: string;
  PROXY_PORT: string;
  LOG_LEVEL: string;

  // Workers: KV bindings; Node: undefined (Redis used instead in Phase 4)
  TOKENS?: KVNamespace;
  RATE_LIMIT?: KVNamespace;
  IDEMPOTENCY?: KVNamespace;

  // Free-form passthrough for provider credentials (STRIPE_SECRET_KEY, etc.)
  [key: string]: unknown;
}

export function envFromNode(): AppEnv {
  return {
    DEFAULT_PROVIDER: process.env["DEFAULT_PROVIDER"] ?? "",
    PROVIDERS_DIR: process.env["PROVIDERS_DIR"] ?? "./builtin_providers",
    HOSTS_CONFIG_PATH: process.env["HOSTS_CONFIG_PATH"] ?? "./hosts.yaml",
    PROXY_PORT: process.env["PROXY_PORT"] ?? "8080",
    LOG_LEVEL: process.env["LOG_LEVEL"] ?? "info",
    // Spread all process.env so provider credentials are accessible
    ...process.env,
  };
}

export function envFromWorkers(workerEnv: unknown): AppEnv {
  const e = workerEnv as Record<string, unknown>;
  return {
    DEFAULT_PROVIDER: (e["DEFAULT_PROVIDER"] as string | undefined) ?? "",
    PROVIDERS_DIR:
      (e["PROVIDERS_DIR"] as string | undefined) ?? "./builtin_providers",
    HOSTS_CONFIG_PATH:
      (e["HOSTS_CONFIG_PATH"] as string | undefined) ?? "./hosts.yaml",
    PROXY_PORT: (e["PROXY_PORT"] as string | undefined) ?? "8080",
    LOG_LEVEL: (e["LOG_LEVEL"] as string | undefined) ?? "info",
    // Spread all bindings so KV namespaces + provider credentials are accessible
    ...e,
  };
}
