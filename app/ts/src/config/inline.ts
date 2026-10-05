/**
 * Inline configuration — the host policy and provider definitions passed as
 * environment variables instead of (or on top of) files.
 *
 *   OUTPOST_HOSTS      same content as hosts.yaml
 *   OUTPOST_PROVIDERS  a list of provider definitions
 *
 * This is what lets an app catalog form (TrueNAS) configure Outpost entirely
 * from its UI, the way the Traefik app turns its form into CLI flags: the
 * template serialises the form to JSON (which is YAML) and sets these two
 * variables. Plain Docker users can write YAML into them just as well.
 *
 * Both are purely additive. Unset, Outpost behaves exactly as before — the
 * mounted hosts.yaml and providers/ are the whole configuration. Set, their
 * entries are merged with the files and win on a name clash: an inline host
 * replaces a hosts.yaml entry with the same `id`, an inline provider replaces
 * a providers/*.yaml with the same `name`.
 *
 * A provider entry may also give `auth` as a YAML string, and an `extra` YAML
 * string merged over the entry — that is how a form with a free-text box
 * reaches the parts of the schema it has no dedicated fields for (OAuth2,
 * HMAC, plugins, rate limits, default headers).
 *
 * Neither variable carries a secret. Credentials and pre-shared keys stay in
 * their own environment variables, referenced by name, exactly as in the files
 * — so the status page can keep showing "set / unset" without ever reading a
 * value.
 */

import yaml from "js-yaml";

import type { RawHost } from "../core/hosts.ts";
import type { ConfigProblem } from "../core/types.ts";

export const HOSTS_VAR = "OUTPOST_HOSTS";
export const PROVIDERS_VAR = "OUTPOST_PROVIDERS";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The list held by an inline variable: either a bare list, or a mapping with
 * the list under `key` (so a hosts.yaml can be pasted in unchanged).
 * Empty / whitespace-only → []. Throws on anything else.
 */
function parseList(
  raw: string | undefined,
  varName: string,
  key: string,
): unknown[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  let data: unknown;
  try {
    data = yaml.load(raw);
  } catch (err) {
    throw new Error(
      `${varName} is not valid YAML/JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data === null || data === undefined) return [];
  if (Array.isArray(data)) return data;
  if (isRecord(data) && key in data) {
    const list = data[key];
    if (list === null || list === undefined) return [];
    if (Array.isArray(list)) return list;
    throw new Error(`${varName}: '${key}' must be a list`);
  }
  // A single provider mapping is a common enough shorthand to accept.
  if (isRecord(data) && key === "providers" && "name" in data) return [data];
  throw new Error(
    `${varName} must be a list, or a mapping with a '${key}:' list`,
  );
}

/** Split "10.0.0.0/8, 192.168.1.5" or accept a list as-is. */
function cidrList(value: unknown): string[] | null {
  if (typeof value === "string") {
    return value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    return (value as string[]).map((s) => s.trim()).filter((s) => s.length);
  }
  return null;
}

/**
 * Parse OUTPOST_HOSTS into hosts.yaml entries. Strict: a malformed entry
 * throws, because a host policy that silently drops an entry is a policy the
 * user did not write. At boot that is fatal (like a bad hosts.yaml); on a
 * reload the previous policy stays in force.
 */
export function parseInlineHosts(raw: string | undefined): RawHost[] {
  const list = parseList(raw, HOSTS_VAR, "hosts");
  const seen = new Set<string>();
  return list.map((item, i) => {
    const where = `${HOSTS_VAR} entry #${i + 1}`;
    if (!isRecord(item)) throw new Error(`${where} must be a mapping`);

    const id = item["id"];
    if (typeof id !== "string" || id.trim() === "") {
      throw new Error(`${where} needs an 'id'`);
    }
    if (seen.has(id)) {
      throw new Error(`${HOSTS_VAR}: host id '${id}' appears more than once`);
    }
    seen.add(id);

    const cidrs = cidrList(item["cidrs"]);
    if (!cidrs || cidrs.length === 0) {
      throw new Error(
        `${HOSTS_VAR}: host '${id}' needs at least one address in 'cidrs'`,
      );
    }

    const sensitive = item["can_call_sensitive"];
    if (sensitive !== undefined && typeof sensitive !== "boolean") {
      throw new Error(
        `${HOSTS_VAR}: host '${id}': 'can_call_sensitive' must be true or false`,
      );
    }

    for (const key of ["auth_token_env", "description"] as const) {
      const v = item[key];
      if (v !== undefined && v !== null && typeof v !== "string") {
        throw new Error(
          `${HOSTS_VAR}: host '${id}': '${key}' must be a string`,
        );
      }
    }

    const host: RawHost = { id, cidrs };
    if (sensitive !== undefined) host.can_call_sensitive = sensitive;
    if (typeof item["description"] === "string" && item["description"]) {
      host.description = item["description"];
    }
    if (typeof item["auth_token_env"] === "string" && item["auth_token_env"]) {
      host.auth_token_env = item["auth_token_env"];
    }
    return host;
  });
}

