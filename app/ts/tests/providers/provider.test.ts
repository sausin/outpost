import { describe, test, expect } from "vitest";
import { GenericProvider } from "../../src/providers/provider.ts";
import { ProviderSchema } from "../../src/providers/schema.ts";
import { NoneAuth } from "../../src/auth/modules/none.ts";
import type { AuthModule } from "../../src/auth/types.ts";

function noneAuth(): AuthModule {
  return NoneAuth.fromConfig(
    {},
    {
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
      },
      tokenStorage: {} as never,
    },
  );
}

function makeProvider(
  overrides: Record<string, unknown> = {},
): GenericProvider {
  const def = ProviderSchema.parse({
    name: "test",
    base_url: "https://api.example.com",
    auth: { type: "none" },
    ...overrides,
  });
  return new GenericProvider(def, noneAuth());
}

describe("GenericProvider.classify — transparent mode", () => {
  test("GET returns default category, not sensitive", () => {
    const p = makeProvider();
    const r = p.classify("GET", "/v1/charges");
    expect(r).not.toBeNull();
    expect(r!.category).toBe("default");
    expect(r!.sensitive).toBe(false);
  });

  test("POST is treated as sensitive by default", () => {
    const p = makeProvider();
    const r = p.classify("POST", "/v1/charges");
    expect(r!.sensitive).toBe(true);
  });

  test("treat_writes_as_sensitive: false makes POST non-sensitive", () => {
    const p = makeProvider({
      forwarding: { treat_writes_as_sensitive: false },
    });
    const r = p.classify("POST", "/v1/charges");
    expect(r!.sensitive).toBe(false);
  });
});

describe("GenericProvider.classify — allowlist mode", () => {
  function allowlistProvider(): GenericProvider {
    return makeProvider({
      forwarding: {
        mode: "allowlist",
        allow: [
          { method: "GET", pattern: "/v1/charges", category: "read" },
          {
            method: "POST",
            pattern: "/v1/orders",
            category: "trade",
            sensitive: true,
          },
        ],
      },
    });
  }

  test("matches the first matching allow rule", () => {
    const p = allowlistProvider();
    const r = p.classify("GET", "/v1/charges");
    expect(r).not.toBeNull();
    expect(r!.category).toBe("read");
  });

  test("returns null when no rule matches", () => {
    const p = allowlistProvider();
    const r = p.classify("GET", "/v1/unknown");
    expect(r).toBeNull();
  });

  test("sensitive flag from rule is preserved", () => {
    const p = allowlistProvider();
    const r = p.classify("POST", "/v1/orders");
    expect(r!.sensitive).toBe(true);
    expect(r!.category).toBe("trade");
  });
});

describe("GenericProvider.isDenied", () => {
  function providerWithDeny(): GenericProvider {
    return makeProvider({
      forwarding: {
        deny: ["/admin/**", "/internal/secret"],
      },
    });
  }

  test("isDenied returns true for a denied path", () => {
    const p = providerWithDeny();
    expect(p.isDenied("/admin/users")).toBe(true);
    expect(p.isDenied("/internal/secret")).toBe(true);
  });

  test("isDenied returns false for non-denied paths", () => {
    const p = providerWithDeny();
    expect(p.isDenied("/v1/charges")).toBe(false);
  });

  test("denied path causes classify to return null", () => {
    const p = providerWithDeny();
    expect(p.classify("GET", "/admin/users")).toBeNull();
  });
});

describe("GenericProvider.windowsFor", () => {
  test("returns windows for the configured category", () => {
    const p = makeProvider({
      forwarding: {
        rate_limits: {
          default: [{ capacity: 50, window_ms: 1000 }],
          trade: [{ capacity: 5, window_ms: 1000 }],
        },
      },
    });
    const w = p.windowsFor("trade");
    expect(w).toHaveLength(1);
    expect(w[0]!.capacity).toBe(5);
  });

  test("falls back to default when category is unknown", () => {
    const p = makeProvider({
      forwarding: {
        rate_limits: {
          default: [{ capacity: 50, window_ms: 1000 }],
        },
      },
    });
    const w = p.windowsFor("unknown-category");
    expect(w[0]!.capacity).toBe(50);
  });

  test("returns empty array when no rate limits configured at all", () => {
    const def = ProviderSchema.parse({
      name: "nolimits",
      base_url: "https://api.example.com",
      auth: { type: "none" },
      forwarding: {
        rate_limits: {},
      },
    });
    const p = new GenericProvider(def, noneAuth());
    expect(p.windowsFor("default")).toEqual([]);
  });
});
