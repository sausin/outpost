import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginAuth } from "../../src/auth/modules/plugin.ts";
import { InMemoryStorage } from "../helpers/in_memory_storage.ts";
import type { AuthDeps } from "../../src/auth/types.ts";
import type { AuthContext } from "../../src/core/types.ts";

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

describe("PluginAuth", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("loads GrowwTotpMintAuth and delegates apply()", async () => {
    // GrowwTotpMintAuth is a real plugin in src/plugins/.
    // We mock fetch so it doesn't actually call the network, and
    // prime the storage so getOrMint() returns the cached token directly.
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
        module: "plugins/groww_totp_mint.ts:GrowwTotpMintAuth",
        config: {},
      },
      deps,
    );
    const result = await auth.apply(fakeCtx());
    expect(result.headers?.["Authorization"]).toBe("Bearer cached_groww_token");
  });

  test("rejects paths starting with ../", async () => {
    await expect(
      PluginAuth.fromConfig(
        { module: "../../../etc/passwd:Something" },
        makeDeps(),
      ),
    ).rejects.toThrow(/not allowed/);
  });

  test("rejects module paths that do not start with plugins/", async () => {
    await expect(
      PluginAuth.fromConfig(
        { module: "auth/modules/none.ts:NoneAuth" },
        makeDeps(),
      ),
    ).rejects.toThrow(/must start with 'plugins\//);
  });

  test("throws clear error on unknown class in a valid module", async () => {
    await expect(
      PluginAuth.fromConfig(
        { module: "plugins/groww_totp_mint.ts:NonExistentClass" },
        makeDeps({
          GROWW_API_KEY: "k",
          GROWW_TOTP_SEED: "JBSWY3DPEHPK3PXP",
        }),
      ),
    ).rejects.toThrow(/NonExistentClass.*not found/);
  });
});
