import { describe, test, expect, vi } from "vitest";
import type { Context } from "hono";

import {
  ClientIpResolver,
  makeNodeClientIpResolver,
  normalizeIp,
  trustsProxyHeaders,
} from "../../src/core/client_ip.ts";
import { envFromWorkers, parseTrustedProxies } from "../../src/core/env.ts";

/** Minimal Context stand-in — the resolver only reads request headers. */
function ctx(headers: Record<string, string> = {}): Context {
  return {
    req: { raw: new Request("http://proxy.local/v1/x", { headers }) },
  } as unknown as Context;
}

function input(
  peer: string | null | undefined,
  headers: Record<string, string> = {},
) {
  return { peer, headers: new Headers(headers) };
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

  test("IPv6 is canonicalised", () => {
    expect(normalizeIp("2001:0db8:0000:0000:0000:0000:0000:0001")).toBe(
      "2001:db8::1",
    );
  });

  test("surrounding whitespace is tolerated", () => {
    expect(normalizeIp("  10.0.0.1 ")).toBe("10.0.0.1");
  });

  test("bracketed IPv6 with port is unwrapped", () => {
    expect(normalizeIp("[2001:db8::1]:8443")).toBe("2001:db8::1");
    expect(normalizeIp("[::1]")).toBe("::1");
  });

  test("IPv4 with port drops the port", () => {
    expect(normalizeIp("10.1.2.3:51234")).toBe("10.1.2.3");
  });

  test("garbage, empty and missing values are null", () => {
    expect(normalizeIp("not-an-ip")).toBeNull();
    expect(normalizeIp("999.1.1.1")).toBeNull();
    expect(normalizeIp("")).toBeNull();
    expect(normalizeIp("   ")).toBeNull();
    expect(normalizeIp(null)).toBeNull();
    expect(normalizeIp(undefined)).toBeNull();
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

describe("parseTrustedProxies", () => {
  test("splits on commas and trims", () => {
    expect(parseTrustedProxies(" 127.0.0.1, 10.0.0.0/8 ,, ::1 ")).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "::1",
    ]);
  });

  test("empty / missing yields an empty list", () => {
    expect(parseTrustedProxies("")).toEqual([]);
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies(null)).toEqual([]);
  });
});

describe("ClientIpResolver — peer is authoritative", () => {
  test("direct caller with no headers resolves to the peer", () => {
    const r = new ClientIpResolver();
    expect(r.resolve(input("192.168.50.199"))).toBe("192.168.50.199");
  });

  test("IPv4-mapped IPv6 peer is normalised so it matches IPv4 CIDRs", () => {
    const r = new ClientIpResolver();
    expect(r.resolve(input("::ffff:192.168.50.199"))).toBe("192.168.50.199");
  });

  test("IPv6 peer resolves to its canonical form", () => {
    const r = new ClientIpResolver();
    expect(r.resolve(input("::1"))).toBe("::1");
  });

  test("missing peer fails closed (null), even with forwarding headers", () => {
    const r = new ClientIpResolver();
    expect(
      r.resolve(input(undefined, { "x-forwarded-for": "127.0.0.1" })),
    ).toBeNull();
    expect(
      r.resolve(input(null, { "cf-connecting-ip": "127.0.0.1" })),
    ).toBeNull();
  });

  test("unparseable peer fails closed", () => {
    const r = new ClientIpResolver();
    expect(r.resolve(input("unknown"))).toBeNull();
  });
});

describe("ClientIpResolver — spoofed headers from untrusted peers are ignored", () => {
  test("X-Forwarded-For from an untrusted peer does not change identity", () => {
    const r = new ClientIpResolver();
    expect(
      r.resolve(input("10.99.99.99", { "x-forwarded-for": "127.0.0.1" })),
    ).toBe("10.99.99.99");
  });

  test("CF-Connecting-IP from an untrusted peer does not change identity", () => {
    const r = new ClientIpResolver();
    expect(
      r.resolve(input("10.99.99.99", { "cf-connecting-ip": "127.0.0.1" })),
    ).toBe("10.99.99.99");
  });

  test("X-Real-IP from an untrusted peer does not change identity", () => {
    const r = new ClientIpResolver();
    expect(r.resolve(input("10.99.99.99", { "x-real-ip": "127.0.0.1" }))).toBe(
      "10.99.99.99",
    );
  });

  test("trusted list configured, but peer outside it → still the peer", () => {
    // A caller that bypasses the declared reverse proxy cannot borrow its trust.
    const r = new ClientIpResolver(["10.0.0.0/8"]);
    expect(
      r.resolve(input("192.168.1.50", { "x-forwarded-for": "127.0.0.1" })),
    ).toBe("192.168.1.50");
  });
});

