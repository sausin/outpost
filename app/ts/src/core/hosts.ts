/**
 * Host policy: load hosts.yaml, resolve client IP → host policy via
 * longest-prefix CIDR match — mirrors app/core/hosts.py
 */

import * as ipaddr from "ipaddr.js";
import yaml from "js-yaml";
import type { AppEnv } from "./env.ts";

export interface HostPolicy {
  id: string;
  canCallSensitive: boolean;
  description?: string;
  /** Resolved PSK value (from the env var named in YAML), or undefined if no auth required. */
  authToken?: string;
}

interface CidrEntry {
  network: ipaddr.IPv4 | ipaddr.IPv6;
  prefixLen: number;
  isV6: boolean;
  policy: HostPolicy;
}

export class HostResolver {
  private readonly entries: CidrEntry[];

  constructor(entries: Array<{ cidr: string; policy: HostPolicy }>) {
    const parsed: CidrEntry[] = [];

    for (const { cidr, policy } of entries) {
      try {
        const [addr, prefixLen] = ipaddr.parseCIDR(cidr);
        parsed.push({
          network: addr,
          prefixLen,
          isV6: addr.kind() === "ipv6",
          policy,
        });
      } catch {
        console.warn(`HostResolver: skipping invalid CIDR '${cidr}'`);
      }
    }

    // Longer prefix first — /32 wins over /24
    parsed.sort((a, b) => b.prefixLen - a.prefixLen);
    this.entries = parsed;
  }

  resolve(ipStr: string): HostPolicy | null {
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      addr = ipaddr.parse(ipStr);
    } catch {
      return null;
    }

    for (const entry of this.entries) {
      try {
        if (
          addr.match([entry.network, entry.prefixLen] as Parameters<
            typeof addr.match
          >[0])
        ) {
          return entry.policy;
        }
      } catch {
        // address family mismatch — skip
        continue;
      }
    }

    return null;
  }
}

interface RawHost {
  id: string;
  cidrs: string[];
  can_call_sensitive?: boolean;
  can_trade?: boolean;
  description?: string;
  auth_token_env?: string;
}

interface RawHostsYaml {
  hosts?: RawHost[];
}

export function loadHostsFromYaml(yamlText: string, env: AppEnv): HostResolver {
  const data = yaml.load(yamlText) as RawHostsYaml;
  const entries: Array<{ cidr: string; policy: HostPolicy }> = [];

  for (const host of data.hosts ?? []) {
    let canSensitive: boolean;

    if (host.can_call_sensitive !== undefined) {
      canSensitive = host.can_call_sensitive;
    } else if (host.can_trade !== undefined) {
      // Back-compat: legacy key — log warning
      console.warn(
        `hosts.yaml: host '${host.id}' uses deprecated 'can_trade' key; use 'can_call_sensitive'`,
      );
      canSensitive = host.can_trade;
    } else {
      canSensitive = false;
    }

    // Resolve PSK from env var at load time so missing vars fail fast at startup.
    const tokenEnv = host.auth_token_env;
    let authToken: string | undefined = undefined;
    if (tokenEnv) {
      const resolved = env[tokenEnv];
      if (typeof resolved !== "string" || resolved.length === 0) {
        throw new Error(
          `hosts.yaml: host '${host.id}' requires PSK via env var '${tokenEnv}' but it is unset or empty.`,
        );
      }
      authToken = resolved;
      console.info(
        `hosts.yaml: host '${host.id}' configured with PSK from ${tokenEnv}`,
      );
    }

    const policy: HostPolicy = {
      id: host.id,
      canCallSensitive: canSensitive,
      description: host.description,
      authToken,
    };

    for (const cidr of host.cidrs ?? []) {
      entries.push({ cidr, policy });
    }
  }

  return new HostResolver(entries);
}
