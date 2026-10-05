import { describe, test, expect, vi, afterEach } from "vitest";

import { buildAppDeps } from "../../src/bootstrap.ts";
import {
  inlineProviderSources,
  parseInlineHosts,
} from "../../src/config/inline.ts";
import { envFromWorkers } from "../../src/core/env.ts";
import { loadHostsFromYaml } from "../../src/core/hosts.ts";
import {
  loadProvidersFromYamls,
  withInlineProviders,
} from "../../src/providers/loader.ts";
import type {
  CacheBackend,
  RateLimitBackend,
} from "../../src/storage/interface.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";

afterEach(() => vi.restoreAllMocks());

function quiet(): void {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("env", () => {
  test("OUTPOST_HOSTS / OUTPOST_PROVIDERS are read, empty when unset", () => {
    expect(envFromWorkers({}).HOSTS_INLINE).toBe("");
    expect(envFromWorkers({}).PROVIDERS_INLINE).toBe("");
    const env = envFromWorkers({ OUTPOST_HOSTS: "[]", OUTPOST_PROVIDERS: "x" });
    expect(env.HOSTS_INLINE).toBe("[]");
    expect(env.PROVIDERS_INLINE).toBe("x");
  });
});

describe("parseInlineHosts", () => {
  test("unset or blank means no entries", () => {
    expect(parseInlineHosts(undefined)).toEqual([]);
    expect(parseInlineHosts("  \n")).toEqual([]);
    expect(parseInlineHosts("hosts:")).toEqual([]);
  });

  test("accepts a bare JSON list, as the TrueNAS form renders it", () => {
    const hosts = parseInlineHosts(
      JSON.stringify([
        {
          id: "lan",
          cidrs: ["192.168.1.0/24"],
          can_call_sensitive: false,
          auth_token_env: "OUTPOST_HOST_LAN_PSK",
          description: "",
        },
      ]),
    );
    expect(hosts).toEqual([
      {
        id: "lan",
        cidrs: ["192.168.1.0/24"],
        can_call_sensitive: false,
        auth_token_env: "OUTPOST_HOST_LAN_PSK",
      },
    ]);
  });

  test("accepts a pasted hosts.yaml and a comma-separated cidrs string", () => {
    const hosts = parseInlineHosts(`
hosts:
  - id: agents
    cidrs: "10.0.0.5, 10.0.0.0/24  ::1"
`);
    expect(hosts[0].cidrs).toEqual(["10.0.0.5", "10.0.0.0/24", "::1"]);
  });

  test.each([
    ["not yaml: [", /not valid YAML/],
    ['"just a string"', /must be a list/],
    ["- cidrs: [10.0.0.0/8]", /needs an 'id'/],
    ["- id: a\n  cidrs: []", /at least one address/],
    ["- id: a\n  cidrs: [10.0.0.1]\n- id: a\n  cidrs: [10.0.0.2]", /more than once/],
    ["- id: a\n  cidrs: [10.0.0.1]\n  can_call_sensitive: 'yes'", /true or false/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseInlineHosts(raw)).toThrow(message);
  });
});

describe("loadHostsFromYaml with inline hosts", () => {
  const FILE = `
hosts:
  - id: localhost
    cidrs: ["127.0.0.1/32"]
  - id: lan
    cidrs: ["192.168.1.0/24"]
    can_call_sensitive: true
`;

  test("inline entries are added, win on id, and carry their source", () => {
    quiet();
    const r = loadHostsFromYaml(FILE, envFromWorkers({ PSK: "s3cret" }), {
      fileSource: "/config/hosts.yaml",
      inline: parseInlineHosts(
        JSON.stringify([
          { id: "lan", cidrs: ["192.168.1.0/24"], auth_token_env: "PSK" },
          { id: "docker", cidrs: ["172.16.0.0/12"] },
        ]),
      ),
      inlineSource: "OUTPOST_HOSTS",
    });

    expect(r.describe().map((h) => [h.id, h.source])).toEqual([
      ["localhost", "/config/hosts.yaml"],
      ["lan", "OUTPOST_HOSTS"],
      ["docker", "OUTPOST_HOSTS"],
    ]);
    // The file's "lan" (sensitive allowed, no PSK) is gone entirely.
    const lan = r.resolve("192.168.1.9");
    expect(lan?.canCallSensitive).toBe(false);
    expect(lan?.authToken).toBe("s3cret");
    expect(r.resolve("172.17.0.2")?.id).toBe("docker");
    expect(r.resolve("127.0.0.1")?.id).toBe("localhost");
  });

  test("an inline host naming an unset PSK variable fails like hosts.yaml", () => {
    expect(() =>
      loadHostsFromYaml("hosts: []", envFromWorkers({}), {
        inline: [{ id: "x", cidrs: ["10.0.0.1"], auth_token_env: "NOPE" }],
        inlineSource: "OUTPOST_HOSTS",
      }),
    ).toThrow(/OUTPOST_HOSTS: host 'x' requires PSK via env var 'NOPE'/);
  });

  test("a bare address is a single host; an invalid one is reported", () => {
    quiet();
    const r = loadHostsFromYaml(
      `
hosts:
  - id: one
    cidrs: ["192.168.1.50", "fe80::1", "not-an-ip"]
`,
      envFromWorkers({}),
      { fileSource: "hosts.yaml" },
    );
    expect(r.resolve("192.168.1.50")?.id).toBe("one");
    expect(r.resolve("192.168.1.51")).toBeNull();
    expect(r.resolve("fe80::1")?.id).toBe("one");
    expect(r.problems).toEqual([
      {
        scope: "hosts",
        source: "hosts.yaml",
        message: expect.stringContaining("'not-an-ip' is not a valid"),
      },
    ]);
  });
});

describe("withInlineProviders", () => {
  const files = () =>
    loadProvidersFromYamls([
      {
        name: "github.yaml",
        content:
          "name: github\nbase_url: https://api.github.com\nauth: { type: none }",
      },
      {
        name: "stripe.yaml",
        content:
          "name: stripe\nbase_url: https://api.stripe.com\nauth: { type: none }",
      },
    ]);

  test("unset leaves the file result untouched", async () => {
    quiet();
    const base = await files();
    expect(await withInlineProviders(base, undefined)).toBe(base);
    expect(await withInlineProviders(base, "  ")).toBe(base);
  });

  test("adds, overrides and disables by name, recording each source", async () => {
    quiet();
    const merged = await withInlineProviders(
      await files(),
      JSON.stringify([
        {
          name: "github",
          base_url: "https://ghe.example.com/api/v3",
          auth: { type: "bearer_static", env: "GH" },
        },
        { name: "stripe", base_url: "https://x.test", enabled: false, auth: { type: "none" } }, // prettier-ignore
        "name: openai\nbase_url: https://api.openai.com\nauth: { type: none }",
      ]),
    );

    expect([...merged.providers.keys()].sort()).toEqual(["github", "openai"]);
    expect(merged.providers.get("github")?.base_url).toBe(
      "https://ghe.example.com/api/v3",
    );
    expect(merged.sources.get("github")).toBe("OUTPOST_PROVIDERS · github");
    expect(merged.sources.get("openai")).toBe("OUTPOST_PROVIDERS #3");
    expect(merged.disabled).toEqual([
      { name: "stripe", source: "OUTPOST_PROVIDERS · stripe" },
    ]);
    expect(merged.problems).toEqual([]);
  });

  test("a bad entry is reported and the rest still load", async () => {
    quiet();
    const merged = await withInlineProviders(
      await files(),
      JSON.stringify([
        { name: "broken", base_url: "not a url", auth: { type: "none" } },
        42,
        { name: "ok", base_url: "https://ok.test", auth: { type: "none" } },
      ]),
    );
    expect(merged.providers.has("ok")).toBe(true);
    expect(merged.providers.has("github")).toBe(true);
    expect(merged.problems.map((p) => p.source).sort()).toEqual([
      "OUTPOST_PROVIDERS #2",
      "OUTPOST_PROVIDERS · broken",
    ]);
  });

  test("an unparseable variable is one problem, files still load", async () => {
    quiet();
    const merged = await withInlineProviders(await files(), "{oops");
    expect(merged.providers.size).toBe(2);
    expect(merged.problems).toEqual([
      expect.objectContaining({ source: "OUTPOST_PROVIDERS" }),
    ]);
  });

  test("auth as YAML text and extra merged over the entry", async () => {
    quiet();
    const merged = await withInlineProviders(
      await files(),
      JSON.stringify([
        {
          name: "oauthy",
          base_url: "https://api.oauthy.test",
          auth: "type: oauth2_client_credentials\ntoken_url: https://id.test/token\nclient_id_env: ID\nclient_secret_env: SECRET\n",
          forwarding: {
            mode: "allowlist",
            allow: [{ method: "GET", pattern: "/v1/**" }],
          },
          extra:
            "default_headers: {Accept: application/json}\nforwarding:\n  rate_limits:\n    default: [{capacity: 5, window_ms: 1000}]\n",
        },
      ]),
    );
    const def = merged.providers.get("oauthy")!;
    expect(def.auth).toMatchObject({
      type: "oauth2_client_credentials",
      client_id_env: "ID",
    });
    expect(def.default_headers).toEqual({ Accept: "application/json" });
    expect(def.forwarding.mode).toBe("allowlist");
    expect(def.forwarding.allow).toHaveLength(1);
    expect(def.forwarding.rate_limits).toEqual({
      default: [{ capacity: 5, window_ms: 1000 }],
    });
  });

  test("bad auth / extra YAML is a problem on that provider only", () => {
    const { sources, problems } = inlineProviderSources(
      JSON.stringify([
        { name: "a", base_url: "https://a.test", auth: "type: [" },
        { name: "b", base_url: "https://b.test", auth: { type: "none" }, extra: "- 1" }, // prettier-ignore
        { name: "c", base_url: "https://c.test", auth: { type: "none" } },
      ]),
    );
    expect(sources.map((s) => s.name)).toEqual(["OUTPOST_PROVIDERS · c"]);
    expect(problems.map((p) => p.message)).toEqual([
      expect.stringContaining("auth is not valid YAML"),
      "extra must be a YAML mapping",
    ]);
  });

  test("a single mapping is accepted as shorthand", () => {
    const { sources } = inlineProviderSources(
      "name: one\nbase_url: https://one.test\nauth: { type: none }",
    );
    expect(sources).toHaveLength(1);
  });
});

describe("buildAppDeps with OUTPOST_HOSTS", () => {
  const cache: CacheBackend = { get: async () => null, put: async () => {} };
  const rateLimits: RateLimitBackend = {
    acquire: async () => {},
    noteUpstream429: async () => {},
    cooldownRemainingMs: async () => 0,
  };
  const build = (env: Record<string, string>) =>
    buildAppDeps({
      env: envFromWorkers(env),
      defs: new Map(),
      hostsYaml: "hosts: []",
      hostsSource: "hosts.yaml",
      tokenStorage: new InMemoryStorage(),
      cache,
      rateLimits,
    });

  test("hosts from the environment alone are a complete policy", async () => {
    quiet();
    const deps = await build({
      OUTPOST_HOSTS: '[{"id":"lan","cidrs":["192.168.0.0/16"]}]',
    });
    expect(deps.hosts.resolve("192.168.4.4")?.id).toBe("lan");
  });

  test("a malformed OUTPOST_HOSTS refuses to build", async () => {
    await expect(build({ OUTPOST_HOSTS: '[{"id":"lan"}]' })).rejects.toThrow(
      /at least one address/,
    );
  });

  test("invalid CIDRs surface as dashboard problems", async () => {
    quiet();
    const deps = await build({
      OUTPOST_HOSTS: '[{"id":"lan","cidrs":["192.168.0.0/99"]}]',
    });
    expect(deps.problems).toEqual([
      expect.objectContaining({ scope: "hosts", source: "OUTPOST_HOSTS" }),
    ]);
  });
});
