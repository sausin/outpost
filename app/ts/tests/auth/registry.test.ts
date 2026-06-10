import { describe, test, expect } from "vitest";
import { resolve } from "../../src/auth/registry.ts";

const KNOWN_TYPES = [
  "none",
  "bearer_static",
  "bearer_redis",
  "api_key_header",
  "api_key_query",
  "basic_auth",
  "hmac_signed",
  "oauth2_client_credentials",
  "custom_headers",
  "plugin",
] as const;

describe("auth registry", () => {
  test("all 10 known module names resolve to a constructor with matching typeName", async () => {
    for (const name of KNOWN_TYPES) {
      const Cls = await resolve(name);
      expect(Cls.typeName).toBe(name);
    }
  });

  test("unknown name throws an error listing built-in names", async () => {
    await expect(resolve("not_a_real_module")).rejects.toThrow(
      /Unknown auth type.*not_a_real_module/,
    );
    await expect(resolve("not_a_real_module")).rejects.toThrow(/none/);
  });

  test("resolve returns the same class on repeated calls", async () => {
    const a = await resolve("bearer_static");
    const b = await resolve("bearer_static");
    expect(a).toBe(b);
  });
});
