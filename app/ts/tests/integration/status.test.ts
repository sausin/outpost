import { describe, test, expect } from "vitest";
import type { Context } from "hono";

import { buildAppDeps } from "../../src/bootstrap.ts";
import { envFromWorkers } from "../../src/core/env.ts";
import { buildApp } from "../../src/index.ts";
import type { AppDeps } from "../../src/index.ts";
import { ProviderSchema } from "../../src/providers/schema.ts";
import type { ProviderDef } from "../../src/providers/schema.ts";
import { credentialEnvNames } from "../../src/status.ts";
import type { Overview, StatusSource } from "../../src/status.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { CacheBackend, RateLimitBackend } from "../../src/storage/interface.ts"; // prettier-ignore

// Every secret in this file carries this marker; the redaction test greps for it.
const SECRET = "SEKRIT-";

const ENV = {
  STRIPE_KEY: `${SECRET}sk_live_abc`,
  HMAC_ID: "AKIA-not-secret-id",
  HMAC_SECRET: `${SECRET}hmac`,
  LAN_AGENT_TOKEN: `${SECRET}psk`,
};

const HOSTS_YAML = `
hosts:
  - id: localhost
    cidrs: ["127.0.0.1/32", "::1/128"]
    can_call_sensitive: true
    description: "Loopback"
  - id: lan-agent
    cidrs: ["192.168.1.0/24"]
    can_call_sensitive: false
    auth_token_env: LAN_AGENT_TOKEN
`;

const STRIPE = ProviderSchema.parse({
  name: "stripe",
  base_url: "https://api.stripe.com",
  description: "Payments",
  auth: { type: "bearer_static", env: "STRIPE_KEY" },
  forwarding: {
    mode: "allowlist",
    allow: [{ method: "GET", pattern: "/v1/charges/**", cache_ttl: 30 }],
    deny: ["/v1/admin/**"],
  },
});

const SIGNED = ProviderSchema.parse({
  name: "signed",
  base_url: "https://api.example.com",
  auth: {
    type: "hmac_signed",
    key_env: "HMAC_ID",
    secret_env: "HMAC_SECRET",
    algorithm: "sha256",
    header: "X-Signature",
  },
});

const noopCache: CacheBackend = { get: async () => null, put: async () => {} };
const noopRateLimits: RateLimitBackend = {
  acquire: async () => {},
  noteUpstream429: async () => {},
  cooldownRemainingMs: async () => 0,
};

async function depsWith(
  defs: Map<string, ProviderDef>,
  extra: Partial<AppDeps> = {},
  peer = "127.0.0.1",
): Promise<AppDeps> {
  const env = envFromWorkers(ENV);
  const deps = await buildAppDeps({
    env,
    defs,
    hostsYaml: HOSTS_YAML,
    tokenStorage: new InMemoryStorage(),
    cache: noopCache,
    rateLimits: noopRateLimits,
    // Stand-in for the socket peer.
    resolveClientIp: (_c: Context) => peer,
  });
  const status: StatusSource = {
    version: "1.2.3",
    runtime: "node",
    startedAt: Date.now() - 65_000,
    config: {
      providersDir: "/config/providers",
      hostsFile: "/config/hosts.yaml",
      watch: true,
      loadedAt: Date.now(),
      reloads: 2,
    },
    credentialSet: (name) => typeof ENV[name as keyof typeof ENV] === "string",
    storage: async () => ({ ok: true, detail: "Redis PONG in 1 ms" }),
  };
  return { ...deps, status, ...extra };
}

async function overview(app: ReturnType<typeof buildApp>): Promise<Overview> {
  const res = await app.request("/api/overview");
  expect(res.status).toBe(200);
  return (await res.json()) as Overview;
}

describe("credentialEnvNames", () => {
  test("collects env-style keys at any depth and nothing else", () => {
    const names = credentialEnvNames({
      type: "plugin",
      module: "plugins/x.ts:X",
      config: {
        api_key_env: "K",
        api_secret_env: "S",
        mint_path: "/v1/token",
        nested: { headers: { "X-A": { env: "H" }, "X-B": { value: "lit" } } },
      },
      env_seed: "SEED",
      value: "inline-secret-must-not-appear",
      redis_key: "not-an-env",
    });
    expect(names).toEqual(["K", "S", "H", "SEED"]);
  });
});

