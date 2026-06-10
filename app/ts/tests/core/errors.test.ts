import { describe, test, expect } from "vitest";
import { CODES, errorResponse } from "../../src/core/errors.ts";

describe("CODES constants", () => {
  test("all expected code keys exist", () => {
    const keys = Object.keys(CODES);
    const expected = [
      "UNKNOWN_PROVIDER",
      "HOST_DENIED",
      "NO_ROUTE",
      "PATH_DENIED",
      "SENSITIVE_DENIED",
      "RATE_LIMITED",
      "UPSTREAM_RATE_LIMITED",
      "AUTH_ERROR",
      "UPSTREAM_ERROR",
      "PROVIDER_CONFIG_ERROR",
      "PROVIDER_DISABLED",
    ];
    for (const k of expected) {
      expect(keys).toContain(k);
    }
  });

  test("all code values are unique strings", () => {
    const values = Object.values(CODES);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
    for (const v of values) {
      expect(typeof v).toBe("string");
    }
  });
});

describe("errorResponse", () => {
  test("returns correct HTTP status code", async () => {
    const r = errorResponse(404, CODES.NO_ROUTE, "not found");
    expect(r.status).toBe(404);
  });

  test("body has FAILURE status + error shape", async () => {
    const r = errorResponse(400, CODES.UNKNOWN_PROVIDER, "bad provider");
    const body = (await r.json()) as {
      status: string;
      error: { code: string; message: string; metadata: unknown };
    };
    expect(body.status).toBe("FAILURE");
    expect(body.error.code).toBe(CODES.UNKNOWN_PROVIDER);
    expect(body.error.message).toBe("bad provider");
    expect(body.error.metadata).toBeNull();
  });

  test("metadata is included when provided", async () => {
    const r = errorResponse(403, CODES.HOST_DENIED, "denied", {
      ip: "1.2.3.4",
    });
    const body = (await r.json()) as {
      error: { metadata: { ip: string } };
    };
    expect(body.error.metadata).toEqual({ ip: "1.2.3.4" });
  });

  test("custom headers are merged into response headers", () => {
    const r = errorResponse(429, CODES.RATE_LIMITED, "slow down", null, {
      "Retry-After": "5",
    });
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(r.headers.get("Retry-After")).toBe("5");
  });
});
