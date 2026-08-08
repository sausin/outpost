/**
 * First-boot config seeding (Node only).
 *
 * When Outpost is installed from an app catalog (TrueNAS, Unraid, …) the config
 * volume starts out empty and the operator has no repo checkout to copy files
 * from. Staring at an empty dataset is a bad first five minutes, so on boot we
 * drop two heavily-commented starter files in place:
 *
 *   <providers dir>/example.yaml   — a complete provider definition, DISABLED
 *   <hosts file>                   — a policy allowing localhost only
 *
 * Rules that keep this safe:
 *   - Never overwrite. A file that already exists is left strictly alone.
 *   - Never fail the boot. A read-only mount, a missing parent, a wrong owner
 *     — all of it is logged and swallowed; the proxy still comes up (with zero
 *     providers, which /healthz reports as healthy by design).
 *   - Set OUTPOST_SEED_CONFIG=false to switch the whole thing off.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const STARTER_HOSTS_YAML = `# Outpost host policy — who may talk to this proxy, and how much they may do.
#
# Lookup is by source IP, longest-prefix CIDR match. An IP that matches no
# entry gets 403 PROXY_HOST_DENIED, so this file is your allowlist.
#
# Per-entry knobs:
#   cidrs              — CIDR block(s) this entry covers
#   can_call_sensitive — must be true to invoke endpoints the provider YAML
#                        flags as sensitive (writes, trades, deletes)
#   auth_token_env     — OPTIONAL but STRONGLY recommended for anything that
#                        is not localhost. Names an environment variable whose
#                        value the caller must present as
#                        \`X-Outpost-Auth: <token>\`. Generate one with
#                        \`openssl rand -hex 32\` and set it as an additional
#                        environment variable on the app.
#
# After editing, restart Outpost — this file is read once at startup.

hosts:
  - id: localhost
    cidrs: ["127.0.0.1/32", "::1/128"]
    can_call_sensitive: true
    description: "Loopback — same host as the proxy"

  # Example: an agent elsewhere on your LAN. IP allowlisting alone is weak on a
  # flat home network, so this one also demands a pre-shared key.
  # - id: lan-agent
  #   cidrs: ["192.168.1.0/24"]
  #   can_call_sensitive: false
  #   description: "Agents on the LAN — read-only"
  #   auth_token_env: LAN_AGENT_TOKEN
`;

export const EXAMPLE_PROVIDER_YAML = `# Example Outpost provider — DISABLED. Copy this file, edit it, flip
# \`enabled: true\`, and restart Outpost to make the provider live.
#
# What a provider does: it maps one upstream REST API onto this proxy. Agents
# call the proxy with \`X-Provider: <name>\` and the path they want; Outpost
# injects the credential and forwards. The agent never sees the secret.
#
# Every file matching *.yaml / *.yml in the providers directory is loaded.

name: example
enabled: false
base_url: https://api.example.com
description: "Starter template — rename, point at a real API, enable."

auth:
  # The credential is read from this environment variable at startup. Set it as
  # an additional environment variable on the app — never inline it here.
  # Other auth types: api_key_header, api_key_query, basic_auth, custom_headers,
  # oauth2_client_credentials, hmac_signed, bearer_redis, plugin, none.
  type: bearer_static
  env: EXAMPLE_API_KEY

forwarding:
  # transparent = forward every path that isn't denied.
  # allowlist   = forward ONLY the paths listed under \`allow\` (recommended for
  #               anything reachable from outside this machine).
  mode: transparent

  # Paths the proxy refuses outright, whatever the caller's host policy says.
  deny:
    - "/v1/admin/**"

  # Writes count as sensitive by default, so they need a host with
  # \`can_call_sensitive: true\` in hosts.yaml.
  treat_writes_as_sensitive: true

  # Seconds to cache GET responses (0 = no caching).
  default_cache_ttl: 0

  rate_limits:
    default:
      - { capacity: 50, window_ms: 1000 }
      - { capacity: 500, window_ms: 60000 }

  # In allowlist mode, each rule opts one route in:
  # allow:
  #   - { method: GET, pattern: "/v1/things/**", cache_ttl: 30 }
  #   - { method: POST, pattern: "/v1/things", sensitive: true }
`;

async function writeIfAbsent(file: string, content: string): Promise<boolean> {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    // wx = create-or-fail. Atomic, so two replicas racing on a shared volume
    // can't clobber each other or produce a half-written file.
    await writeFile(file, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

/** True when `dir` holds no *.yaml / *.yml at all (missing dir counts as empty). */
async function hasNoProviderYaml(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return !entries.some((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return true;
  }
}

export interface SeedTargets {
  providersDir: string;
  hostsFile: string;
}

/**
 * Seed the config volume if it looks untouched. Returns the files created —
 * empty when there was nothing to do or the volume is not writable.
 */
export async function seedConfig(targets: SeedTargets): Promise<string[]> {
  if (process.env["OUTPOST_SEED_CONFIG"] === "false") {
    console.info("[seed] OUTPOST_SEED_CONFIG=false — skipping config seeding");
    return [];
  }

  const created: string[] = [];

  try {
    if (await writeIfAbsent(targets.hostsFile, STARTER_HOSTS_YAML)) {
      created.push(targets.hostsFile);
    }
  } catch (err) {
    console.warn(`[seed] Could not write ${targets.hostsFile}: ${err}`);
  }

  try {
    // Only seed the example when the directory has no provider at all —
    // otherwise a user who deleted example.yaml would get it back every boot.
    if (await hasNoProviderYaml(targets.providersDir)) {
      const example = path.join(targets.providersDir, "example.yaml");
      if (await writeIfAbsent(example, EXAMPLE_PROVIDER_YAML)) {
        created.push(example);
      }
    }
  } catch (err) {
    console.warn(
      `[seed] Could not seed example provider in ${targets.providersDir}: ${err}`,
    );
  }

  if (created.length > 0) {
    console.info(`[seed] Wrote starter config: ${created.join(", ")}`);
  }

  return created;
}
