import { describe, test, expect } from "vitest";
import type { Context } from "hono";

import {
  makeNodeClientIpResolver,
  normalizeIp,
  trustsProxyHeaders,
} from "../../src/core/client_ip.ts";
import { envFromWorkers } from "../../src/core/env.ts";

/** Minimal Context stand-in — the resolver only reads request headers. */
function ctx(headers: Record<string, string> = {}): Context {
  return {
    req: { raw: new Request("http://proxy.local/v1/x", { headers }) },
  } as unknown as Context;
}

describe("normalizeIp", () => {
  test("unwraps IPv4-mapped IPv6", () => {
    expect(normalizeIp("::ffff:192.168.1.10")).toBe("192.168.1.10");
    expect(normalizeIp("::FFFF:10.0.0.1")).toBe("10.0.0.1");
  });

  test("leaves real addresses alone", () => {
    expect(normalizeIp("10.0.0.1")).toBe("10.0.0.1");
    expect(normalizeIp("::1")).toBe("::1");
  });
});

describe("trustsProxyHeaders", () => {
  test("off unless a proxy is declared", () => {
    expect(trustsProxyHeaders(envFromWorkers({}))).toBe(false);
    expect(trustsProxyHeaders(envFromWorkers({ TRUSTED_PROXIES: "  " }))).toBe(false); // prettier-ignore
  });

  test("on for either variable name", () => {
    expect(trustsProxyHeaders(envFromWorkers({ TRUSTED_PROXIES: "10.0.0.0/8" }))).toBe(true); // prettier-ignore
    expect(trustsProxyHeaders(envFromWorkers({ OUTPOST_TRUSTED_PROXIES: "10.0.0.0/8" }))).toBe(true); // prettier-ignore
  });
});

describe("Node client-IP resolution", () => {
  test("uses the socket peer when no proxy is declared", () => {
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({}),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx())).toBe("172.18.0.4");
  });

  test("ignores X-Forwarded-For when no proxy is declared", () => {
    // Without this, any caller could claim the loopback policy — which is the
    // most privileged entry in the shipped hosts.yaml — with one header.
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({}),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx({ "x-forwarded-for": "127.0.0.1" }))).toBe("172.18.0.4");
  });

  test("honours X-Forwarded-For once a proxy is declared", () => {
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({ OUTPOST_TRUSTED_PROXIES: "172.18.0.0/16" }),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx({ "x-forwarded-for": "203.0.113.9, 172.18.0.4" }))).toBe(
      "203.0.113.9",
    );
  });

  test("falls back to the socket peer when the trusted proxy sends no header", () => {
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({ TRUSTED_PROXIES: "172.18.0.0/16" }),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx())).toBe("172.18.0.4");
  });

  test("normalizes an IPv4-mapped socket address", () => {
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({}),
      socketAddress: () => "::ffff:172.18.0.4",
    });
    expect(resolve(ctx())).toBe("172.18.0.4");
  });

  test("undefined when the peer address is unavailable", () => {
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({}),
      socketAddress: () => undefined,
    });
    expect(resolve(ctx())).toBeUndefined();
  });
});
