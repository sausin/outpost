import { afterEach, describe, expect, test, vi } from "vitest";
import { PluginAuth } from "../../src/auth/modules/plugin.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";

function makeDeps(env: Record<string, string> = {}): AuthDeps {
  return {
    env: {
      DEFAULT_PROVIDER: "",
      PROVIDERS_DIR: "",
      HOSTS_CONFIG_PATH: "",
      PROXY_PORT: "",
      LOG_LEVEL: "",
      ...env,
    },
    tokenStorage: new InMemoryStorage(),
  };
}

function fakeCtx(): AuthContext {
  return {
    method: "GET",
    fullPath: "/v1/test",
    queryString: "",
    body: null,
    headers: new Headers(),
  };
}

describe("PluginAuth (static registry)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads GrowwTotpMintAuth and delegates apply()", async () => {
    // GrowwTotpMintAuth is in the static PLUGIN_REGISTRY.
    // Prime the storage so getOrMint() returns the cached token directly.
    const storage = new InMemoryStorage();
    await storage.set("groww:token", "cached_groww_token");

    const deps: AuthDeps = {
      env: {
        DEFAULT_PROVIDER: "",
        PROVIDERS_DIR: "",
        HOSTS_CONFIG_PATH: "",
        PROXY_PORT: "",
        LOG_LEVEL: "",
        GROWW_API_KEY: "gk_test",
        GROWW_TOTP_SEED: "JBSWY3DPEHPK3PXP",
      },
      tokenStorage: storage,
    };

    const auth = await PluginAuth.fromConfig(
      {
        module_ts: "plugins/groww_totp_mint.ts:GrowwTotpMintAuth",
        config: {},
      },
      deps,
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer cached_groww_token");
  });

  test("falls back to `module` when `module_ts` is missing", async () => {
    // Some YAMLs only carry `module:` (Python-only deployments). The TS
    // runtime should still try that key against the registry.
    const storage = new InMemoryStorage();
    await storage.set("groww:token", "via_module_key");

    const auth = await PluginAuth.fromConfig(
      {
        module: "plugins/groww_approval_mint.ts:GrowwApprovalMintAuth",
        config: {},
      },
      {
        env: {
          DEFAULT_PROVIDER: "",
          PROVIDERS_DIR: "",
          HOSTS_CONFIG_PATH: "",
          PROXY_PORT: "",
          LOG_LEVEL: "",
          GROWW_API_KEY: "gk_test",
          GROWW_API_SECRET: "gs_test",
        },
        tokenStorage: storage,
      },
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer via_module_key");
  });

  test("unknown registry key lists the registered plugins", async () => {
    await expect(
      PluginAuth.fromConfig(
        { module_ts: "plugins/does_not_exist.ts:Anything" },
        makeDeps(),
      ),
    ).rejects.toThrow(/unknown plugin.*Registered plugins.*groww_/);
  });

  test("missing module key rejects with a clear error", async () => {
    await expect(
      PluginAuth.fromConfig({ config: {} }, makeDeps()),
    ).rejects.toThrow(/'module' \(or 'module_ts'\)/);
  });

  test("malformed module key (no colon) rejects with a clear error", async () => {
    await expect(
      PluginAuth.fromConfig({ module_ts: "no-colon-here" }, makeDeps()),
    ).rejects.toThrow(/'module' \(or 'module_ts'\)/);
  });
});
