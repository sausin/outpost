import { describe, test, expect } from "vitest";
import { ProviderSchema, AllowRuleSchema } from "../../src/providers/schema.ts";

const MINIMAL_DEF = {
  name: "stripe",
  base_url: "https://api.stripe.com",
  auth: { type: "bearer_static", env: "STRIPE_SECRET_KEY" },
};

describe("ProviderSchema", () => {
  test("minimal valid provider parses without error", () => {
    const result = ProviderSchema.safeParse(MINIMAL_DEF);
    expect(result.success).toBe(true);
  });

  test("enabled defaults to true", () => {
    const result = ProviderSchema.parse(MINIMAL_DEF);
    expect(result.enabled).toBe(true);
  });

  test("forwarding.mode defaults to 'transparent'", () => {
    const result = ProviderSchema.parse(MINIMAL_DEF);
    expect(result.forwarding.mode).toBe("transparent");
  });

  test("forwarding.allow method is uppercased on parse", () => {
    const result = ProviderSchema.parse({
      ...MINIMAL_DEF,
      forwarding: {
        allow: [{ method: "get", pattern: "/v1/charges" }],
      },
    });
    expect(result.forwarding.allow[0]!.method).toBe("GET");
  });

  test("name with special chars is rejected", () => {
    const result = ProviderSchema.safeParse({
      ...MINIMAL_DEF,
      name: "my provider!",
    });
    expect(result.success).toBe(false);
  });

  test("invalid base_url is rejected", () => {
    const result = ProviderSchema.safeParse({
      ...MINIMAL_DEF,
      base_url: "not-a-url",
    });
    expect(result.success).toBe(false);
  });

  test("allow rule with method '*' parses", () => {
    const result = AllowRuleSchema.parse({
      method: "*",
      pattern: "/v1/health",
    });
    expect(result.method).toBe("*");
  });

  test("rate_limits default contains 50/sec and 500/min windows", () => {
    const result = ProviderSchema.parse(MINIMAL_DEF);
    const windows = result.forwarding.rate_limits["default"];
    expect(windows).toBeDefined();
    expect(windows!.length).toBe(2);
    const capacities = windows!.map((w) => w.capacity);
    expect(capacities).toContain(50);
    expect(capacities).toContain(500);
  });

  test("auth.passthrough preserves extra fields", () => {
    const result = ProviderSchema.parse({
      ...MINIMAL_DEF,
      auth: { type: "bearer_static", env: "MY_KEY", custom_field: "preserved" },
    });
    expect((result.auth as Record<string, unknown>)["custom_field"]).toBe(
      "preserved",
    );
  });

  test("name is lowercased on parse", () => {
    const result = ProviderSchema.parse({ ...MINIMAL_DEF, name: "Stripe" });
    expect(result.name).toBe("stripe");
  });

  test("complex provider round-trips correctly", () => {
    const complex = {
      name: "groww",
      base_url: "https://api.groww.in",
      description: "Groww broker",
      enabled: true,
      default_headers: { "X-App": "outpost" },
      strip_response_headers: ["x-request-id"],
      auth: {
        type: "plugin",
        module: "plugins/groww_totp_mint.ts:GrowwTotpMintAuth",
      },
      forwarding: {
        mode: "allowlist",
        allow: [
          { method: "GET", pattern: "/v1/positions", category: "read" },
          {
            method: "POST",
            pattern: "/v1/orders",
            category: "trade",
            sensitive: true,
          },
        ],
        deny: ["/admin/**"],
        rate_limits: {
          read: [{ capacity: 100, window_ms: 1000 }],
          trade: [{ capacity: 10, window_ms: 1000 }],
        },
      },
    };
    const result = ProviderSchema.parse(complex);
    expect(result.name).toBe("groww");
    expect(result.forwarding.allow).toHaveLength(2);
    expect(result.forwarding.deny).toHaveLength(1);
    expect(result.default_headers).toEqual({ "X-App": "outpost" });
  });
});
