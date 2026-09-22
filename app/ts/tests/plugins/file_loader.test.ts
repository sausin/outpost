import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { PluginAuth } from "../../src/auth/modules/plugin.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import { buildAppDeps } from "../../src/bootstrap.ts";
import type { AuthContext } from "../../src/core/types.ts";
import { envFromWorkers } from "../../src/core/env.ts";
import {
  makeFilePluginLoader,
  parsePluginSpec,
  resolvePluginPath,
} from "../../src/plugins/file_loader.ts";
import { ProviderSchema } from "../../src/providers/schema.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";

/**
 * A complete runtime plugin, as an operator would write it: plain ESM, no
 * imports from Outpost, a class with a static fromConfig(config, deps).
 */
const SIGNED_HEADER_PLUGIN = `
export class SignedHeaderAuth {
  static typeName = "signed_header";
  constructor(secret, header) { this.secret = secret; this.header = header; }
  static fromConfig(config, deps) {
    const secret = deps.env[config.secret_env];
    if (!secret) throw new Error("env var " + config.secret_env + " is not set");
    return new SignedHeaderAuth(secret, config.header ?? "X-Signature");
  }
  async apply(ctx) {
    return { headers: { [this.header]: this.secret + ":" + ctx.method + ":" + ctx.fullPath } };
  }
  async invalidate() {}
  isRejection(status) { return status === 401; }
}
export const notAModule = 42;
export const noFromConfig = class {};
export const badFactory = { fromConfig: () => ({ apply: async () => ({}) }) };
`;

let root: string;
let pluginsDir: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "outpost-plugins-"));
  pluginsDir = path.join(root, "plugins");
  await mkdir(pluginsDir);
  await writeFile(path.join(pluginsDir, "signed.mjs"), SIGNED_HEADER_PLUGIN);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function deps(env: Record<string, string> = {}): AuthDeps {
  return {
    env: envFromWorkers({ MY_SECRET: "s3cr3t", ...env }),
    tokenStorage: new InMemoryStorage(),
    loadPlugin: makeFilePluginLoader({ dir: pluginsDir }),
  };
}

