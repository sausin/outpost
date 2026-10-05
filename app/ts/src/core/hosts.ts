/**
 * Host policy: load hosts.yaml, resolve client IP → host policy via
 * longest-prefix CIDR match — mirrors app/core/hosts.py
 */

// Default import, NOT `import * as`: ipaddr.js is CommonJS, so under real ESM
// (the bundled Node build) the namespace object has only a `default` key and
// every named access is undefined — which silently turned every CIDR in
// hosts.yaml into "invalid" and 403'd all traffic. Vitest's CJS interop hides
// the difference, so the unit tests passed either way.
import ipaddr from "ipaddr.js";
import yaml from "js-yaml";
import type { AppEnv } from "./env.ts";
import type { ConfigProblem } from "./types.ts";

export interface HostPolicy {
  id: string;
  canCallSensitive: boolean;
  description?: string;
  /** Resolved PSK value (from the env var named in YAML), or undefined if no auth required. */
  authToken?: string;
  /** Name of the env var the PSK came from — safe to display; the value never is. */
  authTokenEnv?: string;
  /** Where the entry was defined: the hosts.yaml path or OUTPOST_HOSTS. */
  source?: string;
}

/**
 * One `hosts:` entry as the status page shows it. Deliberately a separate
 * shape from HostPolicy so the PSK value cannot end up in it by accident.
 */
export interface HostDescription {
  id: string;
  cidrs: string[];
  canCallSensitive: boolean;
  description?: string;
  /** Env var naming the PSK, or null when the host needs none. */
  authTokenEnv: string | null;
  /** Where the entry was defined, when known. */
  source?: string;
}

/**
 * "10.0.0.0/8" → network + prefix; a bare address ("192.168.1.50", "::1") is
 * that single host (/32 or /128), the same as the Python runtime's
 * ip_network() accepts.
 */
function parseCidrOrAddress(
  value: string,
): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  if (value.includes("/")) return ipaddr.parseCIDR(value);
  const addr = ipaddr.parse(value);
  return [addr, addr.kind() === "ipv6" ? 128 : 32];
}

interface CidrEntry {
  network: ipaddr.IPv4 | ipaddr.IPv6;
  prefixLen: number;
  isV6: boolean;
  policy: HostPolicy;
}

export class HostResolver {
  private readonly entries: CidrEntry[];
  private readonly descriptions: HostDescription[];
  /** Entries that could not be applied (invalid CIDRs) — shown on /dashboard. */
  readonly problems: ConfigProblem[] = [];

  constructor(entries: Array<{ cidr: string; policy: HostPolicy }>) {
    const parsed: CidrEntry[] = [];

    // Group by policy object (one per hosts.yaml entry), in file order.
    const byPolicy = new Map<HostPolicy, HostDescription>();
    for (const { cidr, policy } of entries) {
      let d = byPolicy.get(policy);
      if (!d) {
        d = {
          id: policy.id,
          cidrs: [],
          canCallSensitive: policy.canCallSensitive,
          description: policy.description,
          authTokenEnv: policy.authTokenEnv ?? null,
          source: policy.source,
        };
        byPolicy.set(policy, d);
      }
      d.cidrs.push(cidr);
    }
    this.descriptions = [...byPolicy.values()];

    for (const { cidr, policy } of entries) {
      try {
        const [addr, prefixLen] = parseCidrOrAddress(cidr);
        parsed.push({
          network: addr,
          prefixLen,
          isV6: addr.kind() === "ipv6",
          policy,
        });
      } catch {
        console.warn(`HostResolver: skipping invalid CIDR '${cidr}'`);
        this.problems.push({
          scope: "hosts",
          source: policy.source,
          message: `host '${policy.id}': '${cidr}' is not a valid IP address or CIDR — ignored`,
        });
      }
    }

    // Longer prefix first — /32 wins over /24
    parsed.sort((a, b) => b.prefixLen - a.prefixLen);
    this.entries = parsed;
  }

  /** Every host entry, in hosts.yaml order, with the PSK value omitted. */
  describe(): HostDescription[] {
    return this.descriptions.map((d) => ({ ...d, cidrs: [...d.cidrs] }));
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

/** One `hosts:` entry as written in hosts.yaml / OUTPOST_HOSTS. */
export interface RawHost {
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

export interface LoadHostsOptions {
  /** Label for entries from `yamlText` (shown on the dashboard). */
  fileSource?: string;
  /**
   * Entries from OUTPOST_HOSTS, already parsed. They are added after the file's
   * and replace any file entry with the same `id`.
   */
  inline?: RawHost[];
  /** Label for the inline entries. */
  inlineSource?: string;
}

export function loadHostsFromYaml(
  yamlText: string,
  env: AppEnv,
  opts: LoadHostsOptions = {},
): HostResolver {
  const data = (yaml.load(yamlText) ?? {}) as RawHostsYaml;
  const inline = opts.inline ?? [];
  const inlineIds = new Set(inline.map((h) => h.id));

  const fileHosts = (data.hosts ?? []).filter((h) => {
    if (!inlineIds.has(h.id)) return true;
    console.info(
      `hosts: entry '${h.id}' from ${opts.fileSource ?? "hosts.yaml"} is replaced by ${opts.inlineSource ?? "OUTPOST_HOSTS"}`,
    );
    return false;
  });

  const entries: Array<{ cidr: string; policy: HostPolicy }> = [];
  const add = (hosts: RawHost[], source: string | undefined): void => {
    for (const host of hosts) {
      const policy = toPolicy(host, env, source);
      for (const cidr of host.cidrs ?? []) entries.push({ cidr, policy });
    }
  };
  add(fileHosts, opts.fileSource);
  add(inline, opts.inlineSource);

  return new HostResolver(entries);
}

function toPolicy(
  host: RawHost,
  env: AppEnv,
  source: string | undefined,
): HostPolicy {
  const where = source ?? "hosts.yaml";
  let canSensitive: boolean;

  if (host.can_call_sensitive !== undefined) {
    canSensitive = host.can_call_sensitive;
  } else if (host.can_trade !== undefined) {
    // Back-compat: legacy key — log warning
    console.warn(
      `${where}: host '${host.id}' uses deprecated 'can_trade' key; use 'can_call_sensitive'`,
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
        `${where}: host '${host.id}' requires PSK via env var '${tokenEnv}' but it is unset or empty.`,
      );
    }
    authToken = resolved;
    console.info(
      `${where}: host '${host.id}' configured with PSK from ${tokenEnv}`,
    );
  }

  return {
    id: host.id,
    canCallSensitive: canSensitive,
    description: host.description,
    authToken,
    authTokenEnv: tokenEnv || undefined,
    source,
  };
}
