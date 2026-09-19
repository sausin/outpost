import { describe, test, expect } from "vitest";

import { buildAppDeps } from "../../src/bootstrap.ts";
import { envFromWorkers } from "../../src/core/env.ts";
import { buildApp } from "../../src/index.ts";
import { ProviderSchema } from "../../src/providers/schema.ts";
import type { ProviderDef } from "../../src/providers/schema.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { CacheBackend, RateLimitBackend } from "../../src/storage/interface.ts"; // prettier-ignore

const noopCache: CacheBackend = {
  get: async () => null,
  put: async () => {},
};

const noopRateLimits: RateLimitBackend = {
  check: async () => {},
};

async function appWith(defs: Map<string, ProviderDef>) {
  const deps = await buildAppDeps({
    env: envFromWorkers({ STRIPE_KEY: "sk_test" }),
    defs,
    hostsYaml: "hosts: []",
    tokenStorage: new InMemoryStorage(),
    cache: noopCache,
    rateLimits: noopRateLimits,
  });
  return buildApp(deps);
}

const STRIPE = ProviderSchema.parse({
  name: "stripe",
  base_url: "https://api.stripe.com",
  auth: { type: "bearer_static", env: "STRIPE_KEY" },
});

describe("management routes", () => {
  test("/healthz is 200 with zero providers configured", async () => {
    // The freshly-installed case: no credentials, no provider YAMLs. An app
    // catalog marks the deploy failed if this ever reports unhealthy.
    const app = await appWith(new Map());
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", providers: [] });
  });

  test("/healthz lists loaded providers", async () => {
    const app = await appWith(new Map([["stripe", STRIPE]]));
    const res = await app.request("/healthz");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", providers: ["stripe"] });
  });

  test("/openapi.json serves a spec covering the management + proxy routes", async () => {
    const app = await appWith(new Map());
    const res = await app.request("/openapi.json");

    expect(res.status).toBe(200);
    const spec = (await res.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
    };
    expect(spec.openapi).toBe("3.1.0");
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/docs",
      "/healthz",
      "/openapi.json",
      "/providers",
      "/{path}",
    ]);
  });

  test("/openapi.json reflects the loaded providers as an X-Provider enum", async () => {
    const app = await appWith(new Map([["stripe", STRIPE]]));
    const spec = (await (await app.request("/openapi.json")).json()) as {
      components: {
        parameters: { XProvider: { schema: { enum?: string[] } } };
      };
    };
    expect(spec.components.parameters.XProvider.schema.enum).toEqual(["stripe"]); // prettier-ignore
  });

  test("/docs serves the Swagger UI page", async () => {
    const app = await appWith(new Map());
    const res = await app.request("/docs");

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("swagger-ui");
    expect(body).toContain("openapi.json");
  });

  test("management routes are served without a host policy match", async () => {
    // hosts.yaml is empty above, so the catch-all proxy would 403 — the
    // management routes must be reachable regardless, or the healthcheck
    // could never pass on a locked-down install.
    const app = await appWith(new Map());
    expect((await app.request("/providers")).status).toBe(200);
    expect((await app.request("/v1/anything")).status).toBe(400);
  });
});