function ctx(): AuthContext {
  return {
    method: "GET",
    fullPath: "/v1/things",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

describe("parsePluginSpec", () => {
  test("splits on the last colon", () => {
    expect(parsePluginSpec("sub/dir/x.mjs:MyAuth")).toEqual({
      file: "sub/dir/x.mjs",
      exportName: "MyAuth",
    });
  });

  test.each(["no-colon", ":Auth", "x.mjs:"])("rejects %j", (spec) => {
    expect(() => parsePluginSpec(spec)).toThrow(/'<file>:<ExportName>'/);
  });
});

describe("resolvePluginPath", () => {
  test("resolves inside the plugins directory, subdirectories included", () => {
    expect(resolvePluginPath("/config/plugins", "a/b.mjs")).toBe(
      path.resolve("/config/plugins/a/b.mjs"),
    );
  });

  test("refuses paths that escape the directory", () => {
    expect(() => resolvePluginPath("/config/plugins", "../hosts.yaml")).toThrow(
      /escapes the plugins directory/,
    );
    expect(() => resolvePluginPath("/config/plugins", "a/../../x.mjs")).toThrow(
      /escapes the plugins directory/,
    );
  });

  test("refuses absolute paths", () => {
    expect(() => resolvePluginPath("/config/plugins", "/etc/x.mjs")).toThrow(
      /must be relative/,
    );
  });

  test("refuses the directory itself and non-code extensions", () => {
    expect(() => resolvePluginPath("/config/plugins", ".")).toThrow(/escapes/);
    expect(() => resolvePluginPath("/config/plugins", "x.yaml")).toThrow(
      /must end in \.js, \.mjs, \.cjs, \.ts/,
    );
  });
});

describe("PluginAuth with the file loader (Node)", () => {
  test("imports a plugin from the plugins directory and delegates to it", async () => {
    const auth = await PluginAuth.fromConfig(
      {
        module_ts: "signed.mjs:SignedHeaderAuth",
        config: { secret_env: "MY_SECRET", header: "X-Sig" },
      },
      deps(),
    );
    const result = await auth.apply(ctx());
    expect(result.headers?.["X-Sig"]).toBe("s3cr3t:GET:/v1/things");
    expect(auth.isRejection(401, null)).toBe(true);
    expect(auth.isRejection(500, null)).toBe(false);
  });

  test("the bundled registry still wins for its own keys", async () => {
    const storage = new InMemoryStorage();
    await storage.set("groww:token", "from_registry");
    const auth = await PluginAuth.fromConfig(
      { module_ts: "plugins/groww_totp_mint.ts:GrowwTotpMintAuth", config: {} },
      {
        ...deps({ GROWW_API_KEY: "k", GROWW_TOTP_SEED: "JBSWY3DPEHPK3PXP" }),
        tokenStorage: storage,
      },
    );
    const result = await auth.apply(ctx());
    expect(result.headers?.["Authorization"]).toBe("Bearer from_registry");
  });

  test("a plugin's own fromConfig error is reported as such", async () => {
    await expect(
      PluginAuth.fromConfig(
        {
          module_ts: "signed.mjs:SignedHeaderAuth",
          config: { secret_env: "UNSET_VAR" },
        },
        deps(),
      ),
    ).rejects.toThrow(/fromConfig\(\) failed: .*UNSET_VAR is not set/);
  });

  test("picks up an edited plugin on the next load instead of the cached module", async () => {
    const file = path.join(pluginsDir, "signed.mjs");
    const first = await PluginAuth.fromConfig(
      {
        module_ts: "signed.mjs:SignedHeaderAuth",
        config: { secret_env: "MY_SECRET" },
      },
      deps(),
    );
    expect((await first.apply(ctx())).headers?.["X-Signature"]).toBe(
      "s3cr3t:GET:/v1/things",
    );

    await writeFile(
      file,
      SIGNED_HEADER_PLUGIN.replace('":" + ctx.method', '"#" + ctx.method'),
    );
    // Make sure the mtime moves even on a coarse-grained filesystem.
    const later = new Date(Date.now() + 5_000);
    await utimes(file, later, later);

    const second = await PluginAuth.fromConfig(
      {
        module_ts: "signed.mjs:SignedHeaderAuth",
        config: { secret_env: "MY_SECRET" },
      },
      deps(),
    );
    expect((await second.apply(ctx())).headers?.["X-Signature"]).toBe(
      "s3cr3t#GET:/v1/things",
    );
  });

  test.each([
    [
      "missing file",
      "nope.mjs:X",
      /nope\.mjs not found in the plugins directory/,
    ],
    [
      "missing export",
      "signed.mjs:Nope",
      /export 'Nope' of plugin file signed\.mjs is not an auth module.*the file exports: SignedHeaderAuth, badFactory, noFromConfig, notAModule/,
    ],
    ["export is not a class", "signed.mjs:notAModule", /is not an auth module/],
    [
      "class without fromConfig",
      "signed.mjs:noFromConfig",
      /static fromConfig\(config, deps\)/,
    ],
    [
      "path traversal",
      "../signed.mjs:SignedHeaderAuth",
      /escapes the plugins directory/,
    ],
    [
      "Python-style dotted module",
      "my_pkg.my_mod:MyAuth",
      /must end in \.js, \.mjs, \.cjs, \.ts/,
    ],
  ])("%s → clear PluginAuth error", async (_name, spec, pattern) => {
    await expect(
      PluginAuth.fromConfig({ module_ts: spec, config: {} }, deps()),
    ).rejects.toThrow(pattern);
    await expect(
      PluginAuth.fromConfig({ module_ts: spec, config: {} }, deps()),
    ).rejects.toThrow(/^PluginAuth: /);
  });

  test("fromConfig() returning something that is not an auth module is rejected", async () => {
    await expect(
      PluginAuth.fromConfig({ module_ts: "signed.mjs:badFactory" }, deps()),
    ).rejects.toThrow(/returned an object without invalidate\(\)/);
  });

  test("a file that fails to import names the file and the reason", async () => {
    await writeFile(path.join(pluginsDir, "broken.mjs"), "export const x = ;");
    await expect(
      PluginAuth.fromConfig({ module_ts: "broken.mjs:x" }, deps()),
    ).rejects.toThrow(/plugin file broken\.mjs failed to import/);
  });

  test("without a loader (Workers) an unknown key still lists the bundled plugins", async () => {
    const noLoader: AuthDeps = { ...deps(), loadPlugin: undefined };
    await expect(
      PluginAuth.fromConfig(
        { module_ts: "signed.mjs:SignedHeaderAuth" },
        noLoader,
      ),
    ).rejects.toThrow(
      /unknown plugin 'signed\.mjs:SignedHeaderAuth'.*Registered plugins: plugins\/groww_/,
    );
  });
});

describe("buildAppDeps with a file plugin", () => {
  const noopCache = { get: async () => null, put: async () => {} };
  const noopRateLimits = {
    acquire: async () => {},
    noteUpstream429: async () => {},
    cooldownRemainingMs: async () => 0,
  };

  test("a provider whose auth is a file plugin builds and signs requests", async () => {
    const def = ProviderSchema.parse({
      name: "acme",
      base_url: "https://api.acme.test",
      auth: {
        type: "plugin",
        module_ts: "signed.mjs:SignedHeaderAuth",
        config: { secret_env: "MY_SECRET" },
      },
    });
    const built = await buildAppDeps({
      env: envFromWorkers({ MY_SECRET: "s3cr3t" }),
      defs: new Map([["acme", def]]),
      hostsYaml: "hosts: []",
      tokenStorage: new InMemoryStorage(),
      cache: noopCache,
      rateLimits: noopRateLimits,
      loadPlugin: makeFilePluginLoader({ dir: pluginsDir }),
    });
    expect(built.problems).toEqual([]);
    const provider = built.providers.get("acme")!;
    const result = await provider.auth.apply(ctx());
    expect(result.headers?.["X-Signature"]).toBe("s3cr3t:GET:/v1/things");
  });

  test("a broken file plugin disables that provider only and is reported", async () => {
    const good = ProviderSchema.parse({
      name: "stripe",
      base_url: "https://api.stripe.com",
      auth: { type: "bearer_static", env: "STRIPE_KEY" },
    });
    const bad = ProviderSchema.parse({
      name: "acme",
      base_url: "https://api.acme.test",
      auth: { type: "plugin", module_ts: "missing.mjs:X" },
    });
    const built = await buildAppDeps({
      env: envFromWorkers({ STRIPE_KEY: "sk" }),
      defs: new Map([
        ["stripe", good],
        ["acme", bad],
      ]),
      hostsYaml: "hosts: []",
      tokenStorage: new InMemoryStorage(),
      cache: noopCache,
      rateLimits: noopRateLimits,
      loadPlugin: makeFilePluginLoader({ dir: pluginsDir }),
    });
    expect([...built.providers.keys()]).toEqual(["stripe"]);
    expect(built.problems).toHaveLength(1);
    expect(built.problems[0]).toMatchObject({
      scope: "provider",
      source: "acme",
    });
    expect(built.problems[0]!.message).toMatch(
      /missing\.mjs not found in the plugins directory/,
    );
  });
});
