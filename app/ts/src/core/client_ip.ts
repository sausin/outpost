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
 *     forwarded header is the only real answer — but only once the operator
 *     has said a proxy is there, by setting OUTPOST_TRUSTED_PROXIES.
 *
 * Same opt-in semantics as the Python runtime's TRUSTED_PROXIES.
 */

import type { Context } from "hono";

import type { AppEnv } from "./env.ts";

/** IPv4-mapped IPv6 (`::ffff:10.0.0.1`) → plain IPv4, which is what CIDRs use. */
export function normalizeIp(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return mapped ? mapped[1]! : ip;
}

export function trustsProxyHeaders(env: AppEnv): boolean {
  const configured =
    env["OUTPOST_TRUSTED_PROXIES"] ?? env["TRUSTED_PROXIES"] ?? "";
  return typeof configured === "string" && configured.trim().length > 0;
}

export interface NodeClientIpOptions {
  env: AppEnv;
  /** Socket peer address for this request, from the adapter. */
  socketAddress: (c: Context) => string | undefined;
}

export function makeNodeClientIpResolver(
  opts: NodeClientIpOptions,
): (c: Context) => string | undefined {
  const trustHeaders = trustsProxyHeaders(opts.env);

  if (trustHeaders) {
    console.info(
      "[node] Trusted proxies configured — honouring X-Forwarded-For for host policy",
    );
  }

  return (c: Context) => {
    if (trustHeaders) {
      const forwarded = c.req.raw.headers
        .get("x-forwarded-for")
        ?.split(",")[0]
        ?.trim();
      if (forwarded) return normalizeIp(forwarded);
    }

    const socket = opts.socketAddress(c);
    return socket ? normalizeIp(socket) : undefined;
  };
}
