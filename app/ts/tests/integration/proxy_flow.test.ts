import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { buildApp } from "../../src/index.ts";
import { buildAppDeps } from "../../src/bootstrap.ts";
import { ProviderSchema } from "../../src/providers/schema.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type {
  CacheBackend,
  RateLimitBackend,
  CacheEntry,
} from "../../src/storage/interface.ts";
import { RateLimitedError } from "../../src/storage/interface.ts";
import type { WindowLimit } from "../../src/core/types.ts";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const HOSTS_YAML = `
hosts:
  - id: local
    cidrs: ["127.0.0.1/32"]
    can_call_sensitive: true
`;

const STRIPE_DEF = ProviderSchema.parse({
  name: "stripe",
  base_url: "https://api.stripe.com",
  auth: { type: "bearer_static", env: "STRIPE_KEY" },
  forwarding: {
    mode: "allowlist",
    allow: [
      {
        method: "GET",
        pattern: "/v1/charges",
        category: "read",
        cache_ttl: 60,
      },
      { method: "GET", pattern: "/v1/charges/*", category: "read" },
      {
        method: "POST",
        pattern: "/v1/charges",
        category: "write",
        sensitive: true,
      },
    ],
  },
});

type CacheStore = Map<string, CacheEntry>;

function fakeCache(store: CacheStore = new Map()): CacheBackend {
  return {
    get: async (key: string) => store.get(key) ?? null,
    put: async (key: string, entry: CacheEntry, _ttl: number) => {
      store.set(key, entry);
    },
  };
}

function fakeRateLimits(
  opts: {
    fail?: boolean;
    retryAfter?: number;
  } = {},
): RateLimitBackend {
  return {
    acquire: async () => {
      if (opts.fail) {
        throw new RateLimitedError(opts.retryAfter ?? 1);
      }
    },
    noteUpstream429: async () => {},
    cooldownRemainingMs: async () => 0,
  };
}

async function makeApp(
  opts: {
    cacheStore?: CacheStore;
    rateLimits?: RateLimitBackend;
  } = {},
) {
  const deps = await buildAppDeps({
    env: {
      DEFAULT_PROVIDER: "",
      PROVIDERS_DIR: "",
      HOSTS_CONFIG_PATH: "",
      PROXY_PORT: "",
      LOG_LEVEL: "",
      STRIPE_KEY: "sk_test_abc",
    },
    defs: new Map([["stripe", STRIPE_DEF]]),
    hostsYaml: HOSTS_YAML,
    tokenStorage: new InMemoryStorage(),
    cache: fakeCache(opts.cacheStore),
    rateLimits: opts.rateLimits ?? fakeRateLimits(),
  });
  return buildApp(deps);
}

