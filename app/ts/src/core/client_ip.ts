/**
 * Client IP resolution — decides which address hosts.yaml is matched against.
 *
 * The transport-level peer (the TCP socket's remote address on Node, the
 * Cloudflare edge's view of the caller on Workers) is authoritative.
 * Forwarding headers (`CF-Connecting-IP`, `X-Forwarded-For`, `X-Real-IP`) are
 * honoured ONLY when the peer is one of the configured trusted proxies
 * (`TRUSTED_PROXIES`, comma-separated IPs or CIDRs).  Anything a direct caller
 * puts in those headers is ignored, so an untrusted host cannot pick its own
 * identity by spoofing `X-Forwarded-For`.
 *
 * Addresses are normalised before matching: IPv4-mapped IPv6 peers such as
 * `::ffff:192.168.50.199` (what Node reports on a dual-stack listener) become
 * `192.168.50.199` so they match IPv4 CIDRs in the host policy.
 */

import ipaddr from "ipaddr.js";

export interface ClientIpInput {
  /**
   * Transport-level peer address as reported by the runtime.  `undefined` or
   * `null` means the runtime could not supply one; resolution then fails
   * closed (returns null) rather than falling back to spoofable headers.
   */
  peer?: string | null;
  headers: Headers;
}

/**
 * Runtime hook that extracts the transport peer for a request.
 *   Node:    `env.incoming.socket.remoteAddress`
 *   Workers: `CF-Connecting-IP` — set by the Cloudflare edge that terminated the
 *            connection; a client cannot forge it through Cloudflare.
 */
export type PeerAddressHook = (
  env: unknown,
  request: Request,
) => string | null | undefined;

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

/** Parse a comma-separated list of IPs / CIDRs; invalid entries are logged and skipped. */
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

export class ClientIpResolver {
  private readonly trusted: Cidr[];

  constructor(trustedProxies: readonly string[] = []) {
    this.trusted = parseCidrs(trustedProxies);
  }

  /** True when `ip` (already normalised) falls inside a trusted-proxy CIDR. */
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

    // Direct caller (or an unconfigured proxy): the socket peer IS the client.
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
