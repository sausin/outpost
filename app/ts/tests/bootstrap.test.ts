import { describe, test, expect, vi, afterEach } from "vitest";
import { buildAppDeps } from "../src/bootstrap.ts";
import { ProviderSchema } from "../src/providers/schema.ts";
import { InMemoryStorage } from "./helpers/in_memory_storage.ts";
import type {
  CacheBackend,
  RateLimitBackend,
} from "../src/storage/interface.ts";
import type { CacheEntry } from "../src/storage/interface.ts";
import type { WindowLimit } from "../src/core/types.ts";

const HOSTS_YAML_ALLOW_ALL = `
hosts:
  - id: all
    cidrs: ["0.0.0.0/0"]
    can_call_sensitive: false
`;

function fakeCache(): CacheBackend {
  return {
    get: async (_key: string) => null,
    put: async (_key: string, _entry: CacheEntry, _ttl: number) => {},
  };
}

function fakeRateLimits(): RateLimitBackend {
  return {
    acquire: async (
      _provider: string,
      _category: string,
      _windows: WindowLimit[],
      _timeout: number,
    ) => {},
    noteUpstream429: async (
      _provider: string,
      _category: string,
      _retryAfter: number,
    ) => {},
    cooldownRemainingMs: async (_provider: string, _category: string) => 0,
  };
}

function stripeProviderDef() {
  return ProviderSchema.parse({
    name: "stripe",
    base_url: "https://api.stripe.com",
    auth: { type: "bearer_static", env: "STRIPE_KEY" },
  });
}

describe("buildAppDeps", () => {
  afterEach(() => vi.restoreAllMocks());

  test("builds AppDeps from valid defs map", async () => {
    const defs = new Map([["stripe", stripeProviderDef()]]);
    const deps = await buildAppDeps({
      env: {
        DEFAULT_PROVIDER: "stripe",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
        STRIPE_KEY: "sk_test_123",
      },
      defs,
      hostsYaml: HOSTS_YAML_ALLOW_ALL,
      tokenStorage: new InMemoryStorage(),
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    });
    expect(deps.providers.has("stripe")).toBe(true);
    expect(deps.providers.get("stripe")?.name).toBe("stripe");
  });

  test("skips providers whose auth construction fails (missing env)", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const defs = new Map([
      ["stripe", stripeProviderDef()], // STRIPE_KEY missing
      [
        "other",
        ProviderSchema.parse({
          name: "other",
          base_url: "https://api.other.com",
          auth: { type: "none" },
        }),
      ],
    ]);
    const deps = await buildAppDeps({
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
        // STRIPE_KEY intentionally missing
      },
      defs,
      hostsYaml: HOSTS_YAML_ALLOW_ALL,
      tokenStorage: new InMemoryStorage(),
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    });
    expect(deps.providers.has("stripe")).toBe(false);
    expect(deps.providers.has("other")).toBe(true);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  test("HostResolver is constructed from hostsYaml", async () => {
    const defs = new Map<string, ReturnType<typeof stripeProviderDef>>();
    const deps = await buildAppDeps({
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
      },
      defs,
      hostsYaml: `
hosts:
  - id: my-host
    cidrs: ["10.0.0.1/32"]
    can_call_sensitive: true
`,
      tokenStorage: new InMemoryStorage(),
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    });
    expect(deps.hosts.resolve("10.0.0.1")?.id).toBe("my-host");
    expect(deps.hosts.resolve("10.0.0.2")).toBeNull();
  });

  test("defaultProvider is populated from env.DEFAULT_PROVIDER", async () => {
    const defs = new Map([
      [
        "myapi",
        ProviderSchema.parse({
          name: "myapi",
          base_url: "https://api.myapi.com",
          auth: { type: "none" },
        }),
      ],
    ]);
    const deps = await buildAppDeps({
      env: {
        DEFAULT_PROVIDER: "myapi",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
      },
      defs,
      hostsYaml: HOSTS_YAML_ALLOW_ALL,
      tokenStorage: new InMemoryStorage(),
      cache: fakeCache(),
      rateLimits: fakeRateLimits(),
    });
    expect(deps.defaultProvider).toBe("myapi");
  });
});