function req(
  path: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
  } = {},
): Request {
  return new Request(`http://proxy${path}`, {
    method: opts.method ?? "GET",
    headers: {
      "x-forwarded-for": "127.0.0.1",
      ...opts.headers,
    },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("integration: proxy_flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("GET /healthz returns 200 with provider list", async () => {
    const app = await makeApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; providers: string[] };
    expect(body.status).toBe("ok");
    expect(body.providers).toContain("stripe");
  });

  test("GET /providers returns 200 with providers map", async () => {
    const app = await makeApp();
    const res = await app.request("/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ name: string; base_url: string }>;
    };
    expect(body.providers[0]?.name).toBe("stripe");
  });

  test("missing X-Provider returns 400 PROXY_UNKNOWN_PROVIDER", async () => {
    const app = await makeApp();
    const res = await app.request(req("/v1/charges"));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_UNKNOWN_PROVIDER");
  });

  test("source IP not in hosts.yaml returns 403 PROXY_HOST_DENIED", async () => {
    const app = await makeApp();
    const r = new Request("http://proxy/v1/charges", {
      headers: {
        "x-provider": "stripe",
        "x-forwarded-for": "10.99.99.99", // not in hosts.yaml
      },
    });
    const res = await app.request(r);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_HOST_DENIED");
  });

  test("allowlist miss returns 404 PROXY_NO_ROUTE", async () => {
    const app = await makeApp();
    const r = req("/v1/unknown", {
      headers: { "x-provider": "stripe" },
    });
    const res = await app.request(r);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_NO_ROUTE");
  });

  test("sensitive path + non-sensitive host returns 403 PROXY_SENSITIVE_DENIED", async () => {
    // Build app with a hosts.yaml that disallows sensitive calls
    const depsInput = {
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
        STRIPE_KEY: "sk_test",
      },
      defs: new Map([["stripe", STRIPE_DEF]]),
      hostsYaml: `
hosts:
  - id: readonly-host
    cidrs: ["127.0.0.1/32"]
    can_call_sensitive: false
`,
      tokenStorage: new InMemoryStorage(),
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    };
    const { buildAppDeps: bap } = await import("../../src/bootstrap.ts");
    const deps = await bap(depsInput);
    const app = buildApp(deps);

    const r = new Request("http://proxy/v1/charges", {
      method: "POST",
      headers: {
        "x-provider": "stripe",
        "x-forwarded-for": "127.0.0.1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ amount: 100 }),
    });
    const res = await app.request(r);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_SENSITIVE_DENIED");
  });

  test("successful proxy returns upstream body with X-Proxy-Provider header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "ch_123", amount: 100 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const app = await makeApp();
    const r = req("/v1/charges/ch_123", {
      headers: { "x-provider": "stripe" },
    });
    const res = await app.request(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy-provider")).toBe("stripe");
    const body = (await res.json()) as { id: string };
    expect(body.id).toBe("ch_123");
  });

  test("cache hit returns cached body with X-Proxy-Cache: HIT after a MISS", async () => {
    // First request — upstream returns a response
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "ch_list" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const cacheStore: CacheStore = new Map();
    const app = await makeApp({ cacheStore });

    // First call — MISS, populates cache
    const r1 = req("/v1/charges", { headers: { "x-provider": "stripe" } });
    const res1 = await app.request(r1);
    expect(res1.headers.get("x-proxy-cache")).toBe("MISS");

    // Second call — should be a HIT (no fetch needed)
    const r2 = req("/v1/charges", { headers: { "x-provider": "stripe" } });
    const res2 = await app.request(r2);
    expect(res2.headers.get("x-proxy-cache")).toBe("HIT");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });

  test("upstream 429 returns 429 PROXY_UPSTREAM_RATE_LIMITED + Retry-After", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "too many requests" }), {
        status: 429,
        headers: { "Retry-After": "3", "content-type": "application/json" },
      }),
    );
    const app = await makeApp();
    const r = req("/v1/charges/ch_123", {
      headers: { "x-provider": "stripe" },
    });
    const res = await app.request(r);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("PROXY_UPSTREAM_RATE_LIMITED");
  });

  test("token rejection (401) triggers auth.invalidate()", async () => {
    // Build app with bearer_redis so we can observe invalidation via storage
    const storage = new InMemoryStorage();
    await storage.set("stripe:token", "old_tok");

    const redisDef = ProviderSchema.parse({
      name: "brex",
      base_url: "https://api.brex.com",
      auth: {
        type: "bearer_redis",
        redis_key: "stripe:token",
      },
      forwarding: {
        mode: "transparent",
      },
    });

    const depsInput = {
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
      },
      defs: new Map([["brex", redisDef]]),
      hostsYaml: HOSTS_YAML,
      tokenStorage: storage,
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    };
    const { buildAppDeps: bap } = await import("../../src/bootstrap.ts");
    const appDeps = await bap(depsInput);
    const app = buildApp(appDeps);

    // Upstream returns 401 → should trigger invalidate
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    const r = new Request("http://proxy/v1/accounts", {
      headers: {
        "x-provider": "brex",
        "x-forwarded-for": "127.0.0.1",
      },
    });
    await app.request(r);
    // After invalidation, token should be cleared
    expect(await storage.get("stripe:token")).toBeNull();
  });
});
