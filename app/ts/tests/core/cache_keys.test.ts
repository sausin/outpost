import { describe, test, expect } from "vitest";
import { queryHash, cacheKey, idemKey } from "../../src/core/cache_keys.ts";

describe("queryHash", () => {
  test("same inputs produce the same hash", async () => {
    const a = await queryHash("foo=1&bar=2");
    const b = await queryHash("foo=1&bar=2");
    expect(a).toBe(b);
  });

  test("different param orderings produce the SAME hash (sorted)", async () => {
    const a = await queryHash("foo=1&bar=2");
    const b = await queryHash("bar=2&foo=1");
    expect(a).toBe(b);
  });

  test("different query strings produce DIFFERENT hashes", async () => {
    const a = await queryHash("foo=1");
    const b = await queryHash("foo=2");
    expect(a).not.toBe(b);
  });

  test("empty string returns the stable sentinel '_'", async () => {
    const h = await queryHash("");
    expect(h).toBe("_");
  });

  test("hash is a 16-char hex string for non-empty input", async () => {
    const h = await queryHash("a=1");
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("cacheKey", () => {
  test("produces a prefixed key with all components", async () => {
    const k = await cacheKey("stripe", "GET", "/v1/charges", "limit=10");
    expect(k.startsWith("cache:stripe:GET:/v1/charges:")).toBe(true);
  });

  test("different providers produce different keys", async () => {
    const a = await cacheKey("stripe", "GET", "/v1/charges", "limit=10");
    const b = await cacheKey("brex", "GET", "/v1/charges", "limit=10");
    expect(a).not.toBe(b);
  });
});

describe("idemKey", () => {
  test("prefixes with idem:{provider}:", () => {
    const k = idemKey("stripe", "my-idem-key-123");
    expect(k).toBe("idem:stripe:my-idem-key-123");
  });
});
