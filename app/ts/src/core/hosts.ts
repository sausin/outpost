/**
 * Host policy: load hosts.yaml, resolve client IP → host policy via
 * longest-prefix CIDR match — mirrors app/core/hosts.py
 */

import * as ipaddr from "ipaddr.js";
import yaml from "js-yaml";

export interface HostPolicy {
  id: string;
  canCallSensitive: boolean;
  description?: string;
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
}

interface RawHostsYaml {
  hosts?: RawHost[];
}

export function loadHostsFromYaml(yamlText: string): HostResolver {
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

    const policy: HostPolicy = {
      id: host.id,
      canCallSensitive: canSensitive,
      description: host.description,
    };

    for (const cidr of host.cidrs ?? []) {
      entries.push({ cidr, policy });
    }
  }

  return new HostResolver(entries);
}