/** Parse a YAML string that must hold a mapping (an `auth` or `extra` block). */
function yamlMapping(text: string, what: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  let data: unknown;
  try {
    data = yaml.load(text);
  } catch (err) {
    throw new Error(
      `${what} is not valid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (data === null || data === undefined) return {};
  if (!isRecord(data)) throw new Error(`${what} must be a YAML mapping`);
  return data;
}

/**
 * Expand the string-valued conveniences of an inline provider entry:
 * `auth` as YAML text, and `extra` merged over the entry (mappings one level
 * deep, so `extra: "forwarding: {rate_limits: …}"` keeps the entry's
 * forwarding mode and rules).
 */
function expandProvider(
  item: Record<string, unknown>,
): Record<string, unknown> {
  const { extra, ...rest } = item;
  const out: Record<string, unknown> = { ...rest };
  if (typeof out["auth"] === "string") {
    out["auth"] = yamlMapping(out["auth"], "auth");
  }
  if (typeof extra === "string") {
    for (const [key, value] of Object.entries(yamlMapping(extra, "extra"))) {
      const current = out[key];
      out[key] =
        isRecord(current) && isRecord(value) ? { ...current, ...value } : value;
    }
  } else if (extra !== undefined && extra !== null) {
    throw new Error("extra must be a YAML string");
  }
  return out;
}

/**
 * Turn OUTPOST_PROVIDERS into loader sources. Forgiving, like the providers
 * directory: an unparseable variable or a bad entry is reported and skipped,
 * and every other provider still loads. Each list item is either a provider
 * mapping or a string holding a provider YAML document.
 */
export function inlineProviderSources(raw: string | undefined): {
  sources: Array<{ name: string; content: string }>;
  problems: ConfigProblem[];
} {
  let list: unknown[];
  try {
    list = parseList(raw, PROVIDERS_VAR, "providers");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      sources: [],
      problems: [{ scope: "provider", source: PROVIDERS_VAR, message }],
    };
  }

  const sources: Array<{ name: string; content: string }> = [];
  const problems: ConfigProblem[] = [];
  list.forEach((item, i) => {
    const label =
      isRecord(item) && typeof item["name"] === "string"
        ? `${PROVIDERS_VAR} · ${item["name"]}`
        : `${PROVIDERS_VAR} #${i + 1}`;
    if (typeof item === "string") {
      sources.push({ name: `${PROVIDERS_VAR} #${i + 1}`, content: item });
    } else if (isRecord(item)) {
      try {
        // JSON is YAML, so the loader takes it as-is.
        sources.push({
          name: label,
          content: JSON.stringify(expandProvider(item)),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        problems.push({ scope: "provider", source: label, message });
      }
    } else {
      problems.push({
        scope: "provider",
        source: label,
        message: "must be a provider mapping or a YAML string",
      });
    }
  });
  return { sources, problems };
}