describe("/api/overview", () => {
  test("describes providers, hosts and the viewer without leaking a value", async () => {
    const app = buildApp(
      await depsWith(
        new Map([
          ["stripe", STRIPE],
          ["signed", SIGNED],
        ]),
      ),
    );
    const res = await app.request("/api/overview");
    const raw = await res.text();

    // The whole point: no credential or PSK value anywhere in the document.
    expect(raw).not.toContain(SECRET);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const o = JSON.parse(raw) as Overview;
    expect(o.status).toBe("ok");
    expect(o.version).toBe("1.2.3");
    expect(o.uptime_seconds).toBeGreaterThanOrEqual(65);
    expect(o.config.watch).toBe(true);
    expect(o.config.reloads).toBe(2);
    expect(o.storage).toEqual({ ok: true, detail: "Redis PONG in 1 ms" });

    // Providers sorted by name, credentials by env NAME with a set flag.
    expect(o.providers.map((p) => p.name)).toEqual(["signed", "stripe"]);
    const stripe = o.providers[1];
    expect(stripe.auth).toEqual({
      type: "bearer_static",
      credentials: [{ env: "STRIPE_KEY", set: true }],
    });
    expect(stripe.forwarding.mode).toBe("allowlist");
    expect(stripe.forwarding.allow).toHaveLength(1);
    expect(stripe.forwarding.deny).toEqual(["/v1/admin/**"]);
    expect(o.providers[0].auth.credentials).toEqual([
      { env: "HMAC_ID", set: true },
      { env: "HMAC_SECRET", set: true },
    ]);

    // Hosts: PSK shows as the env var name only.
    expect(o.hosts).toEqual([
      {
        id: "localhost",
        cidrs: ["127.0.0.1/32", "::1/128"],
        can_call_sensitive: true,
        description: "Loopback",
        psk_env: null,
      },
      {
        id: "lan-agent",
        cidrs: ["192.168.1.0/24"],
        can_call_sensitive: false,
        description: null,
        psk_env: "LAN_AGENT_TOKEN",
      },
    ]);

    // The viewer (127.0.0.1 here) resolved like a proxied request would be.
    expect(o.you).toEqual({
      ip: "127.0.0.1",
      host: "localhost",
      can_call_sensitive: true,
      psk_required: false,
    });
  });

  test("tells a viewer outside the policy that they are denied, and flags a PSK host", async () => {
    const denied = buildApp(await depsWith(new Map(), {}, "10.9.9.9"));
    expect((await overview(denied)).you).toEqual({
      ip: "10.9.9.9",
      host: null,
      can_call_sensitive: false,
      psk_required: false,
    });

    const lan = buildApp(await depsWith(new Map(), {}, "192.168.1.50"));
    expect((await overview(lan)).you).toMatchObject({
      host: "lan-agent",
      psk_required: true,
    });
  });

  test("reports config problems and marks the instance degraded", async () => {
    // A provider whose credential env var is unset fails to build.
    const broken = ProviderSchema.parse({
      name: "broken",
      base_url: "https://api.broken.example",
      auth: { type: "bearer_static", env: "NOT_SET_ANYWHERE" },
    });
    const deps = await depsWith(new Map([["broken", broken]]));
    deps.status!.config!.problems = [
      { scope: "provider", source: "bad.yaml", message: "YAML parse error" },
    ];
    deps.status!.disabledProviders = [{ name: "example", source: "example.yaml" }]; // prettier-ignore
    const o = await overview(buildApp(deps));

    expect(o.status).toBe("degraded");
    expect(o.providers).toEqual([]);
    expect(o.config.problems).toHaveLength(2);
    expect(o.config.problems[0]).toMatchObject({ scope: "provider", source: "broken" }); // prettier-ignore
    expect(o.config.problems[1]).toMatchObject({ source: "bad.yaml" });
    expect(o.disabled_providers).toEqual([{ name: "example", source: "example.yaml" }]); // prettier-ignore
  });

  test("storage failure degrades status but never throws", async () => {
    const deps = await depsWith(new Map());
    deps.status!.storage = async () => {
      throw new Error("ECONNREFUSED");
    };
    const o = await overview(buildApp(deps));
    expect(o.status).toBe("degraded");
    expect(o.storage).toEqual({ ok: false, detail: "ECONNREFUSED" });
  });

  test("works with no status source at all (bare buildApp callers)", async () => {
    const deps = await depsWith(new Map(), { status: undefined });
    const o = await overview(buildApp(deps));
    expect(o.version).toBe("dev");
    expect(o.runtime).toBe("unknown");
    expect(o.uptime_seconds).toBeNull();
    expect(o.storage).toBeNull();
    expect(o.config.problems).toEqual([]);
  });
});

describe("/dashboard", () => {
  test("serves a self-contained page that reads /api/overview", async () => {
    const app = buildApp(await depsWith(new Map()));
    for (const path of ["/dashboard", "/dashboard/"]) {
      const res = await app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("/api/overview");
      // No CDN: the page must render on an air-gapped NAS.
      expect(html).not.toMatch(/https?:\/\/[^"' ]*cdn/i);
    }
  });

  test("a bare GET / from a browser is sent to the dashboard", async () => {
    const app = buildApp(await depsWith(new Map()));
    const res = await app.request("/");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/dashboard");

    // An agent that names a provider still gets the proxy's own answer.
    const agent = await app.request("/", { headers: { "x-provider": "nope" } });
    expect(agent.status).toBe(400);
  });

  test("OUTPOST_DASHBOARD=false removes the page, the JSON and the redirect", async () => {
    const app = buildApp(await depsWith(new Map(), { dashboard: false }));
    expect((await app.request("/dashboard")).status).toBe(404);
    expect((await app.request("/api/overview")).status).toBe(404);
    expect((await app.request("/")).status).toBe(400);
    // The rest of the management surface is untouched.
    expect((await app.request("/healthz")).status).toBe(200);
  });
});

describe("swappable deps", () => {
  test("a reload is visible to the next request without rebuilding the app", async () => {
    let current = await depsWith(new Map());
    const app = buildApp(() => current);

    expect(await (await app.request("/healthz")).json()).toEqual({
      status: "ok",
      providers: [],
    });

    current = await depsWith(new Map([["stripe", STRIPE]]));
    expect(await (await app.request("/healthz")).json()).toEqual({
      status: "ok",
      providers: ["stripe"],
    });
    expect((await overview(app)).providers.map((p) => p.name)).toEqual([
      "stripe",
    ]);
  });
});
