/**
 * Client-IP resolution for the Node runtime.
 *
 * `hosts.yaml` is an access-control list keyed on the caller's address, so
 * where that address comes from is a security decision, not a detail:
 *
 *   - Direct deployments (the common case for a self-hosted app) must use the
 *     socket peer. Trusting `X-Forwarded-For` here would let any caller claim
 *     to be 127.0.0.1 and inherit the loopback policy by sending one header.
 *   - Behind a reverse proxy the socket peer is always the proxy, so the
 *     forwarded header is the only real answer — but only when the operator
 *     has declared that proxy via OUTPOST_TRUSTED_PROXIES / TRUSTED_PROXIES
 *     AND the connection actually comes from one of the declared addresses.
 *     A caller that reaches the proxy directly, bypassing the declared
 *     reverse proxy, is still identified by its socket peer.
 *
 * Forwarding headers honoured from a trusted peer, in order: `CF-Connecting-IP`
 * (cloudflared / Cloudflare in front), `X-Forwarded-For` (walked right to left
 * past trusted hops so a client-supplied prefix is never believed), `X-Real-IP`.
 *
 * Addresses are normalised before matching: IPv4-mapped IPv6 peers such as
 * `::ffff:192.168.50.199` (what Node reports on a dual-stack listener) become
 * `192.168.50.199` so they match IPv4 CIDRs in the host policy.
 *
 * Same opt-in semantics as the Python runtime's TRUSTED_PROXIES.
 */

import type { Context } from "hono";
import ipaddr from "ipaddr.js";

import type { AppEnv } from "./env.ts";
import { parseTrustedProxies } from "./env.ts";

/**
 * Normalise a textual address into its canonical form, or null if invalid.
 * Handles surrounding whitespace, `[v6]` / `[v6]:port` / `v4:port` forms that
 * some proxies emit, and collapses IPv4-mapped IPv6 to plain IPv4.
 */
export function normalizeIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (s.length === 0) return null;

  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(s);
  if (bracketed) {
    s = bracketed[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(s)) {
    s = s.slice(0, s.lastIndexOf(":"));
  }

  try {
    return ipaddr.process(s).toString();
  } catch {
    return null;
  }
}

interface Cidr {
  network: ipaddr.IPv4 | ipaddr.IPv6;
  prefixLen: number;
}

/** Parse a list of IPs / CIDRs; invalid entries are logged and skipped. */
function parseCidrs(entries: readonly string[]): Cidr[] {
  const out: Cidr[] = [];
  for (const raw of entries) {
    const s = raw.trim();
    if (s.length === 0) continue;
    try {
      if (s.includes("/")) {
        const [network, prefixLen] = ipaddr.parseCIDR(s);
        out.push({ network, prefixLen });
      } else {
        const network = ipaddr.process(s);
        out.push({
          network,
          prefixLen: network.kind() === "ipv6" ? 128 : 32,
        });
      }
    } catch {
      console.warn(`TRUSTED_PROXIES: skipping invalid entry '${s}'`);
    }
  }
  return out;
}

export interface ClientIpInput {
  /**
   * Transport-level peer address as reported by the runtime.  `undefined` or
   * `null` means the runtime could not supply one; resolution then fails
   * closed (returns null) rather than falling back to spoofable headers.
   */
  peer?: string | null;
  headers: Headers;
}

/** Runtime-agnostic engine: peer + headers + trusted-proxy list → client IP. */
export class ClientIpResolver {
  private readonly trusted: Cidr[];

  constructor(trustedProxies: readonly string[] = []) {
    this.trusted = parseCidrs(trustedProxies);
  }

  /** True when at least one trusted-proxy entry parsed. */
  get hasTrustedProxies(): boolean {
    return this.trusted.length > 0;
  }

  /** True when `ip` falls inside a trusted-proxy CIDR. */
  isTrustedProxy(ip: string): boolean {
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      addr = ipaddr.process(ip);
    } catch {
      return false;
    }
    for (const { network, prefixLen } of this.trusted) {
      if (addr.kind() !== network.kind()) continue;
      if (
        addr.match([network, prefixLen] as Parameters<typeof addr.match>[0])
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve the client IP for policy matching.
   *
   * Returns null when no usable address exists (no peer, or a trusted proxy
   * forwarded only garbage) — callers must treat that as "denied".
   */
  resolve(input: ClientIpInput): string | null {
    const peer = normalizeIp(input.peer);
    if (peer === null) return null;

    // Direct caller (or an undeclared proxy): the socket peer IS the client.
    if (!this.isTrustedProxy(peer)) return peer;

    const h = input.headers;

    // Cloudflare (via cloudflared / CF in front) sets this to the real client.
    const cf = normalizeIp(h.get("cf-connecting-ip"));
    if (cf !== null) return cf;

    // X-Forwarded-For: walk from the right, skipping trusted proxies.  The
    // first untrusted hop is the client; everything left of it was supplied
    // by the client itself and is not to be believed.
    const xff = h.get("x-forwarded-for");
    if (xff !== null) {
      const hops = xff
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      let leftmost: string | null = null;
      for (let i = hops.length - 1; i >= 0; i--) {
        const hop = normalizeIp(hops[i]);
        if (hop === null) return null; // malformed chain from a trusted proxy
        if (!this.isTrustedProxy(hop)) return hop;
        leftmost = hop;
      }
      // Every hop was a trusted proxy — the caller is one of our own proxies.
      if (leftmost !== null) return leftmost;
    }

    const real = normalizeIp(h.get("x-real-ip"));
    if (real !== null) return real;

    // Trusted proxy connected without forwarding headers (health checks, etc).
    return peer;
  }
}

/** True when the operator has declared at least one reverse proxy. */
export function trustsProxyHeaders(env: AppEnv): boolean {
  return parseTrustedProxies(env.TRUSTED_PROXIES).length > 0;
}

export interface NodeClientIpOptions {
  env: AppEnv;
  /** Socket peer address for this request, from the adapter. */
  socketAddress: (c: Context) => string | undefined;
}

/**
 * Build the Node adapter's `resolveClientIp` hook: socket peer is
 * authoritative; forwarding headers count only when that peer is one of the
 * declared trusted proxies.
 */
export function makeNodeClientIpResolver(
  opts: NodeClientIpOptions,
): (c: Context) => string | undefined {
  const trustedProxies = parseTrustedProxies(opts.env.TRUSTED_PROXIES);
  const resolver = new ClientIpResolver(trustedProxies);

  if (trustedProxies.length > 0) {
    console.info(
      `[node] Trusted proxies configured — honouring forwarding headers from: ${trustedProxies.join(", ")}`,
    );
  }

  return (c: Context) =>
    resolver.resolve({
      peer: opts.socketAddress(c),
      headers: c.req.raw.headers,
    }) ?? undefined;
}