describe("ClientIpResolver — trusted proxies", () => {
  test("X-Forwarded-For from a trusted proxy is honoured", () => {
    const r = new ClientIpResolver(["172.18.0.2"]);
    expect(
      r.resolve(input("172.18.0.2", { "x-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  test("trusted proxy given as a CIDR matches", () => {
    const r = new ClientIpResolver(["172.18.0.0/16"]);
    expect(
      r.resolve(input("172.18.0.9", { "x-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  test("trusted IPv4-mapped peer matches an IPv4 trusted entry", () => {
    const r = new ClientIpResolver(["127.0.0.1"]);
    expect(
      r.resolve(
        input("::ffff:127.0.0.1", { "x-forwarded-for": "198.51.100.4" }),
      ),
    ).toBe("198.51.100.4");
  });

  test("XFF chain: rightmost untrusted hop wins, client-supplied prefix ignored", () => {
    const r = new ClientIpResolver(["10.0.0.0/8"]);
    // Client sent "127.0.0.1" itself; proxy 10.0.0.5 appended real client 203.0.113.7;
    // proxy 10.0.0.6 appended 10.0.0.5.
    expect(
      r.resolve(
        input("10.0.0.6", {
          "x-forwarded-for": "127.0.0.1, 203.0.113.7, 10.0.0.5",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  test("XFF chain consisting only of trusted proxies resolves to the leftmost", () => {
    const r = new ClientIpResolver(["10.0.0.0/8"]);
    expect(
      r.resolve(input("10.0.0.6", { "x-forwarded-for": "10.0.0.1, 10.0.0.5" })),
    ).toBe("10.0.0.1");
  });

  test("malformed XFF hop from a trusted proxy fails closed", () => {
    const r = new ClientIpResolver(["10.0.0.0/8"]);
    expect(
      r.resolve(input("10.0.0.6", { "x-forwarded-for": "garbage" })),
    ).toBeNull();
  });

  test("XFF entries are normalised (whitespace, mapped IPv6, ports)", () => {
    const r = new ClientIpResolver(["10.0.0.0/8"]);
    expect(
      r.resolve(
        input("10.0.0.6", { "x-forwarded-for": "  ::ffff:203.0.113.7 " }),
      ),
    ).toBe("203.0.113.7");
    expect(
      r.resolve(input("10.0.0.6", { "x-forwarded-for": "[2001:db8::1]:443" })),
    ).toBe("2001:db8::1");
  });

  test("CF-Connecting-IP from a trusted proxy takes precedence over XFF", () => {
    const r = new ClientIpResolver(["127.0.0.1"]);
    expect(
      r.resolve(
        input("127.0.0.1", {
          "cf-connecting-ip": "203.0.113.7",
          "x-forwarded-for": "198.51.100.4",
        }),
      ),
    ).toBe("203.0.113.7");
  });

  test("X-Real-IP is used when a trusted proxy sends no XFF", () => {
    const r = new ClientIpResolver(["127.0.0.1"]);
    expect(r.resolve(input("127.0.0.1", { "x-real-ip": "203.0.113.7" }))).toBe(
      "203.0.113.7",
    );
  });

  test("trusted proxy with no forwarding headers resolves to the proxy itself", () => {
    const r = new ClientIpResolver(["127.0.0.1"]);
    expect(r.resolve(input("127.0.0.1"))).toBe("127.0.0.1");
  });

  test("IPv6 trusted proxy CIDR", () => {
    const r = new ClientIpResolver(["fd00::/8"]);
    expect(
      r.resolve(input("fd00::42", { "x-forwarded-for": "203.0.113.7" })),
    ).toBe("203.0.113.7");
  });

  test("invalid trusted-proxy entries are skipped with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = new ClientIpResolver(["not-a-cidr", "10.0.0.0/8"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not-a-cidr"));
    expect(r.isTrustedProxy("10.1.2.3")).toBe(true);
    expect(r.isTrustedProxy("192.168.0.1")).toBe(false);
    warn.mockRestore();
  });
});

describe("Node client-IP resolution (adapter hook)", () => {
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

  test("honours X-Forwarded-For once a proxy is declared and is the peer", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({ OUTPOST_TRUSTED_PROXIES: "172.18.0.0/16" }),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx({ "x-forwarded-for": "203.0.113.9, 172.18.0.4" }))).toBe(
      "203.0.113.9",
    );
    info.mockRestore();
  });

  test("ignores X-Forwarded-For when a proxy is declared but the peer is not it", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({ OUTPOST_TRUSTED_PROXIES: "172.18.0.0/16" }),
      socketAddress: () => "192.168.50.199",
    });
    expect(resolve(ctx({ "x-forwarded-for": "127.0.0.1" }))).toBe(
      "192.168.50.199",
    );
    info.mockRestore();
  });

  test("falls back to the socket peer when the trusted proxy sends no header", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const resolve = makeNodeClientIpResolver({
      env: envFromWorkers({ TRUSTED_PROXIES: "172.18.0.0/16" }),
      socketAddress: () => "172.18.0.4",
    });
    expect(resolve(ctx())).toBe("172.18.0.4");
    info.mockRestore();
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
